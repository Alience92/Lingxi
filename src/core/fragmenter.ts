import type { FragmentationInput, FragmentationOutput, Channel, SignalSource, Fragment } from "../types.js";
import { v4 as uuid } from "uuid";
import OpenAI from "openai";

const FRAGMENT_PROMPT = `将以下对话拆分为记忆碎片。对每段有实质内容的对话，输出JSON数组。

每条碎片包含：
- channel: "WHAT"|"FEEL"|"WHO"|"WHERE"
- label: ≤50字的压缩描述
- weight: 0-255的权重。FEEL通道基于信号：纠正=80, 挫败=90, 紧迫=50, 忽略=40, 确认=30, 默认=10
- linkedTo: 同时产生的其他碎片序号(0-based数组)，不关联的写[]
- summary: ≤50字的完整碎片文本

丢弃：闲聊、纯确认、重复内容、无信息过渡语。
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
}

export function parseFragmentationResponse(
  raw: string,
  sessionId: string,
  projectId: string
): FragmentationOutput {
  let parsed: RawFragment[];
  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
  } catch {
    return { fragments: [], summary: "" };
  }

  const validChannels = new Set(["WHAT", "FEEL", "WHO", "WHERE"]);
  const fragments = parsed
    .filter((r) => validChannels.has(r.channel) && r.label && r.summary)
    .map((r) => ({
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
    }));

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

export async function fragmentTranscript(
  input: FragmentationInput,
  apiKey: string,
  model: string,
  baseURL: string = "https://api.deepseek.com"
): Promise<FragmentationOutput> {
  const prompt = buildFragmentationPrompt(input.transcript);

  const client = new OpenAI({ apiKey, baseURL });
  const response = await client.chat.completions.create({
    model,
    max_tokens: 4096,
    temperature: 0.3,
    messages: [{ role: "user", content: prompt }],
  });

  const content = response.choices[0]?.message?.content ?? "";
  if (!content) return { fragments: [], summary: "" };

  const output = parseFragmentationResponse(content, input.sessionId, input.projectId);

  // Re-parse raw JSON for link resolution
  let rawFragments: RawFragment[];
  try {
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    rawFragments = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
  } catch {
    rawFragments = [];
  }

  resolveLinks(output.fragments, rawFragments);
  return output;
}
