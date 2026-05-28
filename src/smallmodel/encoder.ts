// Two-stage encoder classifier: ONNX inference with JS tokenizer.
// Stage 1: FEEL vs NON-FEEL → Stage 2: WHAT vs WHERE vs WHO.
// No Python, no Ollama — everything runs in-process via ONNX Runtime.
import * as ort from "onnxruntime-node";
import * as fs from "fs";
import * as path from "path";

const MAX_LEN = 128;
const MODEL_DIR = process.env.AGENTMEMORY_MODEL_DIR
  || path.join(import.meta.dirname, "../../tools/two-stage-output");

// ── WordPiece Tokenizer ──────────────────────────────────────
let _vocab: Map<string, number> | null = null;
let _vocabInv: Map<number, string> | null = null;

function loadVocab(): Map<string, number> {
  if (_vocab) return _vocab;
  _vocab = new Map();
  _vocabInv = new Map();
  const txt = fs.readFileSync(path.join(MODEL_DIR, "tokenizer", "vocab.txt"), "utf-8");
  const lines = txt.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const token = lines[i]!.trim();
    if (token) { _vocab.set(token, i); _vocabInv!.set(i, token); }
  }
  return _vocab;
}

function basicTokenize(text: string): string[] {
  // Split Chinese chars individually, keep alphanumeric runs together
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

function tokenize(text: string): { input_ids: Int32Array; attention_mask: Int32Array } {
  const vocab = loadVocab();

  // Basic tokenization
  const basicTokens = basicTokenize(text.slice(0, 256));

  // WordPiece
  const wpTokens: string[] = ["[CLS]"];
  for (const tok of basicTokens) {
    if (tok === "[UNK]") { wpTokens.push("[UNK]"); continue; }
    for (const sub of wordPiece(tok, vocab)) {
      if (wpTokens.length >= MAX_LEN - 1) break;
      wpTokens.push(sub);
    }
    if (wpTokens.length >= MAX_LEN - 1) break;
  }
  wpTokens.push("[SEP]");

  // Convert to IDs
  const ids = new Int32Array(MAX_LEN);
  const mask = new Int32Array(MAX_LEN);
  for (let i = 0; i < Math.min(wpTokens.length, MAX_LEN); i++) {
    ids[i] = vocab.get(wpTokens[i]!) ?? vocab.get("[UNK]") ?? 100;
    mask[i] = 1;
  }

  return { input_ids: ids, attention_mask: mask };
}

// ── ONNX Models ──────────────────────────────────────────────
let _sessionS1: ort.InferenceSession | null = null;
let _sessionS2: ort.InferenceSession | null = null;

async function getS1(): Promise<ort.InferenceSession> {
  if (!_sessionS1) _sessionS1 = await ort.InferenceSession.create(path.join(MODEL_DIR, "stage1.onnx"));
  return _sessionS1;
}
async function getS2(): Promise<ort.InferenceSession> {
  if (!_sessionS2) _sessionS2 = await ort.InferenceSession.create(path.join(MODEL_DIR, "stage2.onnx"));
  return _sessionS2;
}

// ── Public API ────────────────────────────────────────────────
export interface EncoderResult {
  label: "WHAT" | "FEEL" | "WHERE" | "WHO";
  confidence: number;
  stage: "s1" | "s2";
  probs?: Record<string, number>;
}

export async function classify(text: string): Promise<EncoderResult> {
  const { input_ids, attention_mask } = tokenize(text);

  // ONNX expects BigInt64Array for int64 inputs, or we can use Int32Array
  // Convert to the format onnxruntime expects
  const feed = {
    input_ids: new ort.Tensor("int64", BigInt64Array.from(Array.from(input_ids).map(BigInt)), [1, MAX_LEN]),
    attention_mask: new ort.Tensor("int64", BigInt64Array.from(Array.from(attention_mask).map(BigInt)), [1, MAX_LEN]),
  };

  // Stage 1: FEEL vs NON-FEEL
  const s1 = await getS1();
  const s1Out = await s1.run(feed);
  const s1Logits = (s1Out.logits!.data) as Float32Array;
  if (s1Logits.length < 2) throw new Error("Stage 1 output has unexpected shape");
  // Assumes s1Logits[0]=NON-FEEL, s1Logits[1]=FEEL (matching training label order)
  const feelProb = 1 / (1 + Math.exp(-(s1Logits[1] ?? 0) + (s1Logits[0] ?? 0)));

  if (feelProb > 0.5) {
    return { label: "FEEL", confidence: Math.round(feelProb * 10000) / 10000, stage: "s1" };
  }

  // Stage 2: WHAT vs WHERE vs WHO
  const s2 = await getS2();
  const s2Out = await s2.run(feed);
  const s2Logits = (s2Out.logits!.data) as Float32Array;
  if (s2Logits.length < 3) throw new Error("Stage 2 output has unexpected shape");
  // Softmax
  const s2_0 = s2Logits[0] ?? 0, s2_1 = s2Logits[1] ?? 0, s2_2 = s2Logits[2] ?? 0;
  const maxLogit = Math.max(s2_0, s2_1, s2_2);
  const exps = [Math.exp(s2_0 - maxLogit), Math.exp(s2_1 - maxLogit), Math.exp(s2_2 - maxLogit)];
  const sum = exps[0]! + exps[1]! + exps[2]!;
  const p0 = exps[0]! / sum, p1 = exps[1]! / sum, p2 = exps[2]! / sum;
  const probs = [p0, p1, p2];


  // Guard against NaN/Infinity from corrupted model or degenerate input
  if (!isFinite(p0) || !isFinite(p1) || !isFinite(p2)) {
    return { label: "WHAT", confidence: 0, stage: "s2" };
  }

  const S2_LABELS: Array<"WHAT" | "WHERE" | "WHO"> = ["WHAT", "WHERE", "WHO"];
  const bestIdx = probs.indexOf(Math.max(p0, p1, p2));

  return {
    label: S2_LABELS[bestIdx]!,
    confidence: Math.round(probs[bestIdx]! * 10000) / 10000,
    stage: "s2",
    probs: { WHAT: Math.round(p0 * 10000) / 10000, WHERE: Math.round(p1 * 10000) / 10000, WHO: Math.round(p2 * 10000) / 10000 },
  };
}

export async function classifyBatch(texts: string[]): Promise<EncoderResult[]> {
  // Process in batches for efficiency
  const results: EncoderResult[] = [];
  for (const text of texts) {
    results.push(await classify(text));
  }
  return results;
}

// ── Resource cleanup ──────────────────────────────────────────
export async function dispose(): Promise<void> {
  if (_sessionS1) { await _sessionS1.release(); _sessionS1 = null; }
  if (_sessionS2) { await _sessionS2.release(); _sessionS2 = null; }
}

// ── Health check ─────────────────────────────────────────────
let _ready = false;
export async function ensureReady(): Promise<boolean> {
  if (_ready) return true;
  try {
    loadVocab();
    await getS1();
    await getS2();
    _ready = true;
    return true;
  } catch (e) {
    console.error("[Encoder] Init failed:", (e as Error).message?.slice(0, 80));
    return false;
  }
}
