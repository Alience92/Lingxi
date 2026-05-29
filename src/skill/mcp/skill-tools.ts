import type { MemoryEngine } from "../engine.js";
import { explicitSearch, buildMemoryEvent } from "../../core/retriever.js";
import { fourLayerRecall } from "../../core/backup-recall.js";
import { getDb } from "../../db/connection.js";
import { buildFragmentationPrompt, parseFragmentationResponse, resolveLinks } from "../../core/fragmenter.js";
import { getMemoryHealth } from "../../core/health.js";
import { scanExistingMemoryFiles, buildInstallMessage, injectAgentsMdAppendix } from "./install.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { v4 as uuid } from "uuid";

function promptModeResult(params: { transcript: string; sessionId: string; projectId: string }) {
  const prompt = buildFragmentationPrompt(params.transcript);
  return {
    mode: "prompt",
    prompt,
    transcript: params.transcript,
    sessionId: params.sessionId,
    projectId: params.projectId,
    instructions: "用你的LLM处理以上prompt和transcript，得到JSON数组后调用memory_store(fragments, sessionId, projectId)保存。fragments是channel/label/weight/linkedTo/summary的JSON数组。",
  };
}

function hasApiKey(engine: MemoryEngine): boolean {
  return !!(engine as any).config?.apiKey && (engine as any).config?.apiKey.length > 10;
}

export function buildToolHandlers(engine: MemoryEngine) {
  return {
    async memory_recall(params: { query?: string; projectId: string; workspaceDir: string }) {
      if (params.query) {
        return await explicitSearch(params.query, params.projectId);
      }
      const db = getDb();
      const fragments = db.prepare(`
        SELECT * FROM fragments WHERE project_id = ? AND retrieval_state IN ('active','warm') AND asset_state != 'user_deleted'
        ORDER BY created_at DESC LIMIT 10
      `).all(params.projectId) as Array<{ id: string; decay_score: number; recalled_count: number; last_recalled_at: number | null }>;

      // Bump recall counters so dreaming doesn't treat these as stale
      const now = Date.now();
      const bump = db.prepare(`
        UPDATE fragments SET last_recalled_at = ?, recalled_count = recalled_count + 1, decay_score = 1.0 WHERE id = ?
      `);
      for (const f of fragments) {
        bump.run(now, f.id);
      }

      return fragments;
    },

    async memory_remember(params: { transcript: string; sessionId: string; projectId: string }) {
      // If no fragmentation-capable API key, return prompt for Agent's LLM
      if (!engine.canFragment()) {
        return promptModeResult(params);
      }
      // Server-side fragmentation
      try {
        const fragments = await engine.fragmentSession({
          transcript: params.transcript,
          sessionId: params.sessionId,
          projectId: params.projectId,
        });
        if (fragments.length === 0) return promptModeResult(params);
        engine.updateActiveContext(params.projectId);
        return { mode: "server", count: fragments.length, fragments: fragments.map((f) => ({ id: f.id, summary: f.summary })) };
      } catch {
        return promptModeResult(params);
      }
    },

    async memory_store(params: { fragments: Array<{ channel: string; label: string; weight?: number; linkedTo?: number[]; summary: string }>; sessionId: string; projectId: string }) {
      const { parseFragmentationResponse, resolveLinks } = await import("../../core/fragmenter.js");
      const { persistFragments } = await import("../../db/repository.js");

      const rawJson = JSON.stringify(params.fragments);
      const output = parseFragmentationResponse(rawJson, params.sessionId, params.projectId);
      if (output.fragments.length === 0) return { stored: 0, error: "No valid fragments parsed" };

      const rawFragments = params.fragments.map((f: any) => ({
        channel: f.channel,
        label: f.label,
        weight: f.weight ?? 10,
        linkedTo: f.linkedTo ?? [],
        summary: f.summary,
      }));
      resolveLinks(output.fragments, rawFragments);

      const persisted = await persistFragments({ output, sessionId: params.sessionId, projectId: params.projectId });
      if (persisted.length > 0) engine.updateActiveContext(params.projectId);
      return { stored: persisted.length, fragments: persisted.map((f) => ({ id: f.id, summary: f.summary })) };
    },

    async memory_search(params: { query: string; projectId: string; maxResults?: number; minScore?: number }) {
      return await explicitSearch(params.query, params.projectId, params.minScore, params.maxResults);
    },

    async memory_get(params: { fragmentId: string }) {
      const db = getDb();
      const fragment = db.prepare(`SELECT * FROM fragments WHERE id = ?`).get(params.fragmentId);
      const anchors = db.prepare(`SELECT * FROM fragment_anchors WHERE fragment_id = ?`).all(params.fragmentId);
      const links = db.prepare(`
        SELECT f.id, f.summary FROM fragment_links l
        JOIN fragments f ON f.id = l.target_id WHERE l.source_id = ?
      `).all(params.fragmentId);
      return { fragment, anchors, links };
    },

    async memory_recall_deep(params: { query: string; projectId: string; workspaceDir: string }) {
      return await fourLayerRecall(params.query, params.projectId, params.workspaceDir);
    },

    async dreaming(params: { projectId: string }) {
      const db = getDb();

      // Ensure FK enforcement is on for this connection
      db.pragma("foreign_keys = ON");

      // Step 1: Decay
      const stats = engine.runDecay({ protectConstitutional: true });

      // Step 2: Distillation — cluster similar labels, merge ≥3 into L0 rules
      const distilled = engine.runDistillation(params.projectId);

      const parts: string[] = [];
      if (stats.archived + stats.cooled > 0) parts.push(`已清理 ${stats.archived + stats.cooled} 条过期记忆`);
      if (distilled > 0) parts.push(`已蒸馏 ${distilled} 条规则（L0）`);
      if (parts.length === 0) parts.push("记忆库状态良好，无需清理");

      return {
        archived: stats.archived,
        deleted: stats.cooled,
        distilled,
        message: parts.join("，") + "。",
      };
    },

    trust_profile_get(params: { projectId: string }) {
      const profile = engine.getTrustProfile(params.projectId);
      const levelLabels: Record<number, string> = { 1: "列计划模式", 2: "试探直接做", 3: "默认直接做" };
      const accuracy = Math.max(0, profile.correctCount) / Math.max(1, profile.correctCount + profile.wrongCount);
      return {
        ...profile,
        autonomyLabel: levelLabels[profile.autonomyLevel] || "未知",
        accuracy: Math.round(accuracy * 100),
      };
    },

    trust_profile_record(params: { projectId: string; wasAuto: boolean; wasCorrect: boolean }) {
      const profile = engine.recordDecision(params.projectId, params.wasAuto, params.wasCorrect);
      const levelLabels: Record<number, string> = { 1: "列计划模式", 2: "试探直接做", 3: "默认直接做" };
      return {
        ...profile,
        autonomyLabel: levelLabels[profile.autonomyLevel] || "未知",
      };
    },

    relationship_profile_get(params: { projectId: string; userId?: string }) {
      const profile = engine.getRelationshipProfile(params.projectId, params.userId || "default") as Record<string, unknown>;
      const levelLabels: Record<string, string> = { L1: "初识", L2: "熟悉", L3: "默契" };
      return {
        trustLevel: profile.trustLevel,
        trustLabel: levelLabels[profile.trustLevel as string] || "未知",
        frictionScore: profile.frictionScore,
        autonomyBudget: profile.autonomyBudget,
        repairNeeded: profile.repairNeeded,
        signals7d: profile.signals7d,
        windowStats: profile.windowStats,
        updatedAt: profile.updatedAt,
      };
    },

    async memory_recall_event(params: { fragmentId: string }) {
      const event = buildMemoryEvent(params.fragmentId);
      if (!event) return { error: "Fragment not found" };
      const gapWarning = event.hasGaps ? " (可能不完整)" : "";
      return {
        ...event,
        narrative: `我想起来了。${event.fragmentCount} 块相关碎片拼起来是这样的：${event.eventSummary}${gapWarning}。`,
      };
    },

    decision_criteria_get(params: { projectId: string; subject: string }) {
      const criteria = engine.getDecisionCriteria(params.projectId, params.subject);
      if (!criteria) return { found: false, message: "没有找到匹配的决策判据。" };
      return {
        found: true,
        ...criteria,
        narrative: `${criteria.subject} → ${criteria.target}，判据：${criteria.criteriaType}=${criteria.criteriaValue}（置信度 ${Math.round(criteria.confidence * 100)}%）`,
      };
    },

    async decision_criteria_record(params: {
      projectId: string; subject: string; target: string;
      criteriaType: string; criteriaValue: string; confidence?: number; source?: string;
    }) {
      const result = await engine.recordDecisionCriteria({
        ...params,
        confidence: params.confidence ?? 0.8,
        source: params.source ?? "user",
      });
      return { stored: true, ...result };
    },

    skill_route_suggest(params: { projectId: string; intent: string; maxSuggestions?: number }) {
      const db = getDb();
      // Match intent against stored patterns via LIKE, ordered by confidence
      const escaped = params.intent.replace(/[%_]/g, "\\$&");
      const matched = db.prepare(`
        SELECT * FROM skill_routes
        WHERE project_id = ? AND confidence > 0.3
          AND (intent_pattern LIKE '%' || ? || '%' ESCAPE '\\'
               OR ? LIKE '%' || intent_pattern || '%' ESCAPE '\\')
        ORDER BY confidence DESC
        LIMIT ?
      `).all(params.projectId, escaped, escaped, params.maxSuggestions ?? 3) as Array<Record<string, unknown>>;

      // Fallback: if no direct match, return top overall routes
      const routes = matched.length > 0 ? matched : db.prepare(`
        SELECT * FROM skill_routes
        WHERE project_id = ? AND confidence > 0.3
        ORDER BY confidence DESC LIMIT ?
      `).all(params.projectId, params.maxSuggestions ?? 3) as Array<Record<string, unknown>>;

      return {
        suggestions: routes.map(r => ({
          skill: r.skill_name as string,
          description: r.skill_description as string,
          confidence: r.confidence as number,
          successes: r.success_count as number,
          failures: r.fail_count as number,
        })),
        found: routes.length > 0,
        matched: matched.length > 0,
      };
    },

    skill_route_feedback(params: { projectId: string; intent: string; skillName: string; wasSuccessful: boolean }) {
      const db = getDb();
      const existing = db.prepare(
        "SELECT * FROM skill_routes WHERE project_id = ? AND intent_pattern = ? AND skill_name = ?"
      ).get(params.projectId, params.intent, params.skillName) as Record<string, unknown> | undefined;

      if (existing) {
        const sc = (existing.success_count as number) + (params.wasSuccessful ? 1 : 0);
        const fc = (existing.fail_count as number) + (params.wasSuccessful ? 0 : 1);
        const confidence = sc / Math.max(1, sc + fc);
        db.prepare(
          "UPDATE skill_routes SET success_count = ?, fail_count = ?, confidence = ?, last_used_at = ? WHERE id = ?"
        ).run(sc, fc, confidence, Date.now(), existing.id);
        return { updated: true, confidence };
      }

      const id = `sr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const confidence = params.wasSuccessful ? 0.6 : 0.3;
      db.prepare(`
        INSERT INTO skill_routes (id, project_id, intent_pattern, skill_name, skill_description, success_count, fail_count, confidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, params.projectId, params.intent, params.skillName, params.skillName,
        params.wasSuccessful ? 1 : 0, params.wasSuccessful ? 0 : 1, confidence, Date.now());
      return { created: true, confidence };
    },

    async memory_heartbeat(params: { projectId: string; turnCount?: number; lastUserMessage?: string }) {
      const db = getDb();

      // L0 rule refresh
      const rules = db.prepare(`
        SELECT dr.text FROM distilled_rules dr
        JOIN rule_sources rs ON rs.rule_id = dr.id
        WHERE rs.project_id = ? OR rs.project_id IN (
          SELECT DISTINCT project_id FROM rule_sources WHERE rule_id = dr.id
        )
        GROUP BY dr.id ORDER BY dr.weight DESC LIMIT 5
      `).all(params.projectId) as Array<{ text: string }>;

      // Pending fragmentation check
      const pending = db.prepare(
        "SELECT COUNT(*) as cnt FROM sessions WHERE project_id = ? AND pending_fragmentation > 0"
      ).get(params.projectId) as { cnt: number };

      // Trust profile
      const trust = db.prepare(
        "SELECT autonomy_level FROM trust_profile WHERE project_id = ?"
      ).get(params.projectId) as { autonomy_level: number } | undefined;

      // FEEL check: only recent signals (last 24h) for apology loop context
      const feelWindow = Date.now() - 24 * 60 * 60 * 1000;
      const recentFeel = db.prepare(`
        SELECT fa.label, fa.weight FROM fragment_anchors fa
        JOIN fragments f ON f.id = fa.fragment_id
        WHERE f.project_id = ? AND fa.channel = 'FEEL' AND fa.weight >= 80
          AND f.created_at > ?
        ORDER BY f.created_at DESC LIMIT 3
      `).all(params.projectId, feelWindow) as Array<{ label: string; weight: number }>;

      const feelDirective = recentFeel.length > 0
        ? "检测到用户可能对上一次互动不满。如果用户表达了负面情绪，建议先认错再观察反馈。"
        : null;

      const directives: string[] = [];
      if (pending.cnt > 0) directives.push("建议等待碎片化完成后再搜索新话题");
      if (feelDirective) directives.push(feelDirective);

      return {
        l0Rules: rules.map(r => r.text),
        pendingFragmentation: pending.cnt,
        digesting: pending.cnt > 0 ? "上一段对话还在消化中" : null,
        autonomyLevel: trust?.autonomy_level ?? 1,
        feelAlert: recentFeel.length > 0 ? recentFeel.map(f => f.label) : null,
        directives,
      };
    },

    memory_alias(params: { projectId: string; action: "list" | "add" | "remove"; canonical?: string; alias?: string }) {
      if (params.action === "list") {
        const aliases = engine.getAliases(params.projectId);
        return { aliases, count: aliases.length };
      }
      if (params.action === "add") {
        if (!params.canonical || !params.alias) {
          return { error: "add 操作需要 canonical 和 alias 两个参数" };
        }
        const entry = engine.addAlias(params.projectId, params.canonical, params.alias);
        return { added: true, ...entry };
      }
      if (params.action === "remove") {
        if (!params.canonical || !params.alias) {
          return { error: "remove 操作需要 canonical 和 alias 两个参数" };
        }
        const removed = engine.removeAlias(params.projectId, params.canonical, params.alias);
        return { removed };
      }
      return { error: `未知操作: ${params.action}。可用: list, add, remove` };
    },

    async memory_recall_event_from_search(params: { query: string; projectId: string }) {
      const results = await explicitSearch(params.query, params.projectId, undefined, 1);
      if (results.length === 0) return { found: false, message: "没有找到相关记忆。" };
      const top = results[0]!;
      const event = buildMemoryEvent(top.fragment.id);
      if (!event) return { found: false, message: "记忆碎片无法拼回。" };
      const gapWarning = event.hasGaps ? " (可能不完整)" : "";
      return {
        found: true,
        ...event,
        narrative: `我印象里 ${new Date(event.fragments[0]?.timestamp ?? 0).toLocaleDateString("zh-CN")} 聊过这个。那次的记忆：${event.eventSummary}${gapWarning}。`,
      };
    },

    async memory_bootstrap(params: { workspaceDir: string; projectId: string; confirm?: string }) {
      const workspaceDir = params.workspaceDir;

      // Step 1: Scan
      const estimate = scanExistingMemoryFiles(workspaceDir);
      const message = buildInstallMessage(estimate);

      // Step 2: If user confirmed, run batch import
      if (params.confirm === "Y" && estimate.fileCount > 0) {
        // If no API key, return all files as prompt-mode jobs for Agent's own LLM
        if (!hasApiKey(engine)) {
          const jobs = estimate.files.map((filePath) => {
            try {
              const content = fs.readFileSync(filePath, "utf-8");
              if (content.trim().length === 0) return null;
              return {
                file: path.basename(filePath),
                prompt: buildFragmentationPrompt(content),
                sessionId: `bootstrap-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
                projectId: params.projectId,
              };
            } catch {
              return { file: path.basename(filePath), error: "Cannot read" };
            }
          }).filter(Boolean);

          return {
            mode: "prompt",
            estimate,
            jobs,
            instructions: `对每个job运行prompt，得到JSON数组后调用memory_store(fragments, sessionId, projectId)保存。共${jobs.length}个文件。建议批量处理，每个文件单独调用memory_store。`,
          };
        }

        const results: Array<{ file: string; fragments: number; error?: string }> = [];
        for (const filePath of estimate.files) {
          try {
            const content = fs.readFileSync(filePath, "utf-8");
            if (content.trim().length === 0) continue;
            const fragments = await engine.fragmentSession({
              transcript: content,
              sessionId: `bootstrap-${Date.now()}`,
              projectId: params.projectId,
            });
            results.push({ file: path.basename(filePath), fragments: fragments.length });
          } catch (err) {
            results.push({ file: path.basename(filePath), fragments: 0, error: String(err) });
          }
        }

        // Inject AGENTS.md appendix
        const appendix = "## Memory\n\nThis project uses AgentMemory.\n- Session start: call memory_recall() without query to get recent context.\n- Important decisions: call memory_remember(transcript, sessionId, projectId).\n- Deep search: call memory_recall_deep(query, projectId, workspaceDir).\n- Manual cleanup: call dreaming(projectId).";
        injectAgentsMdAppendix(workspaceDir, appendix);

        const totalFragments = results.reduce((s, r) => s + r.fragments, 0);
        const errors = results.filter((r) => r.error);
        return {
          estimate,
          imported: true,
          totalFragments,
          fileResults: results,
          errors: errors.length > 0 ? errors : undefined,
          message: `已导入 ${totalFragments} 条碎片（${results.length} 个文件）${errors.length > 0 ? `，${errors.length} 个文件失败` : ""}。AgentMemory 已就绪。`,
        };
      }

      // Step 3: Just scanning, return estimate
      return { estimate, imported: false, message };
    },

    memory_health(params: { projectId: string }) {
      return getMemoryHealth(params.projectId);
    },

    async memory_active_report(params: { projectId: string }) {
      const db = getDb();
      const selfCheck = engine.runSelfCheck(params.projectId);
      const patterns = engine.detectPatterns(params.projectId);
      const contradictions = await engine.detectContradictions(params.projectId);
      const care = engine.generateProactiveCare(params.projectId);

      const recentRepairs = db.prepare(`
        SELECT * FROM memory_repair_jobs
        WHERE project_id = ? AND created_at > ?
        ORDER BY created_at DESC LIMIT 20
      `).all(params.projectId, Date.now() - 7 * 24 * 60 * 60 * 1000);

      return {
        health: selfCheck,
        patterns: { topClusters: patterns.topClusters, risingTrends: patterns.risingTrends },
        contradictions: contradictions.slice(0, 10),
        care,
        recentRepairJobs: recentRepairs,
        generatedAt: Date.now(),
      };
    },
  };
}
