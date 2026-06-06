/**
 * Semantic embedder: OpenAI-compatible API (Ollama, OpenAI, etc.).
 *
 * Falls back to n-gram hash when:
 * - No API key configured
 * - Network error / timeout
 * - API returns an error
 *
 * Model and dimension are configured via AGENTMEMORY_EMBEDDING_MODEL env var.
 * Known dimensions: bge-m3 → 1024, text-embedding-3-small → 1536, default → 1536.
 *
 * Hash fallback dimension matches the configured model's dimension to keep
 * cosine similarity mathematically valid when API and hash vectors coexist.
 */

const DEFAULT_DIM = 1536;
const DEFAULT_MODEL = "text-embedding-3-small";

// ── Singleton accessor (set by engine constructor) ──────────────────

let _currentEmbedder: Embedder | null = null;

export function setCurrentEmbedder(e: Embedder): void {
  if (_currentEmbedder) {
    // Only warn when config actually differs — avoid noise from
    // lazy env-created instance being replaced by an identical one.
    const same = _currentEmbedder.model === e.model
      && _currentEmbedder.baseURL === e.baseURL;
    if (!same) {
      console.error("[AgentMemory] WARNING: Embedder singleton being replaced with different config.");
    }
  }
  _currentEmbedder = e;
}

export function getCurrentEmbedder(): Embedder {
  if (!_currentEmbedder) {
    const key = process.env.AGENTMEMORY_API_KEY || process.env.DEEPSEEK_API_KEY || "";
    const url = process.env.AGENTMEMORY_EMBEDDING_URL || "http://127.0.0.1:11434";
    const model = process.env.AGENTMEMORY_EMBEDDING_MODEL || DEFAULT_MODEL;
    _currentEmbedder = new Embedder(key, url, model);
  }
  return _currentEmbedder;
}

// ── Embedder class ──────────────────────────────────────────────────

export type EmbedPurpose = "store" | "query";

export class Embedder {
  private apiKey: string;
  public readonly baseURL: string;
  public readonly model: string;
  public readonly dim: number;

  constructor(apiKey: string, baseURL = "http://127.0.0.1:11434", model?: string) {
    this.apiKey = apiKey;
    this.baseURL = baseURL.replace(/\/+$/, "");
    this.model = model || process.env.AGENTMEMORY_EMBEDDING_MODEL || DEFAULT_MODEL;
    this.dim = this.model.includes("bge-m3") ? 1024 : DEFAULT_DIM;
  }

  isHashOnly(): boolean {
    return !this.apiKey || this.apiKey.length <= 10 || this.apiKey === "test-key";
  }

  private _fallbackWarned = false;

  async embed(text: string, _purpose: EmbedPurpose = "store"): Promise<number[]> {
    if (this.apiKey && this.apiKey.length > 10 && this.apiKey !== "test-key") {
      try {
        return await this.embedViaApi(text);
      } catch (e) {
        if (!this._fallbackWarned) {
          console.error("[AgentMemory] Embedding API failed, using hash fallback:", (e as Error).message?.slice(0, 80));
          this._fallbackWarned = true;
        }
      }
    }
    return embedHash(text, this.dim);
  }

  async embedBatch(texts: string[], _purpose: EmbedPurpose = "store"): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (this.apiKey && this.apiKey.length > 10 && this.apiKey !== "test-key") {
      try {
        return await this.embedBatchViaApi(texts);
      } catch (e) {
        if (!this._fallbackWarned) {
          console.error("[AgentMemory] Batch embedding API failed, using hash fallback:", (e as Error).message?.slice(0, 80));
          this._fallbackWarned = true;
        }
      }
    }
    return texts.map((t) => embedHash(t, this.dim));
  }

  private async embedViaApi(text: string): Promise<number[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      return await this.embedOpenAI(text, controller.signal, this.model);
    } finally {
      clearTimeout(timer);
    }
  }

  private async embedBatchViaApi(texts: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
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

// ── n-gram hash fallback ────────────────────────────────────────────

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
