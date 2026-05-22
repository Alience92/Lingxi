/**
 * Baseline embedder: character n-gram hash vector (384-dim).
 *
 * IMPORTANT: This is a PLACEHOLDER for MVP testing only.
 * - Does NOT capture semantic similarity — relies on character overlap.
 * - Short Chinese queries may return 0 results against technical fragments.
 * - Production MUST use a real embedding model (DeepSeek embeddings API,
 *   bge-small-zh-v1.5 via ONNX, or @xenova/transformers when sharp is fixed).
 *
 * Token budget claim of ~50% savings depends on embedding quality.
 * Baseline hash embedder will under-report similarity and miss valid matches.
 */

const DIM = 384;

function simpleHash(str: string, seed: number): number {
  let h = seed;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h;
}

export async function embed(text: string): Promise<number[]> {
  const vec = new Array(DIM).fill(0);
  const lower = text.toLowerCase();

  // Character bigrams and trigrams as features
  for (let i = 0; i < lower.length - 1; i++) {
    const bigram = lower.slice(i, i + 2);
    const idx = ((simpleHash(bigram, 0) % DIM) + DIM) % DIM;
    vec[idx] += 1;
  }
  for (let i = 0; i < lower.length - 2; i++) {
    const trigram = lower.slice(i, i + 3);
    const idx = ((simpleHash(trigram, 42) % DIM) + DIM) % DIM;
    vec[idx] += 1;
  }

  // L2 normalize
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm === 0 ? vec : vec.map((v) => v / norm);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
