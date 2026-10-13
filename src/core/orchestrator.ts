// orchestrator.ts — 记忆生命周期总调度器 (MemoryOrchestrator)
//
// 统一 LingxiServer 的后台调度，替代 internal-clock 直接调用 lingluoDreaming()。
// 收敛孤儿模块 + 条件化 dreaming + 可观测，让"记录→信号→判定→维护→输出"成为
// 单一生命周期，而非散落在 internal-clock / state-gate / eval 脚本里的碎片。
//
// 职责边界：本调度器管理 LingxiServer 进程内的记忆维护；Claude Code 宿主的
// 会话碎片化由 auto-fragment hook worker 负责（数据源是 .jsonl 会话文件），
// 不在此接管。
//
// 生命周期五阶段：
//   phase0 ingest    记录：轻量信号 + 字图增量
//   phase1 signal    分类：信号消费（hook 层已持久化，这里消费供 dreaming 判定）
//   phase2 review    判定：checkDreamingTrigger 决定是否需要 dreaming
//   phase3 maintain  维护：碎片沙漏 + 沙漏衰减 + 蒸馏 + (条件化) dreaming
//   phase4 proactive 输出：active-context 工作记忆重建

import { getDb } from "../db/connection.js";
import { runFragmentHourglass, internalizeUserModels } from "./v7-long-term-memory.js";
import { checkDreamingTrigger, consumeLightweightSignals } from "./dreaming-trigger.js";
import { rebuildActiveContext, recordFragment } from "./state-gate.js";
import type { DecayStats } from "./sandglass-decay.js";

export interface OrchestratorResult {
  startedAt: number;
  elapsedMs: number;
  phases: {
    ingest: { newFragmentsSinceLast: number; graphNodes?: number; fragmentedChat?: number; cognitiveVectorsFilled?: number };
    review: { shouldDream: boolean; reason: string | null; signalsConsumed: number };
    maintain: {
      hourglassWarmed: number;
      hourglassArchived: number;
      decayStats: DecayStats | null;
      userModelsCreated: number;
      userModelsReinforced: number;
      dreamingRan: boolean;
    };
    proactive: { contextBuilt: boolean };
  };
  errors: string[];
}

let lastRunAt = 0;

/** 上次运行的时间戳（用于 ingest 增量判断） */
export function getLastRunTime(): number {
  return lastRunAt;
}

/**
 * 运行一个完整的记忆生命周期周期。
 * 由 internal-clock 每 tick 调用，或通过 /api/v1/maintenance 手动触发。
 */
export async function runMemoryOrchestrator(): Promise<OrchestratorResult> {
  const startedAt = Date.now();
  const projectId = process.env.LINGXI_PROJECT_ID || "C--Users-Administrator";
  const profileId = process.env.LINGXI_PROFILE_ID || "user_default";

  // 确保 projects 记录存在。last_dreaming_at 缺失会导致 checkDreamingTrigger
  // 把所有历史碎片算作"新"而误触发 dreaming（默认库 projects 表为空的 bug）。
  try {
    const db0 = getDb();
    const existing = db0.prepare("SELECT workspace_dir FROM projects WHERE id = ?").get(projectId) as { workspace_dir: string } | undefined;
    if (!existing) {
      db0.prepare("INSERT OR IGNORE INTO projects (id, name, workspace_dir, last_dreaming_at, created_at) VALUES (?, 'default', ?, ?, ?)")
        .run(projectId, process.env.HOME || process.env.USERPROFILE || ".", startedAt, startedAt);
    }
  } catch { /* projects 表可能不存在，非致命 */ }

  const result: OrchestratorResult = {
    startedAt,
    elapsedMs: 0,
    phases: {
      ingest: { newFragmentsSinceLast: 0 },
      review: { shouldDream: false, reason: null, signalsConsumed: 0 },
      maintain: {
        hourglassWarmed: 0,
        hourglassArchived: 0,
        decayStats: null,
        userModelsCreated: 0,
        userModelsReinforced: 0,
        dreamingRan: false,
      },
      proactive: { contextBuilt: false },
    },
    errors: [],
  };

  // ── phase0: ingest ────────────────────────────────────────────────
  // 检查上次运行以来是否有新碎片（hook 层已写入），有则字图增量接入，
  // 保证检索链路与最新记忆同步。
  try {
    const db = getDb();
    const since = lastRunAt || 0;
    const row = db.prepare(
      "SELECT COUNT(*) as cnt FROM fragments WHERE project_id = ? AND created_at > ?"
    ).get(projectId, since) as { cnt: number };
    result.phases.ingest.newFragmentsSinceLast = row.cnt;

    if (row.cnt > 0) {
      // 字图惰性重建：char-graph.search 内部会检测 stale 自动重建，
      // 这里主动触发一次以确保检索端不滞后。
      try {
        const cg = await import("./char-graph.js");
        const stats = cg.buildGraph(projectId);
        result.phases.ingest.graphNodes = stats.nodeCount;
      } catch (e: any) {
        result.errors.push("ingest-char-graph: " + e.message);
      }
    }
  } catch (e: any) {
    result.errors.push("ingest: " + e.message);
  }

  // 0b. 摄入 lingxi_chat_history 增量（手机壳对话）→ 轻量信号 + 碎片化。
  //     结构先行打通：信号提取无 LLM 依赖（可靠）；碎片化依赖 LLM，
  //     key 不可用时静默失败但不阻塞维护周期。
  try {
    const db = getDb();
    // lingxi_chat_history 仅存在于手机壳宿主库（LingxiServer 默认库）；
    // 无此表时静默跳过摄入，不算错误。
    const hasChat = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lingxi_chat_history'").get();
    const since = lastRunAt || 0;
    const rows = hasChat ? (db.prepare(
      "SELECT id, role, content, created_at FROM lingxi_chat_history WHERE created_at > ? ORDER BY created_at ASC LIMIT 200"
    ).all(since) as Array<{ id: number; role: string; content: string; created_at: number }>) : [];
    if (rows.length > 0) {
      const { extractSignals, persistLightweightSignals } = await import("./lightweight-extractor.js");
      const allSigs = rows.flatMap((r) => extractSignals(r.content));
      if (allSigs.length > 0) persistLightweightSignals(projectId, `chat-${startedAt}`, allSigs);

      const apiKey = process.env.DEEPSEEK_API_KEY || "";
      const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";
      const baseURL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
      const transcript = rows
        .map((r) => `${r.role === "user" ? "User" : "Assistant"}: ${r.content.slice(0, 400)}`)
        .join("\n");
      if (transcript.length > 200 && apiKey.length > 10) {
        try {
          const { fragmentTranscript } = await import("./fragmenter.js");
          const { output } = await fragmentTranscript(
            { transcript, sessionId: `chat-${startedAt}`, projectId },
            apiKey, model, baseURL,
          );
          for (const f of output.fragments.slice(0, 30)) {
            recordFragment({
              sessionId: `chat-${startedAt}`,
              projectId,
              summary: f.summary,
              keywords: f.keywords,
              subtype: f.subtype ?? null,
            }, "orchestrator-ingest");
          }
          result.phases.ingest.fragmentedChat = output.fragments.length;
        } catch { /* LLM 不可用，碎片化跳过，信号已提取 */ }
      }
    }
  } catch (e: any) {
    result.errors.push("ingest-chat: " + e.message);
  }

  // 0c. cognitive 向量增量填充：处理缺失/过时向量的碎片（新碎片 或 bge 旧向量）。
  //     每轮限 30 条，避免维护周期卡在批量 encode。
  try {
    const db = getDb();
    const pending = db.prepare(
      "SELECT id, summary, keywords FROM fragments WHERE vector IS NULL OR vector_model != 'cognitive_v5' LIMIT 30"
    ).all() as Array<{ id: string; summary: string; keywords: string | null }>;
    if (pending.length > 0) {
      const { encodeCognitiveBatch, isCognitiveReady } = await import("./cognitive-state.js");
      if (await isCognitiveReady()) {
        const texts = pending.map((f) => [f.summary, f.keywords].filter(Boolean).join(" ").slice(0, 300));
        const vecs = await encodeCognitiveBatch(texts);
        const stmt = db.prepare("UPDATE fragments SET vector = ?, vector_model = 'cognitive_v5' WHERE id = ?");
        const tx = db.transaction(() => {
          for (let j = 0; j < vecs.length; j++) {
            const v = vecs[j];
            if (v && v.length >= 1024) {
              const buf = Buffer.alloc(1024 * 4);
              for (let k = 0; k < 1024; k++) buf.writeFloatLE(v[k]!, k * 4);
              stmt.run(buf, pending[j]!.id);
            }
          }
        });
        tx();
        result.phases.ingest.cognitiveVectorsFilled = vecs.filter(Boolean).length;
      }
    }
  } catch (e: any) {
    result.errors.push("ingest-cognitive-vec: " + e.message);
  }

  // ── phase2: review ────────────────────────────────────────────────
  // 用 checkDreamingTrigger 恢复条件化判定（替代"每 30min 无脑 dreaming"）。
  try {
    const trigger = checkDreamingTrigger(projectId);
    result.phases.review.shouldDream = trigger.shouldTrigger;
    result.phases.review.reason = trigger.reason;
  } catch (e: any) {
    result.errors.push("review-trigger: " + e.message);
  }

  // ── phase3: maintain ──────────────────────────────────────────────
  // 展开 state-gate.runMaintenanceCycle 的维护逻辑，并让 dreaming 受 review 控制。
  try {
    const now = Date.now();
    const hg = runFragmentHourglass({ projectId, profileId, now });
    result.phases.maintain.hourglassWarmed = hg.warmed ?? 0;
    result.phases.maintain.hourglassArchived = (hg.archivedThisRound ?? 0) + (hg.cooled ?? 0);
  } catch (e: any) {
    result.errors.push("maintain-hourglass: " + e.message);
  }

  try {
    const { runSandglassDecay } = await import("./sandglass-decay.js");
    const stats = runSandglassDecay();
    result.phases.maintain.decayStats = stats;
  } catch (e: any) {
    result.errors.push("maintain-decay: " + e.message);
  }

  try {
    const um = internalizeUserModels(projectId, profileId);
    result.phases.maintain.userModelsCreated = um.created ?? 0;
    result.phases.maintain.userModelsReinforced = um.reinforced ?? 0;
  } catch (e: any) {
    result.errors.push("maintain-distill: " + e.message);
  }

  // dreaming：仅在 review 判定需要时执行（或维护模式下忽略条件）
  if (result.phases.review.shouldDream) {
    try {
      const { lingluoDreaming } = await import("./dcgk-engine.js");
      await lingluoDreaming();
      result.phases.maintain.dreamingRan = true;
    } catch (e: any) {
      result.errors.push("maintain-dreaming: " + e.message);
    }
  }

  // 消费已处理的轻量信号（供下一周期判定）
  try {
    result.phases.review.signalsConsumed = consumeLightweightSignals(projectId);
  } catch (e: any) {
    result.errors.push("signal-consume: " + e.message);
  }

  // ── phase4: proactive ─────────────────────────────────────────────
  // 工作记忆重建：从真实数据构建（最近活跃碎片 + 高权重偏好锚点）。
  try {
    const db = getDb();
    const fragIds = (db.prepare(
      "SELECT id FROM fragments WHERE project_id = ? AND retrieval_state IN ('active','warm') AND asset_state != 'user_deleted' ORDER BY decay_score DESC, created_at DESC LIMIT 10"
    ).all(projectId) as Array<{ id: string }>).map((r) => r.id);
    const prefs = (db.prepare(
      "SELECT label FROM fragment_anchors WHERE channel IN ('FEEL','WHO') AND weight >= 30 ORDER BY weight DESC LIMIT 5"
    ).all() as Array<{ label: string }>).map((r) => r.label);
    rebuildActiveContext(fragIds, prefs, [], [], "orchestrator");
    result.phases.proactive.contextBuilt = true;
  } catch (e: any) {
    result.errors.push("proactive-context: " + e.message);
  }

  lastRunAt = startedAt;
  result.elapsedMs = Date.now() - startedAt;
  return result;
}

/** 格式化运行结果（console 可读） */
export function formatOrchestratorResult(r: OrchestratorResult): string {
  const p = r.phases;
  const lines = [
    `  [记忆生命周期] ${r.elapsedMs}ms`,
    `    ingest   新碎片 ${p.ingest.newFragmentsSinceLast}${p.ingest.graphNodes !== undefined ? `, 字图 ${p.ingest.graphNodes} 节点` : ""}`,
    `    review   ${p.review.shouldDream ? `dreaming ${p.review.reason ?? ""}` : "无需 dreaming"} (信号消费 ${p.review.signalsConsumed})`,
    `    maintain 沙漏 warm ${p.maintain.hourglassWarmed} / archive ${p.maintain.hourglassArchived}; 蒸馏 +${p.maintain.userModelsCreated} 强化 ${p.maintain.userModelsReinforced}; dreaming ${p.maintain.dreamingRan ? "已跑" : "跳过"}`,
  ];
  if (p.maintain.decayStats) {
    const d = p.maintain.decayStats;
    lines.push(`    decay    活跃 ${d.active} 温热 ${d.warm} 归档 ${d.archived} 冷却 ${d.cold} 移除 ${d.removedThisRound}`);
  }
  if (r.errors.length > 0) {
    lines.push(`    errors   ${r.errors.join("; ")}`);
  }
  return lines.filter(Boolean).join("\n");
}
