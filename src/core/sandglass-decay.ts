// 沙漏衰减 — 认知图记忆管理
// 节点5 交付 — 记忆不无限膨胀，自然衰减但可被召回激活

import { loadFullGraph, upsertNode, upsertEdge } from "./dcgk-store.js";

// ═══════════════════════════════════════════
// 衰减阶段定义
// ═══════════════════════════════════════════

type DecayStage = "active" | "warm" | "archived" | "cold";

interface DecayConfig {
  stage: DecayStage;
  thresholdHours: number;   // 进入此阶段的未被访问时长
  activationDecayRate: number; // 每次衰减的系数
}

const DECAY_CONFIGS: DecayConfig[] = [
  { stage: "active",   thresholdHours: 0,    activationDecayRate: 0 },     // 活跃：不过期
  { stage: "warm",     thresholdHours: 168,  activationDecayRate: 0.1 },   // 温热：7天
  { stage: "archived", thresholdHours: 720,  activationDecayRate: 0.05 },  // 归档：30天
  { stage: "cold",     thresholdHours: 2160, activationDecayRate: 0.02 },  // 冷却：90天
];

// ═══════════════════════════════════════════
// 衰减统计
// ═══════════════════════════════════════════

export interface DecayStats {
  active: number;
  warm: number;
  archived: number;
  cold: number;
  removedThisRound: number;
  reactivatedThisRound: number;
}

let lastDecayRun = 0;

// ═══════════════════════════════════════════
// 主衰减逻辑
// ═══════════════════════════════════════════

export function runSandglassDecay(): DecayStats {
  const now = Date.now();
  const { nodes, edges } = loadFullGraph();

  let removed = 0;
  let reactivated = 0;
  const stats = { active: 0, warm: 0, archived: 0, cold: 0 };
  const activationThreshold = 0.05; // 低于此值视为"冷却到零"

  for (const node of nodes) {
    const hoursSinceUpdate = (now - (node as any).last_updated) / 3600000;

    // 判定衰减阶段
    let stage: DecayStage = "active";
    for (const cfg of DECAY_CONFIGS) {
      if (hoursSinceUpdate >= cfg.thresholdHours) {
        stage = cfg.stage;
      }
    }
    stats[stage]++;

    // 应用衰减
    if (stage !== "active") {
      const decayCfg = DECAY_CONFIGS.find(c => c.stage === stage)!;
      const newActivation = node.activation * (1 - decayCfg.activationDecayRate);

      if (newActivation < activationThreshold && stage === "cold") {
        // 冷却节点：从内存图中移除（保留在 SQLite 但不再活跃加载）
        removed++;
        continue;
      }

      // 更新权重
      upsertNode({
        id: node.id,
        label: node.label,
        activation: newActivation,
        confidence: node.confidence,
        plasticity: node.plasticity,
        last_updated: now,
      });
    }
  }

  // 边衰减同理
  for (const edge of edges) {
    const hoursSinceUpdate = (edge.last_updated ? (now - edge.last_updated) / 3600000 : 0);
    if (hoursSinceUpdate > 720) { // >30天
      const newWeight = edge.weight * 0.95;
      upsertEdge({
        source_id: edge.source_id,
        target_id: edge.target_id,
        weight: newWeight,
        eligibility_trace: edge.eligibility_trace,
        etype: edge.etype,
        tag_plastic: edge.tag_plastic,
        last_updated: now,
      });
    }
  }

  lastDecayRun = now;
  return { ...stats, removedThisRound: removed, reactivatedThisRound: reactivated };
}

// ═══════════════════════════════════════════
// 召回激活
// ═══════════════════════════════════════════

export function reactivateNode(nodeId: string): boolean {
  const { nodes } = loadFullGraph();
  const node = nodes.find(n => n.id === nodeId);
  if (!node) return false;

  upsertNode({
    id: node.id,
    label: node.label,
    activation: Math.min(1, node.activation + 0.3), // 召回加分
    confidence: node.confidence,
    plasticity: node.plasticity,
    last_updated: Date.now(),
  });
  return true;
}

// ═══════════════════════════════════════════
// 格式化输出
// ═══════════════════════════════════════════

export function formatDecayStats(): string {
  const stats = runSandglassDecay();
  return [
    `  [灵络] 沙漏衰减：`,
    `    活跃: ${stats.active} | 温热: ${stats.warm} | 归档: ${stats.archived} | 冷却: ${stats.cold}`,
    stats.removedThisRound > 0 ? `    本轮移除: ${stats.removedThisRound}` : "",
    stats.reactivatedThisRound > 0 ? `    本轮激活: ${stats.reactivatedThisRound}` : "",
    lastDecayRun ? `    上次衰减: ${new Date(lastDecayRun).toLocaleString("zh-CN")}` : "",
  ].filter(Boolean).join("\n");
}
