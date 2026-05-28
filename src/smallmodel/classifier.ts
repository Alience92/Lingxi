// Fragment channel classifier: two-stage (encoder → LLM fallback) with shadow mode
import { classify } from "./index.js";
import { classify as encoderClassify } from "./encoder.js";

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

// Boundary samples for FEEL vs WHAT disambiguation (few-shot prompt)
const BOUNDARY_SAMPLES = [
  { text: "这个方案还需要细化一下", label: "WHAT" },
  { text: "你说的不对，我之前不是这个意思", label: "FEEL" },
  { text: "帮我给这个函数加个重试逻辑", label: "WHAT" },
  { text: "你理解错了我的需求", label: "FEEL" },
  { text: "上次你改的那个bug又出现了", label: "FEEL" },
];

function buildFallbackPrompt(text: string): string {
  const examples = BOUNDARY_SAMPLES.map(
    (e) => `"${e.text}" → ${e.label}`
  ).join("\n");

  return `分类通道(只输出WHAT/FEEL/WHO/WHERE中的一个):
WHAT=实质决策/方案/需求 FEEL=用户对AI的情绪反馈 WHO=涉及人物/角色 WHERE=文件/项目/工具

示例:
${examples}

"${text.slice(0, 300)}"
通道:`;
}

export async function classifyChannel(
  text: string,
): Promise<ClassificationResult> {
  const t0 = Date.now();

  // Stage 1: Try ONNX encoder first (fast)
  let encoderResult: { label: string; confidence: number; stage: string } | null = null;
  try {
    encoderResult = await encoderClassify(text);
  } catch {
    // Encoder unavailable — fall through to LLM
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

  // Stage 2: Low confidence — fall back to LLM few-shot
  const encoderChannel = encoderResult?.label ?? "WHAT";
  const encoderConfidence = encoderResult?.confidence ?? 0;
  let llmChannel = encoderChannel;

  try {
    const prompt = buildFallbackPrompt(text);
    const llmRaw = await classify(prompt, { temperature: 0.1, maxTokens: 8 });
    llmChannel = VALID_CHANNELS.has(llmRaw) ? llmRaw : encoderChannel;
  } catch {
    // LLM failed — keep encoder result
  }

  const latencyMs = Date.now() - t0;

  // Record disagreement to DB shadow_comparisons
  if (encoderResult && llmChannel !== encoderChannel) {
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
        llmChannel,
        "macbert-2stage+fallback",
        0,
        latencyMs,
        Date.now(),
      );
    } catch {
      // DB not available — skip recording
    }
  }

  const isFromFallback = encoderResult === null || encoderResult.confidence < LOW_CONFIDENCE_THRESHOLD;
  const confidence = isFromFallback ? 0.65 : encoderConfidence;

  return {
    channel: llmChannel,
    confidence,
    modelRaw: llmChannel,
    latencyMs,
    source: isFromFallback ? "llm-fallback" : "encoder+s2",
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
