// 灵络 Observer — 影子模式 (Shadow Mode)
// 旁路监听真实对话, 静默运行图引擎, 不干预主流程
// 所有状态写入 dcgk_shadow_logs 表供后续分析
//
// 三大探针:
//   1. 预测一致性 (dcgk_recommended vs llm_actual)
//   2. 关键边权重演化 (modify_code->direct_exec/ask_confirm)
//   3. 语义消歧精度 (anchor merge vs new)
//
// 毕业标准 (解除影子模式):
//   - 连续100次真实任务
//   - 灵络推荐与LLM实际行为一致率 > 90%
//   - 无关键边权重震荡导致的严重逻辑冲突
//
// 防御性编程:
//   - 超时: 上游调用方负责超时控制 (replay engine: 5000ms, production: Promise.race)
//   - 熔断: 节点 >5000 → 暂停复杂计算
//   - 深度限制: 沙盘推演 horizon=2 (影子模式)

import { getDb } from "../db/connection.js";
import { initGraph, propagate, graphStats } from "./dcgk-engine.js";
import { resolveAnchors } from "./dcgk-disambiguate.js";
import { detectConvergedRules, buildInjectionBlock } from "./dcgk-inject.js";
import { mapToDeltaSignal } from "./dcgk-signal.js";
import { synapticPrune, loadAllNodes } from "./dcgk-store.js";

// ── Schema ────────────────────────────────────────

const SHADOW_SCHEMA = `
CREATE TABLE IF NOT EXISTS dcgk_shadow_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  event_type TEXT NOT NULL,       -- 'observe' | 'learn' | 'converge' | 'prune' | 'snapshot'
  user_message TEXT,
  mood TEXT,
  delta REAL,
  anchors TEXT,                   -- JSON array
  decision TEXT,                  -- winner node ID
  dcgk_recommended TEXT,          -- [PROBE 1] 灵络 recommended action
  llm_actual_action TEXT,         -- [PROBE 1] what the main Agent actually did
  prediction_match INTEGER,       -- [PROBE 1] 1=aligned, 0=mismatch, NULL=no LLM action
  key_edges_snapshot TEXT,        -- [PROBE 2] JSON: weights of critical edges
  anchor_merge_decision TEXT,     -- [PROBE 3] JSON: {anchor: "merged"|"new"} per anchor
  decision_score REAL,
  conflicts TEXT,                 -- JSON array
  rules_detected INTEGER,
  injection_preview TEXT,         -- first 200 chars of generated injection
  graph_nodes INTEGER,
  graph_edges INTEGER,
  tagged_edges INTEGER
);

CREATE INDEX IF NOT EXISTS idx_shadow_ts ON dcgk_shadow_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_shadow_event ON dcgk_shadow_logs(event_type);
`;

let schemaReady = false;

function ensureShadowSchema(): void {
  if (schemaReady) return;
  const db = getDb();
  db.exec(SHADOW_SCHEMA);

  // Migration: add columns that may be missing on existing tables
  const existingCols = new Set(
    (db.prepare("SELECT name FROM pragma_table_info('dcgk_shadow_logs')").all() as Array<{name:string}>)
      .map(r => r.name)
  );
  const needed = [
    { name: "dcgk_recommended", type: "TEXT" },
    { name: "llm_actual_action", type: "TEXT" },
    { name: "prediction_match", type: "INTEGER" },
    { name: "key_edges_snapshot", type: "TEXT" },
    { name: "anchor_merge_decision", type: "TEXT" },
  ];
  for (const col of needed) {
    if (!existingCols.has(col.name)) {
      db.exec(`ALTER TABLE dcgk_shadow_logs ADD COLUMN ${col.name} ${col.type}`);
    }
  }
  schemaReady = true;
}

// ── Observer API ──────────────────────────────────

let graphInitialized = false;
let observeCount = 0;
let lastPruneTime = Date.now();
const PRUNE_INTERVAL = 3600_000; // prune every hour

/**
 * Observe a user message. Runs 灵络 propagation silently,
 * logs the state, but NEVER modifies the main agent's response.
 *
 * Called from observer.ts, session-end hook, or chat-engine (元认知探针).
 *
 * @param userMessage - The user's input text
 * @param mood - Inferred mood (neutral/frustration/excited)
 * @param eventType - Event classification (neutral/user_frustration/user_correction/user_confirmation)
 * @param llmActualAction - [元认知闭环] 从 LLM 回复推断的实际行为 (correction/deep_reason/request_clarify/brake/quick_respond/proceed_auto)
 */
export async function shadowObserve(
  userMessage: string,
  mood: string,
  eventType: string = "neutral",
  llmActualAction?: string
): Promise<void> {
  ensureShadowSchema();
  if (!graphInitialized) {
    initGraph();
    graphInitialized = true;
  }
  observeCount++;

  // 1. Signal mapping
  const signal = mapToDeltaSignal(mood, eventType, userMessage);
  // 若有外部提供的行为标注（来自 chat-engine 探针），不跳过，确保探针数据写入
  if (!llmActualAction && Math.abs(signal.delta) < 0.05 && eventType === "neutral") {
    // Skip trivial observations (no learning signal, no correction)
    return;
  }

  // 2. Circuit breaker: pause if graph exceeds safety threshold
  const stats = graphStats();
  if (stats.nodes > 5000) {
    console.log(`[灵络 Shadow] Circuit breaker: ${stats.nodes} nodes > 5000. Skipping heavy compute.`);
    return;
  }

  // 3. Semantic disambiguation
  const anchors = await resolveAnchors(signal.anchors);

  // 4. Propagate through graph (synchronous, with try-catch safety)
  let result;
  try {
    result = propagate(anchors, signal.delta);
  } catch (e) {
    console.log(`[灵络 Shadow] propagate error: ${e}. Skipping.`);
    const db2 = getDb();
    db2.prepare(`INSERT INTO dcgk_shadow_logs (timestamp, event_type, user_message) VALUES (?, 'error', ?)`)
      .run(Date.now(), userMessage.slice(0, 200));
    return;
  }

  // 4. Check for converged rules
  const rules = detectConvergedRules();
  const injection = buildInjectionBlock(rules);

  // PROBE 1: Prediction alignment — compare 灵络 decision vs actual LLM behavior.
  // 优先使用传入的 llmActualAction（来自 chat-engine 的回复分析）；
  // 若未提供则回退到基于 eventType 的推导（影子模式批量处理历史数据时）。
  const dcgkRecommended = result.winner;
  const llmActual = llmActualAction
    ?? (eventType === "user_correction" ? "correction" :
        eventType === "user_confirmation" ? "confirmation" :
        eventType === "user_explicit_rule" ? "correction" :
        mood === "flow" ? "proceed_auto" : "unknown");
  // v3: 元认知操作匹配 — correction → verify/question/brake, confirmation → accept/quick_respond
  const predictionMatch = (["verify","question","brake","request_clarify"].includes(dcgkRecommended) && llmActual === "correction")
                       || (["accept","quick_respond"].includes(dcgkRecommended) && llmActual === "proceed_auto")
                       || (["accept","deep_reason"].includes(dcgkRecommended) && llmActual === "confirmation")
                       || (dcgkRecommended === "reject" && llmActual === "correction")
                       ? 1 : 0;

  // PROBE 2: Key edge weight snapshot
  const { loadEdges } = await import("./dcgk-store.js");
  const keyEdges = loadEdges().filter(e =>
    (e.source_id === "modify_code" && (e.target_id === "direct_exec" || e.target_id === "ask_confirm"))
    || (e.source_id === "direct_exec" && e.target_id === "user_frustrated")
  );
  const keySnapshot = JSON.stringify(keyEdges.map(e => ({
    s: e.source_id, t: e.target_id, w: e.weight.toFixed(3), tag: e.tag_plastic
  })));

  // PROBE 3: Anchor merge decisions
  const mergeDecisions: Record<string, string> = {};
  for (const a of anchors) {
    const nodeExists = loadAllNodes().some(n => n.id === a);
    mergeDecisions[a] = nodeExists ? "merged" : "new";
  }
  const mergeJson = JSON.stringify(mergeDecisions);

  // 5. Log to shadow table
  const db = getDb();
  db.prepare(`
    INSERT INTO dcgk_shadow_logs
    (timestamp, event_type, user_message, mood, delta, anchors,
     decision, decision_score, conflicts, rules_detected,
     injection_preview, graph_nodes, graph_edges, tagged_edges,
     dcgk_recommended, llm_actual_action, prediction_match,
     key_edges_snapshot, anchor_merge_decision)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Date.now(),
    signal.delta < -0.5 ? "learn" : Math.abs(signal.delta) > 0.3 ? "corrective" : "observe",
    userMessage.slice(0, 200),
    mood,
    signal.delta,
    JSON.stringify(anchors),
    result.winner,
    result.score,
    JSON.stringify(result.conflicts),
    rules.length,
    injection.slice(0, 200),
    stats.nodes,
    stats.edges,
    stats.taggedEdges,
    dcgkRecommended,
    llmActual,
    predictionMatch,
    keySnapshot,
    mergeJson
  );

  // 6. Periodic pruning
  if (Date.now() - lastPruneTime > PRUNE_INTERVAL) {
    const pruned = synapticPrune();
    if (pruned.removed_edges > 0 || pruned.hardened_nodes > 0) {
      db.prepare(`
        INSERT INTO dcgk_shadow_logs (timestamp, event_type, graph_nodes, graph_edges)
        VALUES (?, 'prune', ?, ?)
      `).run(Date.now(), stats.nodes - pruned.removed_edges, stats.edges);
    }
    lastPruneTime = Date.now();
  }
}

/**
 * Called on session end. Logs a full graph snapshot for offline analysis.
 */
export function shadowSnapshot(): void {
  ensureShadowSchema();
  if (!graphInitialized) return;

  const stats = graphStats();
  const rules = detectConvergedRules();
  const db = getDb();
  db.prepare(`
    INSERT INTO dcgk_shadow_logs
    (timestamp, event_type, rules_detected, graph_nodes, graph_edges, tagged_edges)
    VALUES (?, 'snapshot', ?, ?, ?, ?)
  `).run(Date.now(), rules.length, stats.nodes, stats.edges, stats.taggedEdges);
}

// ── Shadow Learn (closed-loop feedback) ───────────

/**
 * Extract feedback signal from the user's NEXT message.
 * This closes the learning loop: we infer something → user responds → we check if we were right.
 *
 * Returns a feedback multiplier for Hebbian delta:
 *   +1.5 = user confirmed (strong reinforce)
 *   -1.0 = user corrected (suppress)
 *   +0.3 = neutral continuation (weak reinforce — conversation didn't break)
 *   0    = topic changed / unclear
 */
export function extractFeedback(currentUserMsg: string, nextUserMsg: string): { feedback: number; reason: string } {
  const correctionPatterns = /不对|不是|错了|别这样做|搞错了|你理解错了|不是这个意思|错了！|错误|别胡说|不要|别给我|不想听/;
  const confirmationPatterns = /对|对的|是的|谢谢|好|明白了|懂了|知道了|没错|就是这样|可以|太好了|帮了大忙|辛苦了/;
  const questionPatterns = /怎么|为什么|什么意思|能再|换个角度|还有别的|还有其他/;

  // Correction detected
  if (correctionPatterns.test(nextUserMsg)) {
    return { feedback: -1.0, reason: "correction" };
  }

  // Confirmation detected
  if (confirmationPatterns.test(nextUserMsg)) {
    return { feedback: 1.5, reason: "confirmation" };
  }

  // Follow-up question — means they're still engaged with the topic
  if (questionPatterns.test(nextUserMsg)) {
    return { feedback: 0.5, reason: "follow_up_question" };
  }

  // Neutral continuation — natural conversation flow
  return { feedback: 0.3, reason: "neutral_continuation" };
}

/**
 * Shadow learn: process a message pair (user message + their NEXT message as feedback).
 * Runs the full observer pipeline on the first message, then applies feedback-modulated
 * Hebbian update based on what the user said next.
 */
export async function shadowLearn(
  userMessage: string,
  mood: string,
  eventType: string,
  nextUserMessage: string | null,
): Promise<{ decision: string; feedbackApplied: string; feedback: number } | null> {
  ensureShadowSchema();
  if (!graphInitialized) {
    initGraph();
    graphInitialized = true;
  }
  observeCount++;

  const signal = mapToDeltaSignal(mood, eventType, userMessage);
  if (Math.abs(signal.delta) < 0.05 && eventType === "neutral" && !nextUserMessage) {
    return null;
  }

  const stats = graphStats();
  if (stats.nodes > 5000) {
    console.log(`[灵络 Shadow] Circuit breaker: ${stats.nodes} nodes > 5000. Skipping.`);
    return null;
  }

  const anchors = await resolveAnchors(signal.anchors);
  if (anchors.length === 0) return null;

  // Extract feedback from next user message
  let feedbackMultiplier = 0;
  let feedbackReason = "no_feedback";
  if (nextUserMessage) {
    const fb = extractFeedback(userMessage, nextUserMessage);
    feedbackMultiplier = fb.feedback;
    feedbackReason = fb.reason;
  }

  // Modulated delta = raw delta × feedback
  const modulatedDelta = signal.delta * (feedbackMultiplier !== 0 ? feedbackMultiplier : 1.0);

  let result;
  try {
    result = propagate(anchors, modulatedDelta);
  } catch (e) {
    console.log(`[灵络 Shadow] propagate error: ${e}. Skipping.`);
    return null;
  }

  // Log the learning event
  const db = getDb();
  db.prepare(`
    INSERT INTO dcgk_shadow_logs
    (timestamp, event_type, user_message, mood, delta, anchors,
     decision, decision_score, graph_nodes, graph_edges, tagged_edges)
    VALUES (?, 'learn', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Date.now(),
    userMessage.slice(0, 200),
    mood,
    modulatedDelta,
    JSON.stringify(anchors),
    result.winner,
    result.score,
    stats.nodes,
    stats.edges,
    stats.taggedEdges
  );

  return {
    decision: result.winner,
    feedbackApplied: feedbackReason,
    feedback: feedbackMultiplier,
  };
}

// ── Analysis API ──────────────────────────────────

export interface ShadowSummary {
  totalObservations: number;
  learningEvents: number;
  convergences: number;
  prunes: number;
  currentNodes: number;
  currentEdges: number;
  recentDecisions: Array<{ time: number; decision: string; delta: number }>;
  // Graduation criteria
  predictionAlignment: number;     // 0-1, fraction of aligned predictions
  anchorMergeRate: number;         // 0-1, fraction of anchors merged (vs new)
  keyEdgeStability: { edge: string; weights: number[] };
  graduationReady: boolean;
}

export interface ShadowHealth {
  totalObservations: number;
  predictionAlignment: number;      // 0-1
  anchorMergeRate: number;          // 0-1
  keyEdgeWeights: Array<{ s: string; t: string; w: number }>;
  graduationCriteria: {
    enoughObservations: boolean;    // >= 100
    goodAlignment: boolean;         // >= 90%
    recentlyUpdated: boolean;       // within 24h
  };
}

/**
 * Get a summary of what the shadow observer has seen.
 */
export function shadowSummary(): ShadowSummary {
  ensureShadowSchema();
  const db = getDb();

  const counts = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN event_type = 'learn' THEN 1 ELSE 0 END) as learning,
      SUM(CASE WHEN event_type = 'converge' THEN 1 ELSE 0 END) as convergences,
      SUM(CASE WHEN event_type = 'prune' THEN 1 ELSE 0 END) as prunes
    FROM dcgk_shadow_logs
  `).get() as { total: number; learning: number; convergences: number; prunes: number };

  const recent = db.prepare(`
    SELECT timestamp, decision, delta
    FROM dcgk_shadow_logs
    WHERE decision IS NOT NULL
    ORDER BY timestamp DESC LIMIT 10
  `).all() as Array<{ timestamp: number; decision: string; delta: number }>;

  const stats = graphStats();

  return {
    totalObservations: counts.total,
    learningEvents: counts.learning,
    convergences: counts.convergences,
    prunes: counts.prunes,
    currentNodes: stats.nodes,
    currentEdges: stats.edges,
    recentDecisions: recent.map(r => ({
      time: r.timestamp,
      decision: r.decision,
      delta: r.delta,
    })),
    predictionAlignment: 0,
    anchorMergeRate: 0,
    keyEdgeStability: { edge: "", weights: [] },
    graduationReady: false,
  };
}

/**
 * Check shadow health against graduation criteria.
 * 毕业标准: >=100 observations, >=90% alignment, updated within 24h.
 */
export function shadowHealth(): ShadowHealth {
  ensureShadowSchema();
  const db = getDb();

  const total = (db.prepare("SELECT COUNT(*) as cnt FROM dcgk_shadow_logs").get() as { cnt: number }).cnt;
  const matched = (db.prepare("SELECT COUNT(*) as cnt FROM dcgk_shadow_logs WHERE prediction_match = 1").get() as { cnt: number }).cnt;
  const withPred = (db.prepare("SELECT COUNT(*) as cnt FROM dcgk_shadow_logs WHERE prediction_match IS NOT NULL").get() as { cnt: number }).cnt;

  // Anchor merge rate
  const mergeLogs = db.prepare("SELECT anchor_merge_decision FROM dcgk_shadow_logs WHERE anchor_merge_decision IS NOT NULL ORDER BY timestamp DESC LIMIT 50").all() as Array<{ anchor_merge_decision: string }>;
  let totalAnchors = 0, mergedAnchors = 0;
  for (const row of mergeLogs) {
    try {
      const d = JSON.parse(row.anchor_merge_decision);
      for (const v of Object.values(d)) {
        totalAnchors++;
        if (v === "merged") mergedAnchors++;
      }
    } catch {}
  }

  // Key edge weights (latest snapshot)
  const latest = db.prepare("SELECT key_edges_snapshot FROM dcgk_shadow_logs WHERE key_edges_snapshot IS NOT NULL ORDER BY timestamp DESC LIMIT 1").get() as { key_edges_snapshot: string } | undefined;
  const keyEdges = latest ? JSON.parse(latest.key_edges_snapshot) : [];

  // Last update time
  const lastTs = (db.prepare("SELECT MAX(timestamp) as ts FROM dcgk_shadow_logs").get() as { ts: number }).ts || 0;

  return {
    totalObservations: total,
    predictionAlignment: withPred > 0 ? matched / withPred : 0,
    anchorMergeRate: totalAnchors > 0 ? mergedAnchors / totalAnchors : 0,
    keyEdgeWeights: keyEdges,
    graduationCriteria: {
      enoughObservations: total >= 100,
      goodAlignment: withPred > 0 && (matched / withPred) >= 0.90,
      recentlyUpdated: (Date.now() - lastTs) < 24 * 3600_000,
    },
  };
}
