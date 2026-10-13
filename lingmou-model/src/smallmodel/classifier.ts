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
  /** True when an error forced fallback to defaults (model broken, API down, etc.) */
  degraded?: boolean;
  /** Raw encoder label — preserved even when fallback overrides it, for observability */
  encoderLabel?: string;
  encoderConfidence?: number;
}

const LOW_CONFIDENCE_THRESHOLD = 0.6;

// Rate-limit degraded-path logging to once per 5 minutes per error type
const _degradedLogThrottle = new Map<string, number>();

function warnDegraded(key: string, msg: string): void {
  const now = Date.now();
  const last = _degradedLogThrottle.get(key) ?? 0;
  if (now - last > 300_000) {
    console.error(`[Classifier] degraded: ${msg}`);
    _degradedLogThrottle.set(key, now);
  }
}

export async function classifyChannel(
  text: string,
  fallbackApiKey?: string,
  fallbackBaseURL?: string,
): Promise<ClassificationResult> {
  const t0 = Date.now();

  // Stage 1: ONNX encoder (fast, always available)
  let encoderResult: { label: string; confidence: number; stage: string } | null = null;
  let encoderFailed = false;
  try {
    encoderResult = await encoderClassify(text);
  } catch {
    encoderFailed = true;
    warnDegraded("encoder", "ONNX inference failed, using fallback");
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
      degraded: encoderFailed,
      encoderLabel: encoderResult.label,
      encoderConfidence: encoderResult.confidence,
    };
  }

  // Stage 2: Low confidence — LLM few-shot fallback
  const encoderChannel = encoderResult?.label ?? "WHAT";
  const encoderConfidence = encoderResult?.confidence ?? 0;
  let finalChannel = encoderChannel;
  let finalConfidence = encoderConfidence;
  let source: ClassificationResult["source"] = encoderResult?.stage === "s1" ? "encoder+s1" : "encoder+s2";
  let fallbackFailed = false;

  if (fallbackApiKey && fallbackApiKey.length > 10) {
    try {
      const fbResult = await classifyFallback(text, fallbackApiKey, fallbackBaseURL);
      if (VALID_CHANNELS.has(fbResult.label)) {
        finalChannel = fbResult.label;
        finalConfidence = fbResult.confidence;
        source = "llm-fallback";
      }
    } catch {
      fallbackFailed = true;
      warnDegraded("fallback", "LLM fallback API failed, using encoder result");
    }
  }

  const latencyMs = Date.now() - t0;

  return {
    channel: finalChannel,
    confidence: finalConfidence,
    modelRaw: finalChannel,
    latencyMs,
    source,
    degraded: encoderFailed || fallbackFailed,
    encoderLabel: encoderChannel,
    encoderConfidence,
  };
}
