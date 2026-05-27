// Small model service entry: model loading + inference
import { getLlama, LlamaChatSession, type LlamaModel, type LlamaContext } from "node-llama-cpp";
import * as path from "node:path";
import * as fs from "node:fs";

let _model: LlamaModel | null = null;
let _context: LlamaContext | null = null;

const DEFAULT_MODEL_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || ".",
  ".cache", "node-llama-cpp", "models"
);

export async function loadModel(modelPath?: string): Promise<{ model: LlamaModel; context: LlamaContext }> {
  if (_model && _context) return { model: _model, context: _context };

  const llama = await getLlama();
  const resolved = modelPath ?? findModel(DEFAULT_MODEL_DIR);
  if (!resolved) {
    throw new Error(`No GGUF model found. Download one with: npx node-llama-cpp pull <model-url>\nModels directory: ${DEFAULT_MODEL_DIR}`);
  }

  console.error(`[SmallModel] Loading: ${resolved}`);
  _model = await llama.loadModel({ modelPath: resolved });
  _context = await _model.createContext({ contextSize: 2048 });
  console.error(`[SmallModel] Model loaded (${_model.trainContextSize ?? "unknown"} ctx)`);
  return { model: _model, context: _context };
}

function findModel(dir: string): string | null {
  try {
    const files = fs.readdirSync(dir, { recursive: true }) as string[];
    const ggufs = files.filter(f => f.endsWith(".gguf"));
    // Prefer smaller models for CPU inference
    ggufs.sort((a, b) => a.length - b.length);
    if (ggufs.length > 0) return path.join(dir, ggufs[0]!);
  } catch {}
  return null;
}

export async function classify(
  text: string,
  context: LlamaContext,
  options?: { temperature?: number; maxTokens?: number }
): Promise<string> {
  const session = new LlamaChatSession({
    contextSequence: context.getSequence(),
    systemPrompt: "你是一个精确的文本分类器。只输出分类标签，不要解释。",
  });

  const prompt = `分类通道(只输出WHAT/FEEL/WHO/WHERE中的一个):
WHAT=实质决策/方案/需求 FEEL=用户对AI的情绪反馈 WHO=涉及人物/角色 WHERE=文件/项目/工具

"${text.slice(0, 300)}"
通道:`;

  const response = await session.prompt(prompt, {
    temperature: options?.temperature ?? 0.1,
    maxTokens: options?.maxTokens ?? 8,
  });

  return response.trim().toUpperCase();
}

export async function unloadModel(): Promise<void> {
  if (_context) { await _context.dispose(); _context = null; }
  if (_model) { await _model.dispose(); _model = null; }
}
