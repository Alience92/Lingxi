import { cosineSimilarity } from "./embedder.js";

// Source 1: Behavioral signals from message text
export function detectBehaviorSignals(
  userMessage: string,
  previousAssistantMessage?: string
): Array<{ signal: string; weight: number }> {
  const signals: Array<{ signal: string; weight: number }> = [];
  const text = userMessage;

  const correctionPatterns = /不对|不是|错了|搞错了|应该是|实际上是|你记错了/;
  if (correctionPatterns.test(text)) {
    signals.push({ signal: "correction", weight: 80 });
  }

  const frustrationPatterns = /又(错了|来了|是这样)|已经说了|第[二三四五六七八九十]/;
  if (frustrationPatterns.test(text) && correctionPatterns.test(text)) {
    signals.push({ signal: "frustration", weight: 90 });
  }

  const urgencyPatterns = /必须|今天|马上|紧急|deadline|尽快|立刻|现在就要/;
  if (urgencyPatterns.test(text)) {
    signals.push({ signal: "urgency", weight: 50 });
  }

  if (previousAssistantMessage && previousAssistantMessage.includes("建议")) {
    const questionPatterns = /建议|怎么|要不要|要我/;
    if (questionPatterns.test(previousAssistantMessage) && !questionPatterns.test(text)) {
      signals.push({ signal: "bypass", weight: 40 });
    }
  }

  const confirmPatterns = /^对$|^对的$|^就这样$|^完美$|^可以$|^好$|没错|正是这个意思/;
  if (confirmPatterns.test(text.trim())) {
    signals.push({ signal: "confirmation", weight: 30 });
  }

  return signals;
}

// Source 2: Content clustering (cross-session similarity)
export function detectClusteringSignal(
  newFragmentEmbedding: number[],
  existingFragments: Array<{ summary: string; embedding: number[] }>,
  threshold: number = 0.82
): { signal: string; weight: number; similarCount: number } | null {
  const similar: Array<{ idx: number; score: number }> = [];
  for (let i = 0; i < existingFragments.length; i++) {
    const fragment = existingFragments[i];
    if (!fragment) continue;
    const score = cosineSimilarity(newFragmentEmbedding, fragment.embedding);
    if (score >= threshold) {
      similar.push({ idx: i, score });
    }
  }
  if (similar.length >= 3) {
    return { signal: "recurring_pattern", weight: 90, similarCount: similar.length };
  }
  if (similar.length >= 2) {
    return { signal: "repeated_topic", weight: 60, similarCount: similar.length };
  }
  return null;
}

// Combine both sources into FEEL anchor weight
export function computeFeelWeight(
  behaviorSignals: Array<{ signal: string; weight: number }>,
  clusteringSignal: { signal: string; weight: number } | null
): number {
  const maxBehavior = behaviorSignals.length > 0
    ? Math.max(...behaviorSignals.map((s) => s.weight))
    : 0;
  const clusteringWeight = clusteringSignal?.weight ?? 0;
  return Math.min(255, Math.max(10, maxBehavior || clusteringWeight || 10));
}
