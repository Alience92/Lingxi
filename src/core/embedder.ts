/**
 * Semantic embedder: uses @xenova/transformers with all-MiniLM-L6-v2 (384-dim).
 *
 * Falls back to n-gram hash if the ONNX model fails to load (e.g. first-run
 * download blocked by firewall). The hash fallback is character-overlap only
 * and will produce lower-quality search results, especially for Chinese.
 */

import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

const DIM = 384;
const MODEL = "Xenova/all-MiniLM-L6-v2";

let _pipeline: FeatureExtractionPipeline | null = null;
let _initError = false;

async function getPipeline(): Promise<FeatureExtractionPipeline | null> {
  if (_pipeline) return _pipeline;
  if (_initError) return null;
  try {
    _pipeline = await pipeline("feature-extraction", MODEL);
    return _pipeline;
  } catch (e) {
    _initError = true;
    console.warn(`[AgentMemory] ONNX embedding model failed to load, falling back to n-gram hash. Error: ${String(e).slice(0, 120)}`);
    return null;
  }
}

export async function embed(text: string): Promise<number[]> {
  const pipe = await getPipeline();
  if (pipe) {
    try {
      const result = await pipe(text, { pooling: "mean", normalize: true });
      return Array.from(result.data);
    } catch {
      // Fall through to hash fallback on per-call errors
    }
  }
  return embedHash(text);
}

// ── n-gram hash fallback ────────────────────────────────────────────

function simpleHash(str: string, seed: number): number {
  let h = seed;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h;
}

function embedHash(text: string): number[] {
  const vec = new Array(DIM).fill(0);
  const lower = text.toLowerCase();

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

  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm === 0 ? vec : vec.map((v) => v / norm);
}

// ── cosine similarity (pure math, model-agnostic) ───────────────────

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
