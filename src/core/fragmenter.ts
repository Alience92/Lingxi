import type { FragmentationInput, FragmentationOutput, Channel, SignalSource, Fragment } from "../types.js";
import { v4 as uuid } from "uuid";
import OpenAI from "openai";

const FRAGMENT_PROMPT = `将以下对话拆分为记忆碎片。对每段有实质内容的对话，输出JSON数组。

### 通道判别规则（重要：先判断类型，再选通道）

**FEEL通道 ≠ 用户表达了观点。FEEL = 用户对Agent的工作/行为表达了情绪反馈。**
判定FEEL的充要条件：用户的话直接回应Agent的行为、结果、错误、或工作方式，且包含情绪信号。

FEEL 具体判据（weight 赋值标准）：
- 纠正(80)：用户指出Agent犯了具体错误，且给出了正确方向。
  例："不是这样，你应该用A而不是B" / "你搞错了，之前说的不是这个意思"
- 挫败(90)：用户对结果/流程/Agent行为表达不满、失望、不耐烦。
  例："又来了""你怎么又忘了""我真的无语了""这个问题说了多少次了"
- 紧迫(50)：用户要求优先或加速处理某个事项。
  例："先做这个""这个比较急""别的不用管，先把这个修了"
- 忽略(40)：Agent提出了建议但用户跳过或选了另一个方向。
- 确认(30)：用户明确认可Agent的工作方向或结果。

**以下情况不是FEEL，应归入WHAT**：
- 用户陈述一个事实或观点（即使涉及情绪词汇如"烦""难"）→ WHAT
- 用户描述项目中的问题（不是指责Agent）→ WHAT
- 用户说"我之前/上次说的是X"（是纠正事实，不是纠正Agent）→ WHAT
- 用户对项目/代码/设计表达挫败（不是对Agent）→ WHAT

判断方法：问自己"这句话是针对Agent行为/工作的吗？" 不是 → WHAT。是 → 再判断哪个FEEL子类。

**WHAT通道**：记录所有实质信息——决策、需求、背景、约束、技术细节。
**WHO通道**：记录人际关系信息——提到具体人或团队时的角色、协作方式。
**WHERE通道**：记录场景/环境信息——在什么平台、用什么工具、什么时间节点。

每条碎片包含以下字段（所有字段均为必填，不可省略）：

- channel: "WHAT"|"FEEL"|"WHO"|"WHERE"
- label: ≤50字的压缩描述
- weight: 0-255的权重（WHAT/WHO/WHERE默认weight=10）
- summary: ≤50字的完整碎片文本
- linkedTo: 同时产生的其他碎片序号(0-based数组)，不关联的写[]

- is_decision: boolean 【必填】该片段是否包含架构/技术/产品决策。判据：说话人明确做出了选择或决定了方向。
  例 true → "决定用Redis替代Memcached""选了方案A不要方案B""定下来用React不用Vue"
  例 false → "Redis很快"（陈述事实）"可以考虑用Redis"（提议未定）

- is_todo: boolean 【必填】该片段是否包含待办事项或后续行动计划。判据：有明确的下一步动作。
  例 true → "下一步要写单元测试""明天更新文档""这个bug需要修""记得加日志"
  例 false → "测试通过了"（已完成）"代码有bug"（描述问题）

- is_preference: boolean 【必填】该片段是否表达了对工作方式、沟通风格或工具使用的个人偏好。判据：主观倾向而非客观事实。
  例 true → "我喜欢先看代码再看文档""别用ORM手写SQL更清晰""每次改完跑一遍测试再提交"
  例 false → "代码规范要求用Prettier"（客观规则）

三者互斥：每条碎片至多一个为true。纯事实/纯信息碎片可以全部为false。
⚠️ 每个字段都必须出现在JSON中，不可省略。省略会导致数据静默丢失。

丢弃：闲聊、纯确认（"好的""知道了"无实质内容）、重复内容、无信息过渡语。
如果某段对话不产生碎片，跳过。

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
