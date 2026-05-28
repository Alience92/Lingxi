// Fragment channel classifier: two-stage (encoder → LLM fallback) with shadow mode
import { classify as encoderClassify } from "./encoder.js";
import { classifyFallback } from "./fallback.js";

const VALID_CHANNELS = new Set(["WHAT", "FEEL", "WHO", "WHERE"]);

export interface ClassificationResult {
  channel: string;
  confidence: number;
  modelRaw: string;
  latencyMs: number;
  source: "encoder" | "encoder+s1" | "encoder+s2" | "llm-fallback";
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

const LOW_CONFIDENCE_THRESHOLD = 0.6;

export async function classifyChannel(
  text: string,
  fallbackApiKey?: string,
  fallbackBaseURL?: string,
): Promise<ClassificationResult> {
  const t0 = Date.now();

  // Stage 1: ONNX encoder (fast, always available)
  let encoderResult: { label: string; confidence: number; stage: string } | null = null;
  try {
    encoderResult = await encoderClassify(text);
  } catch {
    // Encoder unavailable — fall through
  }

  if (encoderResult && encoderResult.confidence >= LOW_CONFIDENCE_THRESHOLD) {
    const latencyMs = Date.now() - t0;
    const channel = VALID_CHANNELS.has(encoderResult.label) ? encoderResult.label : "WHAT";
    return {
      channel,
      confidence: encoderResult.confidence,
      modelRaw: encoderResult.label,
      latencyMs,
      source: encoderResult.stage === "s1" ? "encoder+s1" : "encoder+s2",
    };
  }

  // Stage 2: Low confidence — LLM few-shot fallback (GPT-reviewed prompt)
  const encoderChannel = encoderResult?.label ?? "WHAT";
  const encoderConfidence = encoderResult?.confidence ?? 0;
  let finalChannel = encoderChannel;
  let finalConfidence = encoderConfidence;
  let source: ClassificationResult["source"] = encoderResult?.stage === "s1" ? "encoder+s1" : "encoder+s2";

  if (fallbackApiKey && fallbackApiKey.length > 10) {
    try {
      const fbResult = await classifyFallback(text, fallbackApiKey, fallbackBaseURL);
      if (VALID_CHANNELS.has(fbResult.label)) {
        finalChannel = fbResult.label;
        finalConfidence = fbResult.confidence;
        source = "llm-fallback";
      }
    } catch {
      // LLM fallback failed — keep encoder result
    }
  }

  const latencyMs = Date.now() - t0;

  // Record disagreement to DB shadow_comparisons for later analysis
  if (encoderResult && finalChannel !== encoderChannel) {
    try {
      const { getDb } = await import("../db/connection.js");
      const db = getDb();
      const projectId = process.env.AGENTMEMORY_PROJECT ?? "C--Users-Administrator";
      db.prepare(`INSERT INTO shadow_comparisons (id, project_id, fragment_id, summary_preview, slm_channel, llm_channel, slm_model, match_result, latency_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        `sc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        projectId,
        `fallback-${Date.now()}`,
        text.slice(0, 200),
        encoderChannel,
        finalChannel,
        "macbert-2stage+fallback",
        0,
        latencyMs,
        Date.now(),
      );
    } catch {
      // DB not available — skip recording
    }
  }

  return {
    channel: finalChannel,
    confidence: finalConfidence,
    modelRaw: finalChannel,
    latencyMs,
    source,
  };
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
