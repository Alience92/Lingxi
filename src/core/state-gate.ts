// state-gate.ts — 状态写入统一入口 (V7 Phase A-2)
// 所有核心状态修改必须通过此模块，禁止各模块直接 SQL INSERT/UPDATE
//
// 5 个一级入口:
//   recordFragment()      — 事实: 碎片写入
//   recordRecall()        — 事实: 召回日志
//   recordFeedback()      — 事实: 用户反馈/学习信号
//   rebuildActiveContext() — 派生: 工作记忆重建
//   runMaintenanceCycle()  — 控制: 后台维护周期

import { getDb } from "../db/connection.js";

// ── 类型 ──────────────────────────────────────

export type StateCategory = "fact" | "derived" | "control" | "product";

export interface WriteRecord {
  category: StateCategory;
  table: string;
  caller: string; // 调用方标识
  timestamp: number;
}

// ── 写入日志 (所有入口共享) ─────────────────

const writeLog: WriteRecord[] = [];
const MAX_LOG = 500;

function logWrite(category: StateCategory, table: string, caller: string): void {
  writeLog.push({ category, table, caller, timestamp: Date.now() });
  if (writeLog.length > MAX_LOG) writeLog.shift();
}

/** 获取最近的写入记录，用于调试和审计 */
export function getWriteLog(limit: number = 50): WriteRecord[] {
  return writeLog.slice(-limit);
}

// ── 1. recordFragment — 碎片写入统一入口 ────

export interface FragmentInput {
  sessionId?: string;
  projectId?: string;
  summary: string;
  keywords?: string | null;
  rawPrefix?: string | null;
  rawText?: string | null;     // V7-A: original uncompressed text
  originalLength?: number;     // V7-A: length of original before compression
  compressionLevel?: number;   // V7-A: 1=verbatim, 3=standard, 5=heavily compressed
  isProactive?: number;
  profileId?: string;
  subtype?: "decision" | "todo" | "preference" | null;
}

export function recordFragment(input: FragmentInput, caller: string): string {
  const db = getDb();
  const now = Date.now();
  const fragId = `frag_${now}_${Math.random().toString(36).slice(2, 8)}`;

  // V7-A: Auto-determine compression level
  // - High-value memories (raw text > 200 chars, contains named entities) → lower compression
  // - Short/transient messages → standard compression
  let compression = input.compressionLevel ?? 3;
  if (!input.compressionLevel) {
    if (input.rawText && input.rawText.length > 200) compression = 2;
    if (input.originalLength && input.originalLength > 500) compression = 1;
    if (input.isProactive) compression = 4; // Proactive messages don't need exact wording
  }

  db.prepare(`
    INSERT INTO fragments (id, session_id, project_id, summary, keywords, raw_prefix, raw_text,
      original_length, compression_level,
      linked_count, decay_score, recalled_count, created_at, status, retrieval_state,
      asset_state, is_proactive, is_read, profile_id, subtype)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1.5, 0, ?, 'active', 'active', 'retained', ?, 0, ?, ?)
  `).run(
    fragId, input.sessionId || "unknown",
    input.projectId || process.env.LINGXI_PROJECT_ID || "C--Users-Administrator",
    input.summary || input.rawText?.slice(0, 150) || "",
    input.keywords || null,
    input.rawPrefix || input.rawText?.slice(0, 80) || null,
    input.rawText || null,
    input.originalLength || (input.rawText?.length ?? 0),
    compression,
    now, input.isProactive || 0,
    input.profileId || "user_default",
    input.subtype ?? null,
  );

  // V7-A: Preserve full raw text for traceability
  if (input.rawText && input.rawText.length > 100) {
    try {
      db.prepare("INSERT OR REPLACE INTO raw_evidence (fragment_id, original_text, original_length) VALUES (?, ?, ?)")
        .run(fragId, input.rawText, input.originalLength || input.rawText.length);
    } catch { /* raw_evidence table may not exist yet */ }
  }

  // FTS5 rebuild trigger
  try { db.exec("INSERT INTO fragments_fts(fragments_fts) VALUES('rebuild')"); } catch {}

  logWrite("fact", "fragments", caller);
  return fragId;
}

/** V7-A: Retrieve original text evidence for a fragment */
export function getRawEvidence(fragmentId: string): string | null {
  try {
    const db = getDb();
    // Try raw_evidence table first, then fall back to fragment.raw_text
    const ev = db.prepare("SELECT original_text FROM raw_evidence WHERE fragment_id = ?").get(fragmentId) as { original_text: string } | undefined;
    if (ev?.original_text) return ev.original_text;
    const frag = db.prepare("SELECT raw_text FROM fragments WHERE id = ?").get(fragmentId) as { raw_text: string | null } | undefined;
    return frag?.raw_text ?? null;
  } catch { return null; }
}

// ── 2. recordRecall — 召回日志统一入口 ─────

export function recordRecall(
  fragmentId: string, query: string, score: number, caller: string,
): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    "INSERT INTO recall_log (fragment_id, query, score, recalled_at) VALUES (?, ?, ?, ?)"
  ).run(fragmentId, query, score, now);

  // Keep fragments.recalled_count and last_recalled_at in sync
  try {
    db.prepare(
      "UPDATE fragments SET recalled_count = recalled_count + 1, last_recalled_at = ?, decay_score = 1.5, retrieval_state = 'active' WHERE id = ? AND asset_state != 'user_deleted'"
    ).run(now, fragmentId);
  } catch { /* fragment may not exist */ }

  logWrite("fact", "recall_log", caller);
}

// ── 3. recordFeedback — 学习信号统一入口 ────

export interface FeedbackInput {
  userMessage: string;
  mood: string;
  feedback: number;   // -1.0 (correction) to +1.5 (confirmation)
  reason: string;     // "correction" | "confirmation" | "follow_up" | "neutral"
  decision?: string;  // which DCGK node won
  caller: string;
}

export function recordFeedback(input: FeedbackInput): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO dcgk_shadow_logs
    (timestamp, event_type, user_message, mood, delta, decision, prediction_match)
    VALUES (?, 'learn', ?, ?, ?, ?, ?)
  `).run(
    Date.now(), input.userMessage.slice(0, 200), input.mood,
    input.feedback, input.decision || "unknown",
    input.feedback > 0.5 ? 1 : input.feedback < -0.5 ? 0 : null,
  );

  logWrite("fact", "dcgk_shadow_logs", input.caller);
}

// ── 4. rebuildActiveContext — 工作记忆重建 ──

export interface ActiveContext {
  fragments: string[];     // 当前相关的碎片 ID
  preferences: string[];   // 当前激活的偏好
  careMessages: string[];  // 待推送的关怀
  alerts: string[];        // 系统告警
  builtAt: number;
  builtBy: string;
}

let currentContext: ActiveContext | null = null;

export function rebuildActiveContext(
  fragments: string[], preferences: string[], care: string[], alerts: string[],
  caller: string,
): ActiveContext {
  currentContext = {
    fragments, preferences,
    careMessages: care, alerts,
    builtAt: Date.now(), builtBy: caller,
  };

  // Persist to projects.active_context with source metadata
  try {
    const db = getDb();
    const projectId = process.env.LINGXI_PROJECT_ID || "C--Users-Administrator";
    // Store as structured JSON with build metadata
    const payload = JSON.stringify({
      ...currentContext,
      _meta: {
        version: "v7-alpha",
        fragmentSource: "memory-recall top-10",
        preferenceSource: "preference-graph active",
        careSource: "proactive-care check",
        rebuildable: true, // ← derived state marker
      },
    });
    // Update derived context in place so required project fields are never dropped.
    const existing = db.prepare("SELECT workspace_dir FROM projects WHERE id = ?").get(projectId) as { workspace_dir: string } | undefined;
    const wsDir = existing?.workspace_dir || process.env.HOME || process.env.USERPROFILE || ".";
    if (existing) {
      db.prepare("UPDATE projects SET active_context = ? WHERE id = ?").run(payload, projectId);
    } else {
      db.prepare(
        "INSERT INTO projects (id, name, workspace_dir, active_context, created_at) VALUES (?, 'default', ?, ?, ?)"
      ).run(projectId, wsDir, payload, Date.now());
    }
  } catch { /* projects table may not exist yet */ }

  logWrite("derived", "active_context", caller);
  return currentContext;
}

/** Mark a DB table as rebuildable (derived) in schema metadata */
export function markTableRebuildable(tableName: string): void {
  try {
    const db = getDb();
    db.prepare(`CREATE TABLE IF NOT EXISTS _state_meta (table_name TEXT PRIMARY KEY, category TEXT, rebuildable INTEGER)`).run();
    db.prepare("INSERT OR REPLACE INTO _state_meta (table_name, category, rebuildable) VALUES (?, 'derived', 1)").run(tableName);
  } catch { /* meta table may fail in older schemas */ }
}

/** Get all tables marked as rebuildable */
export function getRebuildableTables(): Array<{ table_name: string }> {
  try {
    const db = getDb();
    return db.prepare("SELECT table_name FROM _state_meta WHERE rebuildable = 1").all() as Array<{ table_name: string }>;
  } catch { return []; }
}

export function getActiveContext(): ActiveContext | null {
  return currentContext;
}

// ── 5. runMaintenanceCycle — 维护周期入口 ──

export interface MaintenanceResult {
  decayed: number;
  distilled: number;
  checked: number;
  errors: string[];
  hourglass?: { warmed?: number; archivedThisRound?: number; cooled?: number };
  userModels?: { created: number; reinforced: number };
}

let lastMaintenanceAt = 0;

export async function runMaintenanceCycle(caller: string): Promise<MaintenanceResult> {
  // 统一委托 MemoryOrchestrator——生产唯一维护入口。eval/测试仍可调用，
  // 但主链逻辑只有一份，避免 runMaintenanceCycle 与 orchestrator 双实现漂移。
  const { runMemoryOrchestrator } = await import("./orchestrator.js");
  const r = await runMemoryOrchestrator();
  lastMaintenanceAt = Date.now();
  logWrite("control", "maintenance_cycle", caller);
  return {
    decayed: r.phases.maintain.hourglassWarmed + r.phases.maintain.hourglassArchived,
    distilled: r.phases.maintain.userModelsCreated + r.phases.maintain.userModelsReinforced,
    checked: r.phases.review.signalsConsumed,
    errors: r.errors,
    userModels: {
      created: r.phases.maintain.userModelsCreated,
      reinforced: r.phases.maintain.userModelsReinforced,
    },
  };
}

export function getLastMaintenanceTime(): number {
  return lastMaintenanceAt;
}
