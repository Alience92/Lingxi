// Small model service: Ollama REST API wrapper
// Default model: qwen2.5:0.5b (will fall back to qwen2.5:7b if available)

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

let _defaultModel = process.env.SMALLMODEL_NAME || "";

export async function getDefaultModel(): Promise<string> {
  if (_defaultModel) return _defaultModel;

  // Prefer 7b for accuracy (0.5b fails FEEL entirely — 0% accuracy), fall back to any qwen
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    const data = await res.json() as { models?: Array<{ name: string }> };
    const models = (data.models ?? []).map(m => m.name);
    const chatModels = models.filter(m => !m.includes("embed") && !m.includes("vision") && !m.includes("llava") && !m.includes("bakllava"));
    _defaultModel = chatModels.find(m => m.includes("7b"))
      ?? chatModels.find(m => m.includes("qwen"))
      ?? chatModels[0]
      ?? "qwen2.5:7b";
    return _defaultModel;
  } catch {
    _defaultModel = "qwen2.5:7b";
    return _defaultModel;
  }
}

export interface ClassifyOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export async function classify(
  text: string,
  options?: ClassifyOptions
): Promise<string> {
  const model = options?.model ?? await getDefaultModel();

  const prompt = `分类通道(只输出WHAT/FEEL/WHO/WHERE中的一个):
WHAT=实质决策/方案/需求 FEEL=用户对AI的情绪反馈 WHO=涉及人物/角色 WHERE=文件/项目/工具

"${text.slice(0, 300)}"
通道:`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: {
        temperature: options?.temperature ?? 0.1,
        num_predict: options?.maxTokens ?? 8,
      },
    }),
  });

  const data = await res.json() as { response?: string; error?: string };
  if (data.error) throw new Error(`Ollama: ${data.error}`);
  return (data.response ?? "").trim().toUpperCase();
  } finally { clearTimeout(timer); }
}

export async function pullModel(name: string): Promise<boolean> {
  console.error(`[SmallModel] Pulling ${name}...`);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, stream: false }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function isOllamaRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    return res.ok;
  } catch {
    return false;
  }
}
