/**
 * Semantic embedder: supports MiniMax and OpenAI-compatible APIs.
 *
 * Falls back to n-gram hash when:
 * - No API key configured
 * - Network error / timeout
 * - API returns an error
 *
 * MiniMax: POST /v1/embeddings?GroupId=xxx  | model: embo-01  | 1536-dim
 * OpenAI:  POST /v1/embeddings              | model: configurable | varies
 */

const DIM = 384;
const EMBEDDING_MODEL = "text-embedding-3-small";

// ── Configuration ────────────────────────────────────────────────────

let _apiKey = "";
let _baseURL = "https://api.deepseek.com";
let _groupId = "";

export function configureEmbedder(apiKey: string, baseURL?: string): void {
  _apiKey = apiKey;
  if (baseURL) {
    _baseURL = baseURL;
    // Extract GroupId from MiniMax-style base URL: "https://api.minimax.chat/v1?GroupId=xxx"
    const m = baseURL.match(/[?&]GroupId=([^&]+)/);
    if (m) _groupId = m[1]!;
  }
}

function isMiniMax(): boolean {
  return _baseURL.includes("minimax");
}

// ── Public API ──────────────────────────────────────────────────────

export type EmbedPurpose = "store" | "query";

export async function embed(text: string, purpose: EmbedPurpose = "store"): Promise<number[]> {
  if (_apiKey && _apiKey.length > 10 && _apiKey !== "test-key") {
    try {
      return await embedViaApi(text, purpose);
    } catch {
      // Fall through to hash fallback on any error
    }
  }
  return embedHash(text);
}

async function embedViaApi(text: string, purpose: EmbedPurpose): Promise<number[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    if (isMiniMax()) {
      return await embedMiniMax(text, purpose, controller.signal);
    }
    return await embedOpenAI(text, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

// ── MiniMax API ─────────────────────────────────────────────────────

async function embedMiniMax(text: string, purpose: EmbedPurpose, signal: AbortSignal): Promise<number[]> {
  const url = `${_baseURL}/v1/embeddings${_groupId ? `?GroupId=${_groupId}` : ""}`;
  const body: Record<string, unknown> = {
    model: "embo-01",
    texts: [text],
    type: purpose === "query" ? "query" : "db",
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${_apiKey}` },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) throw new Error(`MiniMax embeddings returned ${response.status}`);

  const data = await response.json() as { vectors?: number[][]; base_resp?: { status_code?: number } };
  if (data.base_resp?.status_code && data.base_resp.status_code !== 0) {
    throw new Error(`MiniMax API error: ${data.base_resp.status_code}`);
  }
  const vec = data.vectors?.[0];
  if (!vec || vec.length === 0) throw new Error("Empty embedding returned");

  // Normalize to unit vector
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm === 0 ? vec : vec.map((v) => v / norm);
}

// ── OpenAI-compatible API ────────────────────────────────────────────

async function embedOpenAI(text: string, signal: AbortSignal): Promise<number[]> {
  const response = await fetch(`${_baseURL}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${_apiKey}` },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text, encoding_format: "float" }),
    signal,
  });

  if (!response.ok) throw new Error(`Embedding API returned ${response.status}`);

  const data = await response.json() as { data: Array<{ embedding: number[] }> };
  const vec = data.data?.[0]?.embedding;
  if (!vec || vec.length === 0) throw new Error("Empty embedding returned");

  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm === 0 ? vec : vec.map((v) => v / norm);
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

// ── cosine similarity ───────────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
