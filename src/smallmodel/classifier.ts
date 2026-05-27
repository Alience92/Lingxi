// Fragment channel classifier (shadow mode): SLM classifies, compares with LLM
import { classify } from "./index.js";

const VALID_CHANNELS = new Set(["WHAT", "FEEL", "WHO", "WHERE"]);

export interface ClassificationResult {
  channel: string;
  confidence: number;
  modelRaw: string;
  latencyMs: number;
}

export interface ShadowComparison {
  text: string;
  slm: ClassificationResult;
  llm: { channel: string } | null;
  match: boolean;
  timestamp: number;
}

const _comparisons: ShadowComparison[] = [];
const MAX_COMPARISONS = 500;

export async function classifyChannel(
  text: string,
): Promise<ClassificationResult> {
  const t0 = Date.now();
  let modelRaw: string;
  try {
    modelRaw = await classify(text, { temperature: 0.1, maxTokens: 8 });
  } catch {
    modelRaw = "WHAT";
  }
  const latencyMs = Date.now() - t0;

  const channel = VALID_CHANNELS.has(modelRaw) ? modelRaw : "WHAT";
  const confidence = modelRaw.length <= 6 && VALID_CHANNELS.has(modelRaw) ? 0.7 : 0.4;

  return { channel, confidence, modelRaw, latencyMs };
}

export function recordComparison(
  text: string,
  slm: ClassificationResult,
  llm: { channel: string } | null
): void {
  _comparisons.push({
    text, slm, llm,
    match: llm ? slm.channel === llm.channel : false,
    timestamp: Date.now(),
  });
  if (_comparisons.length > MAX_COMPARISONS) _comparisons.shift();
}

export function getShadowStats(): {
  total: number;
  matchRate: number;
  channelAccuracy: Record<string, { correct: number; total: number }>;
  avgLatencyMs: number;
} {
  const total = _comparisons.length;
  const matches = _comparisons.filter(c => c.match).length;
  const totalLatency = _comparisons.reduce((s, c) => s + c.slm.latencyMs, 0);

  const channelAccuracy: Record<string, { correct: number; total: number }> = {};
  for (const c of _comparisons) {
    if (!c.llm) continue;
    const ch = c.llm.channel;
    if (!channelAccuracy[ch]) channelAccuracy[ch] = { correct: 0, total: 0 };
    channelAccuracy[ch]!.total++;
    if (c.match) channelAccuracy[ch]!.correct++;
  }

  return {
    total,
    matchRate: total > 0 ? matches / total : 0,
    channelAccuracy,
    avgLatencyMs: total > 0 ? totalLatency / total : 0,
  };
}

export function getRecentComparisons(limit: number = 20): ShadowComparison[] {
  return _comparisons.slice(-limit);
}
