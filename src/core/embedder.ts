/**
 * Semantic embedder: supports MiniMax and OpenAI-compatible APIs.
 *
 * Falls back to n-gram hash when:
 * - No API key configured
 * - Network error / timeout
 * - API returns an error
 *
 * MiniMax: POST /v1/embeddings?GroupId=xxx  | model: embo-01  | 1536-dim
 * OpenAI:  POST /v1/embeddings              | model: configurable | 1536-dim
 *
 * Hash fallback also uses 1536-dim to avoid dimension mismatch when the
 * API fails mid-session — cosine similarity between hash and API vectors
 * is mathematically valid (same length), even if semantic quality degrades.
 */

const DEFAULT_DIM = 1536;
const DEFAULT_MODEL = "text-embedding-3-small";

// ── Singleton accessor (set by engine constructor) ──────────────────

let _currentEmbedder: Embedder | null = null;

export function setCurrentEmbedder(e: Embedder): void {
  if (_currentEmbedder) {
    console.error("[AgentMemory] WARNING: Embedder singleton being replaced. Multiple Engine instances may cause config mismatch.");
  }
  _currentEmbedder = e;
}

export function getCurrentEmbedder(): Embedder {
  if (!_currentEmbedder) {
    // Lazy fallback: read env vars for hook subprocesses that don't go through engine
    const key = process.env.AGENTMEMORY_API_KEY || process.env.DEEPSEEK_API_KEY || "";
    const url = process.env.AGENTMEMORY_EMBEDDING_URL || "https://api.minimax.chat";
    const model = process.env.AGENTMEMORY_EMBEDDING_MODEL || DEFAULT_MODEL;
    _currentEmbedder = new Embedder(key, url, model);
  }
  return _currentEmbedder;
}

// ── Embedder class (one instance per engine) ────────────────────────

export type EmbedPurpose = "store" | "query";

export class Embedder {
  private apiKey: string;
  private baseURL: string;
  private groupId: string;
  public readonly model: string;
  public readonly dim: number;

  constructor(apiKey: string, baseURL = "https://api.minimax.chat", model?: string) {
    this.apiKey = apiKey;
    this.baseURL = baseURL.replace(/\/+$/, "");
    this.model = model || process.env.AGENTMEMORY_EMBEDDING_MODEL || DEFAULT_MODEL;
    this.dim = this.model === "bge-m3" ? 1024 : DEFAULT_DIM;
    this.groupId = "";
    const m = baseURL.match(/[?&]GroupId=([^&]+)/);
    if (m) this.groupId = m[1]!;
  }

  /** Whether this embedder will use hash fallback (no API key configured). */
  isHashOnly(): boolean {
    return !this.apiKey || this.apiKey.length <= 10 || this.apiKey === "test-key";
  }

  private isMiniMax(): boolean {
    return this.baseURL.includes("minimax");
  }

  private _fallbackWarned = false;

  async embed(text: string, purpose: EmbedPurpose = "store"): Promise<number[]> {
    if (this.apiKey && this.apiKey.length > 10 && this.apiKey !== "test-key") {
      try {
        return await this.embedViaApi(text, purpose);
      } catch (e) {
        if (!this._fallbackWarned) {
          console.error("[AgentMemory] Embedding API failed, using hash fallback:", (e as Error).message?.slice(0, 80));
          this._fallbackWarned = true;
        }
      }
    }
    return embedHash(text, this.dim);
  }

  /** Batch embed multiple texts in a single API call. Falls back to hash if API fails. */
  async embedBatch(texts: string[], purpose: EmbedPurpose = "store"): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (this.apiKey && this.apiKey.length > 10 && this.apiKey !== "test-key") {
      try {
        return await this.embedBatchViaApi(texts, purpose);
      } catch {
        // Fall through to hash fallback
      }
    }
    return texts.map((t) => embedHash(t, this.dim));
  }

  private async embedViaApi(text: string, purpose: EmbedPurpose): Promise<number[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      if (this.isMiniMax()) {
        return await this.embedMiniMax(text, purpose, controller.signal);
      }
      return await this.embedOpenAI(text, controller.signal, this.model);
    } finally {
      clearTimeout(timer);
    }
  }

  // ── MiniMax API ───────────────────────────────────────────────────

  private async embedBatchViaApi(texts: string[], purpose: EmbedPurpose): Promise<number[][]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      if (this.isMiniMax()) {
        const url = `${this.baseURL}/v1/embeddings${this.groupId ? `?GroupId=${this.groupId}` : ""}`;
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.apiKey}` },
          body: JSON.stringify({ model: "embo-01", texts, type: purpose === "query" ? "query" : "db" }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`MiniMax batch embeddings returned ${response.status}`);
        const data = await response.json() as { vectors?: number[][]; base_resp?: { status_code?: number } };
        if (data.base_resp?.status_code && data.base_resp.status_code !== 0) {
          throw new Error(`MiniMax API error: ${data.base_resp.status_code}`);
        }
        return (data.vectors ?? []).map((v) => normalize(v));
      }
      // OpenAI-compatible batch
      const response = await fetch(`${this.baseURL}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, input: texts, encoding_format: "float" }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Batch embedding API returned ${response.status}`);
      const data = await response.json() as { data: Array<{ embedding: number[] }> };
      return (data.data ?? []).map((d) => normalize(d.embedding));
    } finally {
      clearTimeout(timer);
    }
  }

  private async embedMiniMax(text: string, purpose: EmbedPurpose, signal: AbortSignal): Promise<number[]> {
    const url = `${this.baseURL}/v1/embeddings${this.groupId ? `?GroupId=${this.groupId}` : ""}`;
    const body: Record<string, unknown> = {
      model: "embo-01",
      texts: [text],
      type: purpose === "query" ? "query" : "db",
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.apiKey}` },
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

    return normalize(vec);
  }

  // ── OpenAI-compatible API ──────────────────────────────────────────

  private async embedOpenAI(text: string, signal: AbortSignal, model: string): Promise<number[]> {
    const response = await fetch(`${this.baseURL}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model, input: text, encoding_format: "float" }),
      signal,
    });

    if (!response.ok) throw new Error(`Embedding API returned ${response.status}`);

    const data = await response.json() as { data: Array<{ embedding: number[] }> };
    const vec = data.data?.[0]?.embedding;
    if (!vec || vec.length === 0) throw new Error("Empty embedding returned");

    return normalize(vec);
  }
}

// ── n-gram hash fallback (1536-dim, same as API output) ─────────────

function simpleHash(str: string, seed: number): number {
  let h = seed;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h;
}

function embedHash(text: string, dim: number): number[] {
  const vec = new Array(dim).fill(0);
  const lower = text.toLowerCase();

  for (let i = 0; i < lower.length - 1; i++) {
    const bigram = lower.slice(i, i + 2);
    const idx = ((simpleHash(bigram, 0) % dim) + dim) % dim;
    vec[idx] += 1;
  }
  for (let i = 0; i < lower.length - 2; i++) {
    const trigram = lower.slice(i, i + 3);
    const idx = ((simpleHash(trigram, 42) % dim) + dim) % dim;
    vec[idx] += 1;
  }

  return normalize(vec);
}

function normalize(vec: number[]): number[] {
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
