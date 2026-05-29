// Standalone background worker for auto-dreaming.
// Spawned by auto-fragment worker when fragment threshold is met.
// Runs decay (with constitutional protection) + distillation.

import { openDb, getDb } from "../../db/connection.js";
import * as fs from "node:fs";
import { cosineSimilarity } from "../../core/embedder.js";
import { loadSettingsEnv } from "./settings.js";
import { injectCareMessage, injectAlerts } from "../../core/active-context.js";
import { consumeLightweightSignals } from "../../core/dreaming-trigger.js";
import { noveltyFactor, calcSystemAgeDays } from "../../core/decay.js";
import type { MemoryEngine } from "../engine.js";

async function main() {
  const args = process.argv.slice(2);
  const projectId = args.find(a => a.startsWith("--project="))?.split("=")[1] || "claude-auto-memory";
  const thresholdStr = args.find(a => a.startsWith("--threshold="))?.split("=")[1] || "100";
  const threshold = parseInt(thresholdStr, 10);
  const forceMode = args.includes("--force");

  openDb();
  const db = getDb();

  // Check how many new fragments since last dreaming
  const project = db.prepare("SELECT last_dreaming_at FROM projects WHERE id = ?").get(projectId) as { last_dreaming_at: number | null } | undefined;
  const lastDreamingAt = project?.last_dreaming_at ?? 0;

  const newFragments = db.prepare(
    "SELECT COUNT(*) as cnt FROM fragments WHERE project_id = ? AND created_at > ? AND retrieval_state IN ('active','warm') AND asset_state != 'user_deleted'"
  ).get(projectId, lastDreamingAt) as { cnt: number };

  if (!forceMode && newFragments.cnt < threshold) {
    // Below threshold — nothing to do
    process.exit(0);
  }

  // Load settings & init engine
  const settingsEnv = loadSettingsEnv();
  const apiKey = settingsEnv.AGENTMEMORY_API_KEY || "";
  const fragmentationKey = settingsEnv.DEEPSEEK_API_KEY || settingsEnv.ANTHROPIC_AUTH_TOKEN || apiKey;
  const embeddingBaseURL = settingsEnv.AGENTMEMORY_EMBEDDING_URL || "https://api.minimax.chat";

  if (!fragmentationKey || fragmentationKey.length <= 10 || fragmentationKey === "test-key") {
    process.exit(0);
  }

  let engine: MemoryEngine | null = null;
  try {
    const { MemoryEngine } = await import("../engine.js");
    engine = new MemoryEngine({
      apiKey,
      fragmentationKey,
      fragmentationBaseURL: settingsEnv.DEEPSEEK_BASE_URL
        || (settingsEnv.DEEPSEEK_API_KEY ? "https://api.deepseek.com" : "https://api.minimax.chat"),
      baseURL: embeddingBaseURL,
    });
  } catch (e) {
    console.error(`[AgentMemory] dreaming worker: engine init failed:`, (e as Error).message?.slice(0, 80));
    process.exit(1);
  }

  // Step 1: Decay with constitutional protection
  let stats = { warmed: 0, archived: 0, cooled: 0 };
  try {
    stats = engine.runDecay({ protectConstitutional: true, projectId });
    console.error(`[AgentMemory] dreaming: decay done — ${stats.archived} archived, ${stats.cooled} cooled`);
  } catch (e) {
    console.error(`[AgentMemory] dreaming: decay failed:`, (e as Error).message?.slice(0, 80));
  }

  // Step 2: Distillation — cluster similar labels, merge ≥3 into L0 rules
  let distilled = 0;
  try {
    distilled = engine.runDistillation(projectId);
    console.error(`[AgentMemory] dreaming: distillation done — ${distilled} rules`);
  } catch (e) {
    console.error(`[AgentMemory] dreaming: distillation failed:`, (e as Error).message?.slice(0, 80));
  }

  // Step 2.5: Auto-alias detection — map abandoned terminology to current canonical terms
  const NOW = Date.now();
  const ALIAS_SIM_THRESHOLD = 0.85;

  // Novelty-adjusted: mature 30d/7d → brand-new ~3d/~1d
  const firstRow2 = db.prepare(
    "SELECT MIN(created_at) as first FROM fragments WHERE project_id = ?"
  ).get(projectId) as { first: number | null } | undefined;
  const nfAlias = noveltyFactor(calcSystemAgeDays(firstRow2?.first ?? null));
  const THIRTY_DAYS = (30 * 24 * 60 * 60 * 1000) * (1 - nfAlias * 0.9);
  const SEVEN_DAYS = (7 * 24 * 60 * 60 * 1000) * (1 - nfAlias * 0.85);

  const abandonedFrags = db.prepare(`
    SELECT id, summary, vector FROM fragments
    WHERE project_id = ? AND retrieval_state IN ('active','warm') AND asset_state != 'user_deleted'
      AND recalled_count < 2 AND created_at < ?
      AND vector IS NOT NULL
    LIMIT 20
  `).all(projectId, NOW - THIRTY_DAYS) as Array<{ id: string; summary: string; vector: Buffer }>;

  const recentFrags = db.prepare(`
    SELECT id, summary, vector FROM fragments
    WHERE project_id = ? AND retrieval_state IN ('active','warm') AND asset_state != 'user_deleted'
      AND created_at > ?
      AND vector IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 50
  `).all(projectId, NOW - SEVEN_DAYS) as Array<{ id: string; summary: string; vector: Buffer }>;

  let autoAliasCount = 0;
  if (abandonedFrags.length > 0 && recentFrags.length > 0) {
    try {
      for (const aFrag of abandonedFrags) {
        if (autoAliasCount >= 5) break;
        if (!aFrag.vector || aFrag.vector.length < 4) continue;
        const aVec = Array.from(new Float32Array(aFrag.vector.buffer, aFrag.vector.byteOffset, aFrag.vector.length / 4));

        for (const rFrag of recentFrags) {
          if (!rFrag.vector || rFrag.vector.length < 4) continue;
          const rVec = Array.from(new Float32Array(rFrag.vector.buffer, rFrag.vector.byteOffset, rFrag.vector.length / 4));
          const sim = cosineSimilarity(aVec, rVec);

          if (sim > ALIAS_SIM_THRESHOLD) {
            const getBigrams = (s: string) => {
              const set = new Set<string>();
              for (let i = 0; i < s.length - 1; i++) {
                const bg = s.slice(i, i + 2);
                if (/[一-鿿]/.test(bg[0]!) && /[一-鿿]/.test(bg[1]!)) set.add(bg);
              }
              const toks = s.match(/[a-zA-Z0-9_]{2,}/g) || [];
              for (const t of toks) set.add(t.toLowerCase());
              return set;
            };

            const aBigrams = getBigrams(aFrag.summary);
            const rBigrams = getBigrams(rFrag.summary);

            const aOnly = [...aBigrams].filter(b => !rBigrams.has(b));
            const rOnly = [...rBigrams].filter(b => !aBigrams.has(b));

            if (aOnly.length > 0 && rOnly.length > 0) {
              const aliasTerm = aOnly[0]!;
              const canonicalTerm = rOnly[0]!;
              const exists = db.prepare(
                "SELECT id FROM aliases WHERE project_id = ? AND canonical = ? AND alias = ?"
              ).get(projectId, canonicalTerm, aliasTerm);
              if (!exists) {
                db.prepare(`
                  INSERT OR IGNORE INTO aliases (id, project_id, canonical, alias, source, confidence, created_at)
                  VALUES (?, ?, ?, ?, 'auto', 0.7, ?)
                `).run(
                  `alias-auto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                  projectId, canonicalTerm, aliasTerm, NOW
                );
                autoAliasCount++;
              }
            }
            break;
          }
        }
      }
      if (autoAliasCount > 0) {
        console.error(`[AgentMemory] 自动发现 ${autoAliasCount} 个术语别名`);
      }
    } catch (e) {
      console.error(`[AgentMemory] dreaming: auto-alias failed:`, (e as Error).message?.slice(0, 80));
    }
  }

  // Step 3: Decision criteria distillation — ≥3 same subject→target patterns → extract criteria
  const criteriaRows = db.prepare(`
    SELECT subject, target, COUNT(*) as cnt
    FROM decision_criteria WHERE project_id = ? AND source = 'auto'
    GROUP BY subject, target HAVING cnt >= 3
  `).all(projectId) as Array<{ subject: string; target: string; cnt: number }>;

  for (const cr of criteriaRows) {
    // Check if distilled criteria already exists
    const existing = db.prepare(
      "SELECT id FROM decision_criteria WHERE project_id = ? AND subject = ? AND target = ? AND source = 'distilled'"
    ).get(projectId, cr.subject, cr.target);
    if (!existing) {
      // Extract discriminating dimension via LLM
      let criteriaType = "pattern";
      let criteriaValue = `${cr.cnt}次重复模式`;

      try {
        const samples = db.prepare(`
          SELECT DISTINCT subject FROM decision_criteria
          WHERE project_id = ? AND target = ? AND subject != ? AND source = 'auto'
          LIMIT 3
        `).all(projectId, cr.target, cr.subject) as Array<{ subject: string }>;

        if (samples.length > 0) {
          const prompt = `分析以下决策模式并提取判据：
相同目标：${cr.target}
同类主体：${cr.subject}${samples.map(s => '、' + s.subject).join('')}

这些主体有什么共同特征（判据维度）？用一句话回答，格式：
维度类型: 具体特征值

例子：产品类型: 标品日用品`;
          const { output: criteriaOutput } = await (engine as any).callFragmenter({
            transcript: prompt, sessionId: `criteria-${Date.now()}`, projectId,
          });
          if (criteriaOutput.summary) {
            const parts = criteriaOutput.summary.split(/[:：]/, 2);
            if (parts.length === 2 && parts[0] && parts[1]) {
              criteriaType = parts[0].trim();
              criteriaValue = parts[1].trim().slice(0, 50);
            }
          }
        }
      } catch {}

      db.prepare(`
        INSERT INTO decision_criteria (id, project_id, subject, target, criteria_type, criteria_value, confidence, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 0.85, 'distilled', ?)
      `).run(
        `dc-distilled-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        projectId, cr.subject, cr.target, criteriaType, criteriaValue, Date.now()
      );
    }
  }

  // Step 3.5: Relationship profile maintenance — decay signals + re-evaluate trust
  let relationshipChanged = false;
  try {
    engine.decayRelationshipSignals(projectId);
    const trustResult = engine.evaluateTrustLevel(projectId);
    if (trustResult.changed) {
      relationshipChanged = true;
      console.error(`[AgentMemory] dreaming: trust level ${trustResult.oldLevel} → ${trustResult.newLevel}`);
    }
  } catch (e) {
    console.error(`[AgentMemory] dreaming: relationship profile failed:`, (e as Error).message?.slice(0, 80));
  }

  // ── P0 Active Cycle ───────────────────────────────

  // Step 3.1: Contradiction Detection
  let contradictionCount = 0;
  try {
    const contradictions = await engine.detectContradictions(projectId);
    if (contradictions.length > 0) {
      for (const c of contradictions.slice(0, 10)) {
        db.prepare(`
          INSERT INTO memory_repair_jobs (id, project_id, job_type, trigger, fragments_affected, action_taken, created_at)
          VALUES (?, ?, 'contradiction_detect', ?, ?, ?, ?)
        `).run(
          `cr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          projectId,
          `contradiction: ${c.fragmentA.feelLabel} vs ${c.fragmentB.feelLabel} (sim=${c.similarity})`,
          JSON.stringify([c.fragmentA.id, c.fragmentB.id]),
          `${c.riskLevel} risk: ${c.sharedTopics.slice(0, 3).join(", ")}`,
          Date.now(),
        );
      }
      contradictionCount = contradictions.length;
      console.error(`[AgentMemory] P0 矛盾检测: ${contradictions.length} 个潜在冲突 (${contradictions.filter(c => c.riskLevel === "high").length} 高风险)`);
    }
  } catch (e) {
    console.error(`[AgentMemory] P0 矛盾检测失败:`, (e as Error).message?.slice(0, 80));
  }

  // Step 3.2: Pattern Insight
  let patternCount = 0;
  try {
    const patterns = engine.detectPatterns(projectId);
    if (patterns.topClusters.length > 0) {
      db.prepare(`
        INSERT INTO memory_repair_jobs (id, project_id, job_type, trigger, fragments_affected, action_taken, created_at)
        VALUES (?, ?, 'pattern_insight', ?, ?, ?, ?)
      `).run(
        `pi-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        projectId,
        `pattern: top clusters + trends`,
        "[]",
        JSON.stringify({ topClusters: patterns.topClusters.slice(0, 5), risingTrends: patterns.risingTrends, channelShift: patterns.channelShift }),
        Date.now(),
      );
      patternCount = patterns.topClusters.length;
    }
    if (patterns.risingTrends.length > 0) {
      console.error(`[AgentMemory] P0 模式洞察: ${patterns.risingTrends.length} 个上升趋势`);
    }
  } catch (e) {
    console.error(`[AgentMemory] P0 模式洞察失败:`, (e as Error).message?.slice(0, 80));
  }

  // Step 3.3: Memory Self-Check
  let alertCount = 0;
  try {
    const health = engine.runSelfCheck(projectId);
    if (health.alerts.length > 0) {
      injectAlerts(projectId, health.alerts);
      alertCount = health.alerts.length;
      console.error(`[AgentMemory] P0 自检: ${health.alerts.map(a => a.message).join("; ")}`);
    }
  } catch (e) {
    console.error(`[AgentMemory] P0 自检失败:`, (e as Error).message?.slice(0, 80));
  }

  // Step 3.4: Proactive Care
  let careMessage = "";
  try {
    const care = engine.generateProactiveCare(projectId);
    if (care) {
      injectCareMessage(projectId, care);
      careMessage = care.message;
      db.prepare(`
        INSERT INTO memory_repair_jobs (id, project_id, job_type, trigger, fragments_affected, action_taken, created_at)
        VALUES (?, ?, 'proactive_care', ?, ?, ?, ?)
      `).run(
        `care-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        projectId,
        `care: ${care.level}`,
        "[]",
        JSON.stringify(care),
        Date.now(),
      );
      console.error(`[AgentMemory] P0 关怀: ${care.message}`);
    }
  } catch (e) {
    console.error(`[AgentMemory] P0 关怀失败:`, (e as Error).message?.slice(0, 80));
  }

  // Mark lightweight signals as consumed and update timestamp.
  // Only update if all steps succeeded — wrapped in try-catch for safety.
  try {
    const consumed = consumeLightweightSignals(projectId);
    if (consumed > 0) console.error(`[AgentMemory] dreaming: 标记 ${consumed} 条轻量信号为已处理`);

    // Cleanup old consumed signals (30+ days)
    const cleaned = db.prepare(
      "DELETE FROM lightweight_signals WHERE consumed = 1 AND created_at < ?"
    ).run(Date.now() - 30 * 24 * 60 * 60 * 1000);
    if (cleaned.changes > 0) console.error(`[AgentMemory] dreaming: 清理 ${cleaned.changes} 条旧轻量信号`);

    // Step 4: Update last dreaming timestamp
    db.prepare("UPDATE projects SET last_dreaming_at = ? WHERE id = ?").run(Date.now(), projectId);
  } catch (e) {
    console.error(`[AgentMemory] dreaming: consume/cleanup failed, signals preserved:`, (e as Error).message?.slice(0, 80));
  }

  const parts: string[] = [];
  if (stats.archived + stats.cooled > 0) parts.push(`清理 ${stats.archived + stats.cooled} 条过期记忆`);
  if (distilled > 0) parts.push(`蒸馏 ${distilled} 条 L0 规则`);
  if (criteriaRows.length > 0) parts.push(`蒸馏 ${criteriaRows.length} 条决策判据`);
  if (relationshipChanged) parts.push("关系档案已更新");
  if (contradictionCount > 0) parts.push(`发现 ${contradictionCount} 个潜在矛盾`);
  if (patternCount > 0) parts.push(`洞察 ${patternCount} 个主题簇`);
  if (alertCount > 0) parts.push(`${alertCount} 项自检告警`);
  if (careMessage) parts.push("已生成关怀提醒");
  if (parts.length === 0) parts.push("记忆库状态良好");
  console.error(`[AgentMemory] 后台 Dreaming 完成: ${parts.join("，")}。`);
}

main().catch((e: unknown) => { console.error("[AgentMemory] hook failed:", (e as Error).message?.slice(0, 120)); process.exit(1); });
