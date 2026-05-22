import { pipeline } from "@xenova/transformers";

const MODEL_NAME = "Xenova/bge-small-en-v1.5";
const DIM = 384;

let extractor: any = null;

async function getExtractor() {
  if (!extractor) {
    extractor = await pipeline("feature-extraction", MODEL_NAME);
  }
  return extractor;
}

export async function embed(text: string): Promise<number[]> {
  const ext = await getExtractor();
  const result = await ext(text, { pooling: "mean", normalize: true });
  return Array.from(result.data as Float32Array);
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
