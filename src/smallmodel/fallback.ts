// LLM few-shot fallback for low-confidence encoder predictions.
// Only called when macbert-2stage confidence < 0.6 (~18% of samples).
// Prompt v2 — per GPT review: main-semantic-first, evaluation-target awareness,
// explicit "implicit FEEL" and "pseudo-FEEL" boundary examples.

import OpenAI from "openai";

const FALLBACK_PROMPT = `将文本分类到一个主通道：WHAT / FEEL / WHERE / WHO。

定义：
- WHAT：核心信息是决策、方案、需求、技术结论、事实判断、工作内容本身
- FEEL：核心信息是用户对 AI 工作方式或结果的反馈，包括纠正、否定、认可、催促、边界提醒
- WHERE：核心信息是上下文定位信息，如文件、项目、模块、路径、时间点、工具环境
- WHO：核心信息是人物、角色、协作关系、谁对谁说了什么

判定原则：
1. 先看"主语义"，不要只看有没有路径、人名、评价词
2. 如果文本在评价系统、代码、性能、数据、方案本身，归 WHAT
3. 如果文本在评价 AI 的行为、结果、节奏、理解是否到位，归 FEEL
4. 文件路径、项目名、工具名只有在"定位上下文"是主语义时才归 WHERE
5. 提到用户、同事、团队，只有在"谁/角色关系"是主语义时才归 WHO

容易混淆的边界：
- "缓存命中率92%，瓶颈在 search" → WHAT
- "你又把我的注释删了" → FEEL
- "在 src/core/retriever.ts 里改" → WHERE
- "后端老张建议改成 RS256" → WHO
- "整体运转正常，三个环节都触发了" → FEEL
- "用户认为 2-4 秒延迟可接受，同意开始实施" → FEEL
- "编导工具 1.0 功能完整但 UI 未翻新" → WHAT
- "这次终于对了，可以继续推进" → FEEL
- "性能从17s优化到1.4s，瓶颈在 I/O" → WHAT

仅输出 JSON：
{"label":"WHAT|FEEL|WHERE|WHO","confidence":0.0-1.0}

文本：{text}`;

export interface FallbackResult {
  label: "WHAT" | "FEEL" | "WHERE" | "WHO";
  confidence: number;
  source: "llm-fallback";
}

const _clientCache = new Map<string, OpenAI>();

function getClient(apiKey: string, baseURL: string): OpenAI {
  const key = apiKey + "::" + baseURL;
  if (!_clientCache.has(key)) {
    _clientCache.set(key, new OpenAI({ apiKey, baseURL }));
  }
  return _clientCache.get(key)!;
}

// Sanitize and wrap user text for prompt injection prevention
function sanitizeText(text: string): string {
  return text
    .replace(/[{}]/g, "")
    .replace(/```/g, "")
    .replace(/\\/g, "\\\\")
    .slice(0, 300);
}

export async function classifyFallback(
  text: string,
  apiKey: string,
  baseURL: string = "https://api.deepseek.com",
): Promise<FallbackResult> {
  const normalizedURL = baseURL.endsWith("/v1") ? baseURL : `${baseURL}/v1`;
  const client = getClient(apiKey, normalizedURL);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await client.chat.completions.create({
      model: "deepseek-chat",
      max_tokens: 80,
      temperature: 0,
      messages: [{ role: "user", content: FALLBACK_PROMPT.replace("{text}", sanitizeText(text)) }],
    }, { signal: controller.signal });

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

    // Fallback: extract label from text (find last channel word in response)
    const matches = content.match(/WHAT|FEEL|WHERE|WHO/g);
    const bestMatch = matches ? matches[matches.length - 1] : null;
    return {
      label: (bestMatch ?? "WHAT") as "WHAT" | "FEEL" | "WHERE" | "WHO",
      confidence: 0.3,
      source: "llm-fallback",
    };
  } finally {
    clearTimeout(timer);
  }
}
