// Fragment channel classifier: two-stage encoder → LLM fallback
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

  return {
    channel: finalChannel,
    confidence: finalConfidence,
    modelRaw: finalChannel,
    latencyMs,
    source,
  };
}
