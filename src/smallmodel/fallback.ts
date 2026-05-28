// LLM few-shot fallback for low-confidence encoder predictions.
// Only called when macbert-2stage confidence < 0.6 (~18% of samples).
// Uses 5 boundary examples targeting the main confusion pairs:
//   WHAT→WHERE (file paths), WHO→FEEL (emotional role descriptions)

import OpenAI from "openai";

const FALLBACK_PROMPT = `分类以下文本到四个通道之一：WHAT/FEEL/WHERE/WHO。

WHAT: 实质内容（决策、方案、需求、技术细节、观点陈述）
FEEL: 用户对AI行为的情绪反馈（纠正错误、表达不满、认可工作、要求加速）
WHERE: 场景/环境（文件路径、项目名、工具名、时间节点）
WHO: 人物/角色（身份、协作关系、提到的具体人）

规则：
- 提到文件路径/项目名/工具 → WHERE
- 用户评价/纠正/认可AI的行为 → FEEL
- 陈述自己的偏好或观点（不是针对AI） → WHAT
- 提到人/角色/团队 → WHO

示例：
"AIGC流水线分了三个层次：基础层、策略层、表现层" → WHAT
"你又把我的注释删了，那些注释是给后面维护的人看的" → FEEL
"在 D:/GodotProject/Scripts/Core/GameState.cs 里加个字段" → WHERE
"后端老张建议用RS256，比HS256更安全" → WHO
"选择pandas处理数据报表，原生循环性能太差受不了" → WHAT

仅输出JSON：{"label":"WHAT|FEEL|WHERE|WHO","confidence":0.0-1.0}

文本：{text}`;

export interface FallbackResult {
  label: "WHAT" | "FEEL" | "WHERE" | "WHO";
  confidence: number;
  source: "llm-fallback";
}

export async function classifyFallback(
  text: string,
  apiKey: string,
  baseURL: string = "https://api.deepseek.com",
): Promise<FallbackResult> {
  const normalizedURL = baseURL.endsWith("/v1") ? baseURL : `${baseURL}/v1`;
  const client = new OpenAI({ apiKey, baseURL: normalizedURL });

  const response = await client.chat.completions.create({
    model: "deepseek-chat",
    max_tokens: 80,
    temperature: 0,
    messages: [{ role: "user", content: FALLBACK_PROMPT.replace("{text}", text) }],
  });

  const content = (response.choices[0]?.message?.content ?? "").trim();

  // Parse JSON response
  try {
    const json = JSON.parse(content.replace(/```json|```/g, "").trim());
    const label = json.label?.toUpperCase();
    if (["WHAT", "FEEL", "WHERE", "WHO"].includes(label)) {
      return {
        label: label as "WHAT" | "FEEL" | "WHERE" | "WHO",
        confidence: typeof json.confidence === "number" ? json.confidence : 0.8,
        source: "llm-fallback",
      };
    }
  } catch {}

  // Fallback: extract label from text
  const match = content.match(/WHAT|FEEL|WHERE|WHO/);
  return {
    label: (match?.[0] ?? "WHAT") as "WHAT" | "FEEL" | "WHERE" | "WHO",
    confidence: 0.5,
    source: "llm-fallback",
  };
}
