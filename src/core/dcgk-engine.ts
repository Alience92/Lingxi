// 灵络 Engine — 内存图动力学 (Opus Step 2: The Kernel)
// propagate() + hebbianUpdate() + conflict detection
// Runs in-memory with TypedArray-backed graph for sub-ms performance

import { upsertNode, upsertEdge, loadFullGraph, persistIfChanged, type GraphNode, type GraphEdge } from "./dcgk-store.js";
import { mapToDeltaSignal } from "./dcgk-signal.js";
import type { DeltaSignal } from "./dcgk-signal.js";
import { getDb } from "../db/connection.js";

// ── In-Memory Graph State ─────────────────────────

interface MemNode {
  id: string; label: string;
  A: number; C: number; P: number; // activation, confidence, plasticity
  lastUpdated: number;
}

interface MemEdge {
  src: number; dst: number;  // indices into nodeIndex
  W: number;                 // weight [-1, 1]
  eligibility: number;       // [0, 1]
  etype: string;
  tagPlastic: boolean;
}

const nodeIndex = new Map<string, number>();
let nodes: MemNode[] = [];
let edges: MemEdge[] = [];

/**
 * Sync a newly-created node from disambiguation into the in-memory graph.
 * Without this, new nodes exist in DB but can't be activated by propagate().
 */
export function addMemoryNode(id: string, label: string): void {
  if (nodeIndex.has(id)) return; // already exists
  const idx = nodes.length;
  nodeIndex.set(id, idx);
  nodes.push({ id, label, A: 0, C: 0.3, P: 0.7, lastUpdated: Date.now() });
}

// ── Configuration ─────────────────────────────────

// Edge creation throttle: max new edges per hour
let edgeCreateCount = 0;
let edgeCreateWindow = Date.now();
const MAX_NEW_EDGES_PER_HOUR = 10;

const CONFIG = {
  PROPAGATION_STEPS: 3,
  DECAY: 0.5,
  ELIGIBILITY_DECAY: 0.6,
  ASYMMETRIC_NEG: 5.0,   // negative feedback 5x
  ASYMMETRIC_POS: 0.3,   // positive feedback milder
  TAG_BOOST: 4.0,        // synaptic tag LR multiplier
  CONFLICT_THRESHOLD: 0.3,
};

// ── Init / Load ───────────────────────────────────

let activeProfile = "user_default"; // 当前激活的 Profile ID

export function getActiveProfile(): string {
  return activeProfile;
}

/**
 * 切换 Profile（热切换，flush 当前状态 → 重载新 Profile 的图）
 * 确保不会跨 Profile 状态污染
 */
export function switchProfile(profileId: string): void {
  if (profileId === activeProfile) return;
  flushEdgePersistence();
  activeProfile = profileId;
  nodeIndex.clear();
  nodes.length = 0;
  edges.length = 0;
  initGraph();
  console.log(`  [灵络] 切换 Profile: "${profileId}"`);
}

export function initGraph(): void {
  const { nodes: dbNodes, edges: dbEdges } = loadFullGraph(activeProfile);

  // If empty OR edges missing (stale state from failed run), re-seed
  if (dbNodes.length === 0 || dbEdges.length === 0) {
    seedBootstrapNodes();
    return;
  }

  // Clear stale state before reload (fixes #4: old indices pointed to wrong positions)
  nodeIndex.clear();
  nodes.length = 0;
  edges.length = 0;

  for (const n of dbNodes) {
    nodeIndex.set(n.id, nodes.length);
    nodes.push({
      id: n.id, label: n.label,
      A: n.activation, C: n.confidence, P: n.plasticity,
      lastUpdated: n.last_updated,
    });
  }

  edges = dbEdges.map(e => ({
    src: nodeIndex.get(e.source_id) ?? -1,
    dst: nodeIndex.get(e.target_id) ?? -1,
    W: e.weight, eligibility: e.eligibility_trace,
    etype: e.etype, tagPlastic: e.tag_plastic === 1,
  })).filter(e => e.src >= 0 && e.dst >= 0);
}

function seedBootstrapNodes(): void {
  // Clear stale state before re-seeding (fixes: multiple initGraph calls)
  nodeIndex.clear();
  nodes.length = 0;
  edges.length = 0;

  // v3: 元认知操作节点 — 调度认知流程，不是领域行为
  const seeds = [
    { id: "verify",   label: "Verify 先验证再回应 查数据 确认事实 检查本地", C: 0.3, P: 0.8 },
    { id: "accept",   label: "Accept 接受输入 正常处理 直接回复 没问题", C: 0.7, P: 0.3 },
    { id: "question", label: "Question 质疑前提 逻辑检查 追问 真有这么简单吗", C: 0.2, P: 0.7 },
    { id: "reject",   label: "Reject 拒绝不合理 错误指令 明显有误 停下", C: 0.5, P: 0.5 },
    { id: "deep_reason", label: "DeepReason 深度推理 建因果链 多步分析 想清楚再说", C: 0.3, P: 0.6 },
    { id: "quick_respond", label: "QuickRespond 快速回应 已知答案 秒回 不需要深度", C: 0.8, P: 0.2 },
    { id: "brake",    label: "Brake 踩刹车 暂停 重复错误 循环了 停下来想一想", C: 0.3, P: 0.7 },
    { id: "request_clarify", label: "RequestClarify 请求澄清 没懂 模糊 你说具体点", C: 0.4, P: 0.6 },
    { id: "user_happy", label: "UserHappy 用户满意 认可 对 好 就是这样", C: 0.9, P: 0.1 },
    { id: "user_frustrated", label: "UserFrustrated 用户挫败 纠正 不对 别 又不是", C: 0.9, P: 0.1 },
  ];
  for (const s of seeds) {
    nodeIndex.set(s.id, nodes.length);
    nodes.push({ ...s, A: 0, lastUpdated: Date.now() });
    upsertNode({ id: s.id, label: s.label, activation: 0, confidence: s.C, plasticity: s.P, last_updated: Date.now() });
  }
  // Default: accept is the normal path (most inputs are fine)
  addEdge("verify", "user_happy", 0.5, "causal");
  addEdge("accept", "user_happy", 0.4, "causal");
  addEdge("accept", "user_frustrated", 0.15, "causal"); // 盲目接受可能被纠正
  addEdge("question", "user_happy", 0.4, "causal");
  addEdge("question", "user_frustrated", 0.2, "causal");
  addEdge("deep_reason", "user_happy", 0.6, "causal");   // 深度推理用户满意
  addEdge("deep_reason", "user_frustrated", 0.05, "causal");
  addEdge("quick_respond", "user_frustrated", 0.2, "causal"); // 太快可能出错
  addEdge("quick_respond", "user_happy", 0.3, "causal");
  addEdge("brake", "user_happy", 0.4, "causal");         // 刹车避免错误
  addEdge("brake", "user_frustrated", 0.15, "causal");
  addEdge("request_clarify", "user_happy", 0.4, "causal");
  addEdge("request_clarify", "user_frustrated", 0.1, "causal");

  // Persist seed edges immediately
  flushEdgePersistence();
}

function addEdge(src: string, dst: string, W: number, etype: string): boolean {
  // Throttle: reset counter every hour
  const now = Date.now();
  if (now - edgeCreateWindow > 3600_000) {
    edgeCreateCount = 0;
    edgeCreateWindow = now;
  }
  if (edgeCreateCount >= MAX_NEW_EDGES_PER_HOUR) return false;

  const si = nodeIndex.get(src);
  const di = nodeIndex.get(dst);
  if (si === undefined || di === undefined) return false;

  // Don't create duplicate edges
  if (edges.some(e => e.src === si && e.dst === di)) return false;

  edges.push({ src: si, dst: di, W, eligibility: 0, etype, tagPlastic: false });
  edgeCreateCount++;
  return true;
}

// ── Prospection (System 2: Mental Simulation) ──────

interface SimResult {
  action: string;
  utility: number;
  trace: string[];
}

/**
 * 沙盘推演: 在克隆的图状态上模拟每个候选动作的后果,
 * 选择预期效用最高的。不修改真实图, 不触发学习。
 */
export function prospection(candidateActions: string[], horizon: number = 2): SimResult {
  // Snapshot current activations
  const baseA = new Map<string, number>();
  for (const n of nodes) baseA.set(n.id, n.A);

  let bestAction = candidateActions[0]!;
  let bestUtility = -Infinity;
  let bestTrace: string[] = [];

  for (const action of candidateActions) {
    // Clone activation state
    const clone = new Map(baseA);
    clone.set(action, 1.0); // hypothetically execute this action
    const trace: string[] = [`[Simulate: ${action}]`];

    // Forward propagate in clone (no learning, no eligibility update)
    for (let step = 0; step < horizon; step++) {
      const next = new Map(clone);
      for (const e of edges) {
        const sa = clone.get(nodes[e.src]!.id) ?? 0;
        if (Math.abs(sa) < 0.05) continue;
        const transfer = sa * e.W * 0.5;
        const cur = next.get(nodes[e.dst]!.id) ?? 0;
        next.set(nodes[e.dst]!.id, cur + transfer);
        if (step === 0 && Math.abs(transfer) > 0.01) {
          trace.push(`  -> ${nodes[e.dst]!.id}: ${transfer >= 0 ? '+' : ''}${transfer.toFixed(2)}`);
        }
      }
      // Decay
      for (const [id, a] of clone) clone.set(id, a * 0.5);
      clone.clear();
      for (const [id, a] of next) clone.set(id, a);
    }

    // Utility evaluation
    const happy = clone.get("user_happy") ?? 0;
    const frust = clone.get("user_frustrated") ?? 0;
    const utility = happy * 1.0 + frust * (-1.5); // pain weighs 1.5x

    trace.push(`  Utility: ${utility.toFixed(2)} (happy=${happy.toFixed(2)} frust=${frust.toFixed(2)})`);

    if (utility > bestUtility) {
      bestUtility = utility;
      bestAction = action;
      bestTrace = trace;
    }
  }

  // Return all candidates with their utilities for explainability
  return { action: bestAction, utility: bestUtility, trace: bestTrace };
}

/** Run prospection on all action nodes and return the full comparison */
export function prospectionCompare(horizon: number = 2): Array<{ action: string; utility: number; happy: number; frust: number }> {
  const actionNodes = ["verify", "accept", "question", "deep_reason", "quick_respond", "brake"];
  // Snapshot
  const baseA = new Map<string, number>();
  for (const n of nodes) baseA.set(n.id, n.A);

  const results: Array<{ action: string; utility: number; happy: number; frust: number }> = [];

  for (const action of actionNodes) {
    const clone = new Map(baseA);
    clone.set(action, 1.0);
    for (let step = 0; step < horizon; step++) {
      const next = new Map(clone);
      for (const e of edges) {
        const sa = clone.get(nodes[e.src]!.id) ?? 0;
        if (Math.abs(sa) < 0.05) continue;
        const cur = next.get(nodes[e.dst]!.id) ?? 0;
        next.set(nodes[e.dst]!.id, cur + sa * e.W * 0.5);
      }
      for (const [id, a] of clone) clone.set(id, a * 0.5);
      clone.clear();
      for (const [id, a] of next) clone.set(id, a);
    }
    const happy = clone.get("user_happy") ?? 0;
    const frust = clone.get("user_frustrated") ?? 0;
    results.push({ action, utility: happy * 1.0 + frust * (-1.5), happy, frust });
  }
  results.sort((a, b) => b.utility - a.utility);
  return results;
}

// ── Core: Propagate ───────────────────────────────

export function propagate(anchors: string[], delta: number): { winner: string; score: number; conflicts: string[] } {
  // Reset activation
  for (const n of nodes) n.A = 0;

  // Inject anchor activation
  for (const anchor of anchors) {
    const idx = nodeIndex.get(anchor);
    if (idx !== undefined) {
      nodes[idx]!.A = Math.max(nodes[idx]!.A, 0.7);
    }
  }

  // Also activate nodes matching delta signal
  if (delta < -0.5) {
    const frustIdx = nodeIndex.get("user_frustrated");
    if (frustIdx !== undefined) nodes[frustIdx]!.A = Math.max(nodes[frustIdx]!.A, Math.abs(delta));
  }

  // Propagation loop
  for (let step = 0; step < CONFIG.PROPAGATION_STEPS; step++) {
    const prevA = nodes.map(n => n.A);

    for (const e of edges) {
      const srcA = prevA[e.src];
      if (srcA === undefined || Math.abs(srcA) < 0.01) continue;
      const transfer = srcA * e.W * CONFIG.DECAY;
      nodes[e.dst]!.A += transfer;
      // Eligibility trace
      e.eligibility = e.eligibility * CONFIG.ELIGIBILITY_DECAY + Math.abs(transfer) * 0.3;
    }
  }

  // Conflict detection
  const conflicts = detectConflicts();

  // Find winner among action-like nodes
  const actionIndices = findActionNodes();
  if (actionIndices.length === 0) {
    return { winner: "unknown", score: 0, conflicts };
  }

  const winnerIdx = actionIndices.reduce((best, i) =>
    nodes[i]!.A > nodes[best]!.A ? i : best, actionIndices[0]!);
  const winner = nodes[winnerIdx]!.id;
  const score = nodes[winnerIdx]!.A;

  // Hebbian update + persist all edge changes
  hebbianUpdate(delta);
  flushEdgePersistence();

  return { winner, score, conflicts };
}

// ── Conflict Detection ────────────────────────────

function detectConflicts(): string[] {
  const conflicts: string[] = [];
  const pairs = [
    ["direct_exec", "ask_confirm"],
    ["user_happy", "user_frustrated"],
  ];
  for (const [a, b] of pairs) {
    const ai = nodeIndex.get(a!);
    const bi = nodeIndex.get(b!);
    if (ai === undefined || bi === undefined) continue;
    if (nodes[ai]!.A > CONFIG.CONFLICT_THRESHOLD &&
        nodes[bi]!.A > CONFIG.CONFLICT_THRESHOLD &&
        nodes[ai]!.C > 0.5 && nodes[bi]!.C > 0.5) {
      conflicts.push(`${a}<->${b}`);
    }
  }
  return conflicts;
}

function findActionNodes(): number[] {
  // v3: 元认知操作 — 调度认知流程的动作
  const actionIds = ["verify", "accept", "question", "reject", "deep_reason", "quick_respond", "brake", "request_clarify"];
  return actionIds.map(id => nodeIndex.get(id)).filter((i): i is number => i !== undefined);
}

// ── Hebbian Update ────────────────────────────────

function hebbianUpdate(delta: number): void {
  const now = Date.now();
  const baseEta = 0.3;

  for (const e of edges) {
    const srcA = nodes[e.src]!.A;
    const dstA = nodes[e.dst]!.A;
    if (Math.abs(srcA) < 0.05 && Math.abs(dstA) < 0.05) continue;

    // Asymmetric learning rate
    let eta = delta < -0.3 ? baseEta * CONFIG.ASYMMETRIC_NEG :
              delta > 0.3 ? baseEta * CONFIG.ASYMMETRIC_POS :
              baseEta;
    if (e.tagPlastic) eta *= CONFIG.TAG_BOOST;

    const effectiveP = Math.min(nodes[e.src]!.P, nodes[e.dst]!.P);

    // Selective eligibility: only edges leading to negative outcome
    const leadsToFrust = nodes[e.dst]?.id === "user_frustrated";
    const eligible = leadsToFrust ? e.eligibility : 0;

    const dw = eta * delta * (srcA * dstA + eligible * 0.5) * effectiveP;

    if (Math.abs(dw) > 0.001) {
      const oldW = e.W;
      e.W = Math.max(-1.0, Math.min(1.0, e.W + dw));

      // Persist if significant change
      if (Math.abs(e.W - oldW) > 0.05) {
        persistIfChanged(
          { source_id: nodes[e.src]!.id, target_id: nodes[e.dst]!.id, weight: e.W,
            eligibility_trace: e.eligibility, etype: e.etype, tag_plastic: e.tagPlastic ? 1 : 0,
            last_updated: now },
          oldW, e.eligibility
        );
      }
    }
  }

  // Synaptic tagging for next round
  if (delta < -0.5) {
    for (const e of edges) {
      if (e.eligibility > 0.1 && e.W > 0.2) {
        e.tagPlastic = true;
      }
    }
    // Dynamic backprop: trace eligibility to find the actual root cause edge
    // (not hardcoded to modify_code→direct_exec). Works with any graph topology.
    const frustIdx = nodeIndex.get("user_frustrated");
    if (frustIdx !== undefined && nodes[frustIdx]!.A > 0.3) {
      // Find the edge with highest eligibility that leads TO user_frustrated
      let bestElig = 0;
      let rootEdge: MemEdge | null = null;
      let altEdge: MemEdge | null = null;
      for (const e of edges) {
        if (nodes[e.dst]?.id === "user_frustrated" && e.eligibility > bestElig) {
          bestElig = e.eligibility;
          rootEdge = e;
          // Find alternative: edge from same source to a non-frustrated target
          for (const ae of edges) {
            if (ae.src === e.src && nodes[ae.dst]?.id !== "user_frustrated" && ae.W > 0) {
              altEdge = ae;
              break;
            }
          }
        }
      }
      if (rootEdge) {
        rootEdge.W -= Math.abs(delta) * 0.5;
        rootEdge.W = Math.max(-0.3, Math.min(1.0, rootEdge.W));
      }
      // Promote alternative path
      if (altEdge) {
        altEdge.W += Math.abs(delta) * 0.6;
        altEdge.W = Math.max(0, Math.min(1.0, altEdge.W));
      }
    }
  }

  // Decay eligibility between calls
  for (const e of edges) {
    e.eligibility *= 0.3;
  }
}

// Flush all edges to SQLite (experiment mode; production uses persistIfChanged threshold)
function flushEdgePersistence(): void {
  const now = Date.now();
  for (const e of edges) {
    const srcId = nodes[e.src]?.id;
    const dstId = nodes[e.dst]?.id;
    if (!srcId || !dstId) continue;
    upsertEdge({
      source_id: srcId, target_id: dstId,
      weight: e.W,
      eligibility_trace: e.eligibility,
      etype: e.etype,
      tag_plastic: e.tagPlastic ? 1 : 0,
      last_updated: now,
    });
  }
}

// ── External API ──────────────────────────────────

/**
 * Process a user message through 灵络.
 * Used by observer.ts instead of (or alongside) LLM-based decision making.
 */
export async function processMessage(
  userMessage: string,
  mood: string,
  eventType: string = "neutral"
): Promise<{ winner: string; score: number; conflicts: string[]; signal: DeltaSignal }> {
  const signal = mapToDeltaSignal(mood, eventType, userMessage);
  const result = propagate(signal.anchors, signal.delta);
  return { ...result, signal };
}

/**
 * Bootstrap edges for a newly created concept node.
 * Connects it to the core state graph (user_frustrated/user_happy) and
 * to co-occurring anchors from the same fragment.
 * This is how the graph GROWS its topology from experience.
 */
export function bootstrapEdges(
  newNodeId: string,
  coAnchors: string[],
  delta: number,
): { created: number; targetState: string | null } {
  const now = Date.now();
  let created = 0;
  let targetState: string | null = null;

  // 1. Connect to state nodes (happy/frustrated) AND action nodes (ask_confirm/direct_exec)
  //    This is critical: without action node edges, new concepts can't influence decisions.
  if (delta < -0.3) {
    // Negative delta: new concept should bias toward caution
    const targets = ["user_frustrated", "ask_confirm"];
    for (const tid of targets) {
      const tgtIdx = nodeIndex.get(tid);
      const newNodeIdx = nodeIndex.get(newNodeId);
      if (tgtIdx !== undefined && newNodeIdx !== undefined) {
        const exists = edges.some(e => e.src === newNodeIdx && e.dst === tgtIdx);
        if (!exists) {
          const w = tid === "ask_confirm" ? 0.10 : 0.15; // weaker link to action
          edges.push({
            src: newNodeIdx, dst: tgtIdx,
            W: w, eligibility: 0, etype: "causal", tagPlastic: true,
          });
          upsertEdge({
            source_id: newNodeId, target_id: tid,
            weight: w, eligibility_trace: 0, etype: "causal",
            tag_plastic: 1, last_updated: now,
          });
          created++;
          targetState = tid;
        }
      }
    }
  } else if (delta > 0.3) {
    // Positive delta: new concept should bias toward proceeding
    const targets = ["user_happy", "direct_exec"];
    for (const tid of targets) {
      const tgtIdx = nodeIndex.get(tid);
      const newNodeIdx = nodeIndex.get(newNodeId);
      if (tgtIdx !== undefined && newNodeIdx !== undefined) {
        const exists = edges.some(e => e.src === newNodeIdx && e.dst === tgtIdx);
        if (!exists) {
          const w = tid === "direct_exec" ? 0.10 : 0.15;
          edges.push({
            src: newNodeIdx, dst: tgtIdx,
            W: w, eligibility: 0, etype: "causal", tagPlastic: true,
          });
          upsertEdge({
            source_id: newNodeId, target_id: tid,
            weight: w, eligibility_trace: 0, etype: "causal",
            tag_plastic: 1, last_updated: now,
          });
          created++;
          targetState = tid;
        }
      }
    }
  } else {
    // Neutral delta: create weak bidirectional edges to both emotion nodes
    const targets = ["user_happy", "user_frustrated"];
    for (const tid of targets) {
      const tgtIdx = nodeIndex.get(tid);
      const newNodeIdxLocal = nodeIndex.get(newNodeId);
      if (tgtIdx !== undefined && newNodeIdxLocal !== undefined) {
        const exists = edges.some(e => e.src === newNodeIdxLocal && e.dst === tgtIdx);
        if (!exists) {
          edges.push({
            src: newNodeIdxLocal, dst: tgtIdx,
            W: 0.15, eligibility: 0, etype: "causal", tagPlastic: true,
          });
          upsertEdge({
            source_id: newNodeId, target_id: tid,
            weight: 0.15, eligibility_trace: 0, etype: "causal",
            tag_plastic: 1, last_updated: now,
          });
          created++;
          targetState = tid;
        }
      }
    }
  }

  // 2. Co-occurrence edges: connect to other anchor nodes from the same fragment
  const newNodeIdx = nodeIndex.get(newNodeId);
  if (newNodeIdx !== undefined) {
    for (const coAnchor of coAnchors) {
      if (coAnchor === newNodeId) continue;
      const coIdx = nodeIndex.get(coAnchor);
      if (coIdx !== undefined) {
        const exists = edges.some(e =>
          (e.src === newNodeIdx && e.dst === coIdx) ||
          (e.src === coIdx && e.dst === newNodeIdx)
        );
        if (!exists) {
          edges.push({
            src: newNodeIdx, dst: coIdx,
            W: 0.10, eligibility: 0, etype: "cooccurs", tagPlastic: true,
          });
          upsertEdge({
            source_id: newNodeId, target_id: coAnchor,
            weight: 0.10, eligibility_trace: 0, etype: "cooccurs",
            tag_plastic: 1, last_updated: now,
          });
          created++;
        }
      }
    }
  }

  return { created, targetState };
}

/**
 * Collect concept nodes with activation above threshold after propagation.
 * Used by memory-recall to find related concepts.
 */
export function collectActivatedNodes(threshold: number = 0.3): Array<{ id: string; label: string; activation: number }> {
  return nodes
    .filter(n => n.A > threshold)
    .map(n => ({ id: n.id, label: n.label, activation: n.A }))
    .sort((a, b) => b.activation - a.activation);
}

/**
 * Get graph stats for monitoring
 */
export function graphStats(): { nodes: number; edges: number; taggedEdges: number } {
  return {
    nodes: nodes.length,
    edges: edges.length,
    taggedEdges: edges.filter(e => e.tagPlastic).length,
  };
}

// ═══════════════════════════════════════════
// 灵络 dreaming — 记忆维护周期（精简版）
// 2026-08-14 简化：移除陪伴者集成（影子收集/好感度/主动关怀反思），
// 灵络 dreaming 只保留记忆核心操作。碎片沙漏/衰减/蒸馏由
// MemoryOrchestrator (phase3 maintain) 统一执行，此处不再重复。
// ═══════════════════════════════════════════

export async function lingluoDreaming(): Promise<void> {
  const now = Date.now();
  console.log("  [灵络] dreaming 周期开始...");

  // 记忆维护（沙漏衰减/蒸馏）已由 MemoryOrchestrator phase3 统一执行，
  // 此处仅触发记忆级整理（碎片状态刷新），不再调用陪伴者模块。
  try {
    const db = getDb();
    // 更新最后 dreaming 时间，供 dreaming-trigger 判定
    const projectId = process.env.LINGXI_PROJECT_ID || "C--Users-Administrator";
    db.prepare("UPDATE projects SET last_dreaming_at = ? WHERE id = ?").run(now, projectId);
  } catch (e: any) { console.log("  [灵络] dreaming 时间更新异常(非致命): " + e.message); }

  console.log("  [灵络] dreaming 周期结束");
}
