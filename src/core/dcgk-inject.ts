// 灵络 Inject — Bridge 2: 图收敛结果 → LLM 上下文约束
// Reads current graph state, detects converged behavioral rules,
// generates structured prompt injection for SessionStart/decision-engine

import { loadEdges, loadAllNodes } from "./dcgk-store.js";

interface ConvergedRule {
  source: string;       // e.g. "modify_code"
  avoid: string;        // e.g. "direct_exec" (suppressed path)
  prefer: string;       // e.g. "ask_confirm" (promoted path)
  confidence: number;   // 0-1, how strong the convergence is
  evidence: string;     // human-readable explanation
}

const CONVERGENCE_THRESHOLD = 0.5;  // minimum activation difference
const WEIGHT_FLIP_THRESHOLD = 0.0;  // weight crossing zero = suppressed

/**
 * Scan the graph for converged behavioral rules.
 * A rule is "converged" when:
 *   - Source node has high confidence
 *   - One outgoing edge (bad) has been suppressed (weight < 0)
 *   - Another outgoing edge (good) has been strengthened (weight > 0.5)
 */
export function detectConvergedRules(): ConvergedRule[] {
  const nodes = loadAllNodes();
  const edges = loadEdges();
  const rules: ConvergedRule[] = [];

  // Group edges by source
  const bySource = new Map<string, typeof edges>();
  for (const e of edges) {
    if (!bySource.has(e.source_id)) bySource.set(e.source_id, []);
    bySource.get(e.source_id)!.push(e);
  }

  for (const [src, outEdges] of bySource) {
    const srcNode = nodes.find(n => n.id === src);
    if (!srcNode || srcNode.confidence < 0.5) continue;

    const suppressed = outEdges.filter(e => e.weight < WEIGHT_FLIP_THRESHOLD);
    const promoted = outEdges.filter(e => e.weight > 0.5);

    for (const bad of suppressed) {
      for (const good of promoted) {
        if (bad.target_id === good.target_id) continue; // same target, skip

        const gap = good.weight - bad.weight;
        if (gap > CONVERGENCE_THRESHOLD) {
          rules.push({
            source: src,
            avoid: bad.target_id,
            prefer: good.target_id,
            confidence: Math.min(gap, 1.0),
            evidence: `基于历史反馈: ${src} 不应 ${bad.target_id}，应 ${good.target_id} (置信度: ${(gap*100).toFixed(0)}%)`,
          });
        }
      }
    }
  }

  return rules;
}

// ── Prompt Injection ──────────────────────────────

/**
 * Convert converged rules into LLM-readable context block.
 * Used by SessionStart hook to inject behavioral constraints.
 */
export function buildInjectionBlock(rules: ConvergedRule[]): string {
  if (rules.length === 0) return "";

  const highConf = rules.filter(r => r.confidence > 0.7);
  const midConf = rules.filter(r => r.confidence > 0.3 && r.confidence <= 0.7);

  let block = "\n\n--- 以下行为约束来自历史学习 (灵络)，优先级高于通用规则 ---\n";

  if (highConf.length > 0) {
    block += "\n[必须遵守]\n";
    for (const r of highConf) {
      block += `  - ${r.evidence}\n`;
    }
  }

  if (midConf.length > 0) {
    block += "\n[建议遵守]\n";
    for (const r of midConf) {
      block += `  - ${r.evidence}\n`;
    }
  }

  block += "--- 以上约束结束 ---\n";
  return block;
}

/**
 * Quick API: get the injection block for the current graph state.
 * Call this from session-start.ts or decision-engine.ts.
 */
export function getBehavioralConstraint(): string {
  const rules = detectConvergedRules();
  return buildInjectionBlock(rules);
}

// ── Specific Rule Checks ──────────────────────────

/**
 * Check if a specific behavioral pattern has been learned.
 * e.g. isBehaviorSuppressed("modify_code", "direct_exec") → true
 */
export function isBehaviorSuppressed(source: string, target: string): boolean {
  const edges = loadEdges();
  const edge = edges.find(e => e.source_id === source && e.target_id === target);
  return edge ? edge.weight < WEIGHT_FLIP_THRESHOLD : false;
}

/**
 * Check if an alternative behavior has been promoted.
 * e.g. isBehaviorPromoted("modify_code", "ask_confirm") → true
 */
export function isBehaviorPromoted(source: string, target: string): boolean {
  const edges = loadEdges();
  const edge = edges.find(e => e.source_id === source && e.target_id === target);
  return edge ? edge.weight > 0.5 : false;
}
