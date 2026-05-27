import type { FragmentationInput, FragmentationOutput, Channel, SignalSource, Fragment } from "../types.js";
import { v4 as uuid } from "uuid";
import OpenAI from "openai";

const FRAGMENT_PROMPT = `你是记忆提取专家。分析以下对话，严格按 JSON 数组格式输出记忆碎片。

### 核心原则：四通道强制覆盖

对话中同时存在 WHAT（内容）、WHERE（场景）、WHO（人物）、FEEL（反馈）四类信息。
你的任务不是"选最重要的那个"——是**把每类信息都提取出来**。

### 通道判定规则

**WHAT — 实质内容**（必须提取）
- 决策、方案、需求、背景、约束、技术细节
- 任何有实质信息内容的对话都应产生 WHAT 碎片

**WHERE — 场景/环境**（有信息时必须提取，不可跳过）
- 文件路径（/src/auth/login.ts, D:/project/...）
- 项目名称、模块名称、数据库表名
- 工具/平台（VSCode, Claude Code, GitHub, Docker）
- 时间节点（deadline、版本号、里程碑）
- ⚠️ 如果原文提到了任何文件、项目、工具、路径 → 必须产生 WHERE 碎片

**WHO — 人物/角色**（有信息时必须提取，不可跳过）
- 说话人身份（用户、PM、后端工程师）
- 协作关系（谁负责什么、向谁汇报）
- 提到的具体人或团队
- ⚠️ 如果原文提到了任何角色、人名、协作关系 → 必须产生 WHO 碎片

**FEEL — 用户对Agent行为的情绪反馈**（精确判据）
- 纠正(80)：用户指出Agent犯了具体错误并给出正确方向
- 挫败(90)：用户对Agent行为表达不满、失望、不耐烦
- 紧迫(50)：用户要求优先或加速处理
- 确认(30)：用户明确认可Agent的工作方向或结果
- ⚠️ 以下不是FEEL，应归入WHAT：陈述观点、描述项目问题（不是指责Agent）、纠正事实而非纠正Agent行为

判断方法：问自己"这句话是针对Agent行为/工作方式的吗？" 不是 → WHAT。是 → 判断FEEL子类。

### 输出格式

每条碎片包含（所有字段必填，不可省略）：
{
  "channel": "WHAT"|"FEEL"|"WHO"|"WHERE",
  "label": "≤50字压缩描述",
  "weight": 0-255,
  "summary": "≤50字完整碎片文本",
  "linkedTo": [],
  "is_decision": true/false,
  "is_todo": true/false,
  "is_preference": true/false
}

weight 规则：
- WHAT / WHO / WHERE：默认 10
- FEEL：按上述判据（纠正80/挫败90/紧迫50/确认30）

is_decision / is_todo / is_preference 三者互斥（至多一个为true）。
纯事实碎片可全部为 false。

### 示例（好的输出）

对话: "我要在 D:/project/src/auth.ts 里把 JWT 换成 RS256。后端老张说这样更安全。"
输出:
[
  {"channel":"WHAT","label":"JWT换RS256","weight":10,"summary":"决定将auth.ts中的JWT替换为RS256","linkedTo":[1,2],"is_decision":true,"is_todo":true,"is_preference":false},
  {"channel":"WHERE","label":"auth.ts文件","weight":10,"summary":"涉及文件 D:/project/src/auth.ts","linkedTo":[0],"is_decision":false,"is_todo":false,"is_preference":false},
  {"channel":"WHO","label":"后端老张","weight":10,"summary":"老张（后端）建议RS256更安全","linkedTo":[0],"is_decision":false,"is_todo":false,"is_preference":false}
]
↑ 注意：一条对话产生了 WHAT + WHERE + WHO 三条碎片。这是正确的。

### 示例（坏的输出——缺少通道）

对话: "在 D:/project/src/auth.ts 把 JWT 换成 RS256，后端老张说更安全"
输出: [{"channel":"WHAT","label":"JWT换RS256",...}]
↑ 错误：漏掉了 WHERE（auth.ts文件路径）和 WHO（老张）。

### 自检清单（输出前逐项确认）

1. 对话中提到了文件/项目/工具？ → 有 WHERE 碎片吗？
2. 对话中提到了人/角色/团队？ → 有 WHO 碎片吗？
3. 用户是否在回应/评价Agent的行为？ → 有 FEEL 碎片吗？
4. 每个 channel 的 summary 是否从对话中直接提取（不是臆造）？

丢弃：纯闲聊、无实质确认（"好的""知道了"）、重复内容。
如果某对话段不产生任何碎片，跳过。

输入对话：
{transcript}

输出：`;

export function buildFragmentationPrompt(transcript: string): string {
  return FRAGMENT_PROMPT.replace("{transcript}", transcript);
}

interface RawFragment {
  channel: string;
  label: string;
  weight: number;
  linkedTo: number[];
  summary: string;
  is_decision?: boolean;
  is_todo?: boolean;
  is_preference?: boolean;
}

// Bracket-depth-aware JSON array extraction — handles nested arrays (linkedTo: [1])
// without the ambiguity of greedy/non-greedy regex.
function extractFirstJsonArray(raw: string): string | null {
  const start = raw.indexOf("[");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === "[") depth++;
    else if (raw[i] === "]") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function validateChannelBalance(fragments: RawFragment[], sessionId: string): void {
  let w = 0, f = 0, h = 0, r = 0;
  for (const frag of fragments) {
    switch (frag.channel) {
      case "WHAT": w++; break;
      case "FEEL": f++; break;
      case "WHO": h++; break;
      case "WHERE": r++; break;
    }
  }
  const total = fragments.length;
  if (total === 0) return;

  const whatPct = w / total;
  const wherePct = r / total;
  const whoPct = h / total;

  if (whatPct > 0.80 && total >= 3) {
    console.error(`[AgentMemory] ⚠️ 通道偏见检测: WHAT占${(whatPct*100).toFixed(0)}% (${total}条碎片) session=${sessionId.slice(0,8)} — 可能缺少WHERE/WHO提取`);
  }
  if (wherePct === 0 && total >= 3) {
    console.error(`[AgentMemory] ⚠️ WHERE通道为空 (${total}条碎片) session=${sessionId.slice(0,8)} — 检查对话中是否有文件/项目/工具信息被遗漏`);
  }
  if (whoPct === 0 && total >= 3) {
    console.error(`[AgentMemory] ⚠️ WHO通道为空 (${total}条碎片) session=${sessionId.slice(0,8)} — 检查对话中是否有人物/角色信息被遗漏`);
  }
}

export function parseFragmentationResponse(
  raw: string,
  sessionId: string,
  projectId: string
): FragmentationOutput {
  let parsed: RawFragment[];
  try {
    const jsonMatch = extractFirstJsonArray(raw);
    parsed = jsonMatch ? JSON.parse(jsonMatch) : [];
  } catch {
    return { fragments: [], summary: "" };
  }

  validateChannelBalance(parsed, sessionId);

  const validChannels = new Set(["WHAT", "FEEL", "WHO", "WHERE"]);
  const fragments = parsed
    .filter((r) => validChannels.has(r.channel) && r.label && r.summary)
    .map((r) => {
      let subtype: "decision" | "todo" | "preference" | null = null;
      if (r.is_decision) subtype = "decision";
      else if (r.is_todo) subtype = "todo";
      else if (r.is_preference) subtype = "preference";
      return {
        id: uuid(),
        sessionId,
        projectId,
        anchors: [{
          channel: r.channel as Channel,
          label: r.label.slice(0, 50),
          weight: Math.min(255, Math.max(0, r.weight | 0)),
          source: (r.channel === "FEEL" ? "behavior" : "clustering") as SignalSource,
          timestamp: Date.now(),
        }],
        linkedIds: [] as string[],
        linkedCount: r.linkedTo?.length ?? 0,
        summary: r.summary.slice(0, 50),
        createdAt: Date.now(),
        subtype,
      };
    });

  const summary = fragments
    .filter((f) => f.anchors[0]?.channel === "WHAT")
    .map((f) => f.summary)
    .join("; ");

  return { fragments, summary };
}

export function resolveLinks(
  fragments: FragmentationOutput["fragments"],
  rawFragments: RawFragment[]
): void {
  const idMap: string[] = [];
  for (const f of fragments) {
    idMap.push(f.id);
  }
  for (let i = 0; i < rawFragments.length; i++) {
    const raw = rawFragments[i];
    if (!raw) continue;
    const links = raw.linkedTo ?? [];
    const sourceId = idMap[i];
    if (!sourceId) continue;
    for (const targetIdx of links) {
      const targetId = idMap[targetIdx];
      if (targetId && targetId !== sourceId) {
        const f = fragments.find((x) => x.id === sourceId);
        if (f && !f.linkedIds.includes(targetId)) {
          f.linkedIds.push(targetId);
        }
      }
    }
  }
  for (const f of fragments) {
    f.linkedCount = f.linkedIds.length;
  }
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface FragmentResult {
  output: FragmentationOutput;
  usage: TokenUsage | undefined;
}

export async function fragmentTranscript(
  input: FragmentationInput,
  apiKey: string,
  model: string,
  baseURL: string = "https://api.deepseek.com"
): Promise<FragmentResult> {
  const prompt = buildFragmentationPrompt(input.transcript);

  // Normalize baseURL: OpenAI client expects /v1 suffix
  const normalizedURL = baseURL.endsWith("/v1") ? baseURL : `${baseURL}/v1`;
  const client = new OpenAI({ apiKey, baseURL: normalizedURL });
  const response = await client.chat.completions.create({
    model,
    max_tokens: 4096,
    temperature: 0.3,
    messages: [{ role: "user", content: prompt }],
  });

  const usage: TokenUsage | undefined = response.usage ? {
    promptTokens: response.usage.prompt_tokens,
    completionTokens: response.usage.completion_tokens,
    totalTokens: response.usage.total_tokens,
  } : undefined;

  let content = response.choices[0]?.message?.content ?? "";
  if (!content) return { output: { fragments: [], summary: "" }, usage };

  // Strip MiniMax <think>...</think> wrapper
  content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

  const output = parseFragmentationResponse(content, input.sessionId, input.projectId);

  // Re-parse raw JSON for link resolution
  let rawFragments: RawFragment[];
  try {
    const jsonStr = extractFirstJsonArray(content);
    rawFragments = jsonStr ? JSON.parse(jsonStr) : [];
  } catch {
    rawFragments = [];
  }

  resolveLinks(output.fragments, rawFragments);
  return { output, usage };
}
