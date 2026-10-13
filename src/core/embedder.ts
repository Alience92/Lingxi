/**
 * embedder.ts — 语义嵌入层（唯一后端：cognitive_v5 本地 ONNX）
 *
 * 历史：旧版是 OpenAI-compatible API（默认指向 Ollama 127.0.0.1:11434）
 * 加 n-gram hash 回退的三路实现。已收敛为单一后端：
 * core/cognitive-state.ts 的 cognitive_v5 本地 ONNX 推理（1024 维，无网络）。
 *
 * 设计约定：
 * 1. 不再有 hash 回退。编码失败即抛错，由调用方决定降级 —— 避免静默
 *    产出无意义向量（旧版曾因此让 `整体层` 在坏数据上仍报 healthy）。
 * 2. model 常量 "cognitive_v5" 会作为 fragments.vector_model 落库（见
 *    db/repository.ts），必须与 cognitive-state.ts 的 cognitiveVectorSearch
 *    筛选条件保持一致，否则新碎片对语义召回不可见。
 * 3. cosineSimilarity 仍是纯数学工具，供 signal-channel / retriever 复用。
 */

import {
  encodeCognitiveState,
  encodeCognitiveBatch,
  isCognitiveModelPresent,
} from "./cognitive-state.js";

export const COGNITIVE_MODEL_NAME = "cognitive_v5";
export const COGNITIVE_DIM = 1024;

export type EmbedPurpose = "store" | "query";

// ── Singleton accessor ──────────────────────────────────────────────

let _currentEmbedder: Embedder | null = null;

export function setCurrentEmbedder(e: Embedder): void {
  _currentEmbedder = e;
}

export function getCurrentEmbedder(): Embedder {
  if (!_currentEmbedder) _currentEmbedder = new Embedder();
  return _currentEmbedder;
}

// ── Failure reporting ───────────────────────────────────────────────
// 语义层失败不允许静默：记录原因，供 system-controller 上报到 status().errors。

let _lastEmbedError: string | null = null;

/** 最近一次编码失败的原因；成功一次即清空。 */
export function getLastEmbedError(): string | null {
  return _lastEmbedError;
}

// ── Embedder ────────────────────────────────────────────────────────

export class Embedder {
  public readonly baseURL = "local:onnx";
  public readonly model = COGNITIVE_MODEL_NAME;
  public readonly dim = COGNITIVE_DIM;

  /** 编码失败后置位，让门控立即短路，不必重试到底。 */
  private _failed = false;

  /**
   * 语义层是否不可用。
   * 同步判定：模型文件缺失，或此前编码已失败。
   */
  isSemanticUnavailable(): boolean {
    return this._failed || !isCognitiveModelPresent();
  }

  /** @deprecated 语义已由 "是否只能用 hash" 变为 "语义层是否不可用"。
   *  请改用 isSemanticUnavailable()。 */
  isHashOnly(): boolean {
    return this.isSemanticUnavailable();
  }

  async embed(text: string, _purpose: EmbedPurpose = "store"): Promise<number[]> {
    let v: number[] | null;
    try {
      v = await encodeCognitiveState(text);
    } catch (e) {
      this._failed = true;
      _lastEmbedError = e instanceof Error ? e.message : String(e);
      throw e;
    }
    if (!v || v.length === 0) {
      this._failed = true;
      _lastEmbedError = "cognitive_v5 返回空向量（模型缺失或加载失败）";
      throw new Error("cognitive_v5 encode failed (model missing or unloadable)");
    }
    this._failed = false;
    _lastEmbedError = null;
    return v;
  }

  async embedBatch(texts: string[], _purpose: EmbedPurpose = "store"): Promise<number[][]> {
    if (texts.length === 0) return [];
    let vecs: (number[] | null)[];
    try {
      vecs = await encodeCognitiveBatch(texts);
    } catch (e) {
      this._failed = true;
      _lastEmbedError = e instanceof Error ? e.message : String(e);
      throw e;
    }
    const out: number[][] = [];
    for (const v of vecs) {
      if (!v || v.length === 0) {
        this._failed = true;
        _lastEmbedError = "cognitive_v5 返回空向量（模型缺失或加载失败）";
        throw new Error("cognitive_v5 encode failed (model missing or unloadable)");
      }
      out.push(v);
    }
    this._failed = false;
    _lastEmbedError = null;
    return out;
  }
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
