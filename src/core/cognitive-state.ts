// cognitive-state.ts — 认知内化句向量（cognitive_v5, chinese-macbert-base）
//
// 检索语义层：query → 1024 维 state_vector → cosine 精筛候选碎片。
// 替代 bge-m3（去 API/Ollama 依赖），全本地 ONNX 推理。
// tokenizer 与灵眸（lingmou）同源（chinese-macbert-base 的 WordPiece vocab）。
//
// 模型: cognitive_v5.onnx（CLS + contrastive 训练, val_cos 0.888）
// 路径: 由 resolveModelPath() 多候选发现（见 config.ts），不再写死绝对路径。

import * as ort from "onnxruntime-node";
import * as fs from "node:fs";
import { resolveModelPath } from "../config.js";

const MAX_LEN = 128;

export const COGNITIVE_DIM = 1024;

// 进程内一次性解析。找不到时得到 null，而非抛错 —— 由调用方诚实降级（P4.2）。
const _resolved = resolveModelPath();
const MODEL_PATH: string | null = _resolved.cognitiveModelPath;
const VOCAB_PATH: string | null = _resolved.vocabPath;

/** 模型/vocab 的发现结果与告警，供 `lingxi doctor` 与启动日志展示。 */
export function getModelResolution() {
  return _resolved;
}

// 最近一次失败原因。语义层不允许静默降级：embedder 会把它带进 status().errors。
let _lastError: string | null = null;

/** 最近一次编码失败的原因；成功一次即清空。 */
export function getCognitiveLastError(): string | null {
  return _lastError;
}

// ── Tokenizer (WordPiece, chinese-macbert-base) ───────────────────────

let _vocab: Map<string, number> | null = null;

function loadVocab(): Map<string, number> {
  if (_vocab) return _vocab;
  if (!VOCAB_PATH) {
    // 旧实现用 `|| ""` 兜底 → path.join("", ...) 得到相对路径 → 依赖 cwd → ENOENT。
    // 现在路径由 resolveModelPath() 显式解析，缺失时给出可操作的指引。
    throw new Error(
      "tokenizer/vocab.txt 未找到：请设置 LINGXI_MODEL_DIR，或将 vocab.txt 放到 ~/.lingxi/models/tokenizer/",
    );
  }
  const txt = fs.readFileSync(VOCAB_PATH, "utf-8");
  _vocab = new Map();
  txt.split("\n").forEach((line, i) => {
    const t = line.trim();
    if (t) _vocab!.set(t, i);
  });
  return _vocab;
}

function basicTokenize(text: string): string[] {
  const tokens: string[] = [];
  let buf = "";
  for (const ch of text) {
    if (/[一-鿿㐀-䶿]/.test(ch)) {
      if (buf) { tokens.push(buf.toLowerCase()); buf = ""; }
      tokens.push(ch);
    } else if (/[a-zA-Z0-9]/.test(ch)) {
      buf += ch;
    } else {
      if (buf) { tokens.push(buf.toLowerCase()); buf = ""; }
      if (ch.trim()) tokens.push(ch);
    }
  }
  if (buf) tokens.push(buf.toLowerCase());
  return tokens;
}

function wordPiece(token: string, vocab: Map<string, number>): string[] {
  if (vocab.has(token)) return [token];
  const subwords: string[] = [];
  let remaining = token;
  while (remaining.length > 0) {
    let found = false;
    for (let end = remaining.length; end > 0; end--) {
      const prefix = (subwords.length === 0 ? "" : "##") + remaining.slice(0, end);
      if (vocab.has(prefix)) {
        subwords.push(prefix);
        remaining = remaining.slice(end);
        found = true;
        break;
      }
    }
    if (!found) { subwords.push("[UNK]"); break; }
  }
  return subwords;
}

function tokenize(text: string): { ids: Int32Array; mask: Int32Array } {
  const vocab = loadVocab();
  const basic = basicTokenize(text.slice(0, 256));
  const wp: string[] = ["[CLS]"];
  for (const tok of basic) {
    if (tok === "[UNK]") { wp.push("[UNK]"); continue; }
    for (const sub of wordPiece(tok, vocab)) {
      if (wp.length >= MAX_LEN - 1) break;
      wp.push(sub);
    }
    if (wp.length >= MAX_LEN - 1) break;
  }
  wp.push("[SEP]");
  const ids = new Int32Array(MAX_LEN);
  const mask = new Int32Array(MAX_LEN);
  for (let i = 0; i < Math.min(wp.length, MAX_LEN); i++) {
    ids[i] = vocab.get(wp[i]!) ?? vocab.get("[UNK]") ?? 100;
    mask[i] = 1;
  }
  return { ids, mask };
}

// ── ONNX session ───────────────────────────────────────────────────────

let _session: ort.InferenceSession | null = null;
let _ready = false;
let _modelPresent: boolean | null = null;

async function getSession(): Promise<ort.InferenceSession> {
  if (!_session) {
    if (!MODEL_PATH) {
      throw new Error(
        "cognitive 模型未找到：请设置 LINGXI_MODEL_DIR / COGNITIVE_MODEL_PATH，或将模型放到 ~/.lingxi/models/",
      );
    }
    _session = await ort.InferenceSession.create(MODEL_PATH);
  }
  return _session;
}

/** 同步检查模型文件是否存在（结果已由 resolveModelPath 判定，不触发加载）。 */
export function isCognitiveModelPresent(): boolean {
  if (_modelPresent === null) {
    try { _modelPresent = !!MODEL_PATH && fs.existsSync(MODEL_PATH); } catch { _modelPresent = false; }
  }
  return _modelPresent;
}

/** 模型就绪检查：文件存在 + 可加载。 */
export async function isCognitiveReady(): Promise<boolean> {
  if (_ready) return true;
  try {
    if (!isCognitiveModelPresent()) return false;
    await getSession();
    _ready = true;
    _modelPresent = true;
    _lastError = null;
    return true;
  } catch (e) {
    _lastError = e instanceof Error ? e.message : String(e);
    return false;
  }
}

/** 编码文本 → 1024 维归一化句向量。失败返回 null（调用方降级）。 */
export async function encodeCognitiveState(query: string): Promise<number[] | null> {
  try {
    const { ids, mask } = tokenize(query);
    const session = await getSession();
    const feed = {
      input_ids: new ort.Tensor("int64", BigInt64Array.from(Array.from(ids).map(BigInt)), [1, MAX_LEN]),
      attention_mask: new ort.Tensor("int64", BigInt64Array.from(Array.from(mask).map(BigInt)), [1, MAX_LEN]),
    };
    const out = await session.run(feed);
    const data = out.state_vector?.data;
    if (!data) { _lastError = "模型输出缺少 state_vector"; return null; }
    const vec = Array.from(data as Float32Array);
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    _lastError = null;
    return norm === 0 ? vec : vec.map((v) => v / norm);
  } catch (e) {
    _lastError = e instanceof Error ? e.message : String(e);
    return null;
  }
}

/** 批量编码（用于碎片向量预计算）。单条失败返回 null。 */
export async function encodeCognitiveBatch(texts: string[]): Promise<(number[] | null)[]> {
  const session = await getSession();
  const results: (number[] | null)[] = [];
  for (const text of texts) {
    try {
      const { ids, mask } = tokenize(text);
      const feed = {
        input_ids: new ort.Tensor("int64", BigInt64Array.from(Array.from(ids).map(BigInt)), [1, MAX_LEN]),
        attention_mask: new ort.Tensor("int64", BigInt64Array.from(Array.from(mask).map(BigInt)), [1, MAX_LEN]),
      };
      const out = await session.run(feed);
      const data = out.state_vector?.data as Float32Array | undefined;
      if (!data) { _lastError = "模型输出缺少 state_vector"; results.push(null); continue; }
      const vec = Array.from(data);
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      _lastError = null;
      results.push(norm === 0 ? vec : vec.map((v) => v / norm));
    } catch (e) {
      _lastError = e instanceof Error ? e.message : String(e);
      results.push(null);
    }
  }
  return results;
}

/** 余弦相似度（两向量均已归一化时可简化为点积）。 */
export function cognitiveSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * cognitive 向量检索：encode query + 全碎片向量 cosine（替换 bge-m3 vectorSearch）。
 * 全表扫描（千级碎片 cosine <10ms）+ 单次 query encode（~70ms），全本地无 API。
 * vector 列需由 rebuild-cognitive-vectors 用 cognitive_v5 填充。
 */
export async function cognitiveVectorSearch(
  query: string,
  limit: number = 20,
  projectId?: string,
): Promise<Array<{ fragmentId: string; summary: string; score: number }>> {
  const qv = await encodeCognitiveState(query);
  if (!qv) return [];
  const { getDb } = await import("../db/connection.js");
  const db = getDb();
  const rows = db.prepare(
    "SELECT id, summary, vector FROM fragments WHERE vector IS NOT NULL AND vector_model = 'cognitive_v5'" +
      (projectId ? " AND project_id = ?" : "")
  ).all(...(projectId ? [projectId] : [])) as Array<{ id: string; summary: string; vector: Buffer | null }>;

  const scored: Array<{ fragmentId: string; summary: string; score: number }> = [];
  for (const r of rows) {
    if (!r.vector || r.vector.length < COGNITIVE_DIM * 4) continue;
    const v = new Array<number>(COGNITIVE_DIM);
    for (let i = 0; i < COGNITIVE_DIM; i++) v[i] = r.vector.readFloatLE(i * 4);
    const s = cognitiveSimilarity(qv, v);
    if (s > 0.45) scored.push({ fragmentId: r.id, summary: r.summary, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
