/**
 * Semantic embedder: uses OpenAI-compatible embeddings API (e.g. DeepSeek).
 *
 * Falls back to n-gram hash when:
 * - No API key configured
 * - Network error / timeout
 * - API returns an error
 *
 * The hash fallback is character-overlap only and will produce lower-quality
 * search results, especially for Chinese queries.
 */

const DIM = 384;
const EMBEDDING_MODEL = "text-embedding-3-small";

// ── Configuration (populated lazily from engine) ────────────────────

let _apiKey = "";
let _baseURL = "https://api.deepseek.com";

export function configureEmbedder(apiKey: string, baseURL?: string): void {
  _apiKey = apiKey;
  if (baseURL) _baseURL = baseURL;
}

// ── Public API ──────────────────────────────────────────────────────

export async function embed(text: string): Promise<number[]> {
  if (_apiKey && _apiKey.length > 10 && _apiKey !== "test-key") {
    try {
      return await embedViaApi(text);
    } catch {
      // Fall through to hash fallback on any error
    }
  }
  return embedHash(text);
}

async function embedViaApi(text: string): Promise<number[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(`${_baseURL}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${_apiKey}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text,
        encoding_format: "float",
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Embedding API returned ${response.status}`);
    }

    const data = await response.json() as { data: Array<{ embedding: number[] }> };
    const vec = data.data?.[0]?.embedding;
    if (!vec || vec.length === 0) throw new Error("Empty embedding returned");

    // Normalize to unit vector
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return norm === 0 ? vec : vec.map((v) => v / norm);
  } finally {
    clearTimeout(timer);
  }
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
