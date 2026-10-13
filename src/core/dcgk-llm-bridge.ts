// 灵络 LLM Bridge — 补全闭环: 图不认识 → 查LLM → 解析 → 写入图 → 立即复用
// LLM does NOT enter the core loop. It is called once, as an external knowledge source.

import { upsertNode, upsertEdge } from "./dcgk-store.js";
import { addMemoryNode } from "./dcgk-engine.js";

const LLM_KEY = process.env.DEEPSEEK_API_KEY || "";
const LLM_BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const LLM_MODEL = "deepseek-chat";

interface LLMSubGoalResult {
  subGoals: string[];
  confidence: number;
  rawResponse: string;
}

/**
 * Query LLM to decompose an unknown part of a task into sub-goals.
 * Called ONLY when the graph has no matching template.
 */
export async function queryLLMForDecomposition(
  taskName: string,
  knownPart: string,
  unknownPart: string
): Promise<LLMSubGoalResult> {
  if (!LLM_KEY || LLM_KEY.length < 10) {
    // No LLM available — return unknown part as a single sub-goal
    return { subGoals: [unknownPart], confidence: 0.1, rawResponse: "LLM not available" };
  }

  const prompt = `你是一个任务规划助手。用户要完成"${taskName}"。
已知部分"${knownPart}"已有分解方案。
未知部分"${unknownPart}"没有现成模板。

请将"${unknownPart}"分解为2-4个具体的、可执行的子步骤。
只输出JSON数组，不要其他内容。
格式: ["步骤1", "步骤2", "步骤3"]`;

  try {
    const resp = await fetch(`${LLM_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_KEY}` },
      body: JSON.stringify({ model: LLM_MODEL, messages: [{ role: "user", content: prompt }], max_tokens: 200, temperature: 0 }),
    });

    if (!resp.ok) {
      return { subGoals: [unknownPart], confidence: 0.2, rawResponse: `HTTP ${resp.status}` };
    }

    const data = await resp.json() as { choices: Array<{ message: { content: string } }> };
    const raw = data.choices[0]?.message?.content?.trim() || `[]`;

    // Parse JSON array from LLM response
    let parsed: string[] = [];
    try {
      parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) parsed = [raw];
    } catch {
      // Try to extract list items if JSON parse fails
      parsed = raw.match(/[""]([^""]+)[""]/g)?.map(s => s.replace(/[""]/g, "")) || [unknownPart];
    }

    return {
      subGoals: parsed.length > 0 ? parsed : [unknownPart],
      confidence: 0.7,
      rawResponse: raw.slice(0, 200),
    };
  } catch (e) {
    return { subGoals: [unknownPart], confidence: 0.2, rawResponse: String(e).slice(0, 100) };
  }
}

/**
 * Complete the loop: query LLM for unknown part,
 * write results as REQUIRES edges, update in-memory graph.
 * Returns the full combined sub-goal list.
 */
export async function completeDecomposition(
  taskName: string,
  knownSubGoals: string[],
  unknownPart: string
): Promise<string[]> {
  console.log(`  [LLM-Bridge] Querying LLM for: "${unknownPart}" (part of "${taskName}")`);

  const result = await queryLLMForDecomposition(taskName, knownSubGoals.join(", "), unknownPart);

  if (result.subGoals.length === 1 && result.subGoals[0] === unknownPart) {
    // LLM failed to decompose — return as-is (single unknown sub-goal)
    console.log(`  [LLM-Bridge] LLM could not decompose "${unknownPart}" — will retry later`);
    return [...knownSubGoals, unknownPart];
  }

  // 1. Create task node for this specific task
  const now = Date.now();
  upsertNode({ id: taskName, label: taskName, activation: 0, confidence: 0.3, plasticity: 0.6, last_updated: now });
  addMemoryNode(taskName, taskName);

  // 2. Add known sub-goals as REQUIRES edges
  for (let i = 0; i < knownSubGoals.length; i++) {
    upsertEdge({ source_id: taskName, target_id: knownSubGoals[i]!, weight: 0.8, eligibility_trace: 0, etype: "requires", tag_plastic: 1, last_updated: now });
  }

  // 3. Add LLM-generated sub-goals as REQUIRES edges
  const llmSubGoals = result.subGoals;
  for (let i = 0; i < llmSubGoals.length; i++) {
    const sg = llmSubGoals[i]!;
    // Ensure node exists
    upsertNode({ id: sg, label: sg, activation: 0, confidence: result.confidence, plasticity: 0.7, last_updated: now });
    addMemoryNode(sg, sg);
    upsertEdge({ source_id: taskName, target_id: sg, weight: 0.7 - i * 0.1, eligibility_trace: 0, etype: "requires", tag_plastic: 1, last_updated: now });
  }

  // 4. Sequential PRECEDES edges for LLM steps
  for (let i = 0; i < llmSubGoals.length - 1; i++) {
    upsertEdge({ source_id: llmSubGoals[i]!, target_id: llmSubGoals[i+1]!, weight: 0.8, eligibility_trace: 0, etype: "precedes", tag_plastic: 1, last_updated: now });
  }

  console.log(`  [LLM-Bridge] Learned: ${knownSubGoals.length} known + ${llmSubGoals.length} new sub-goals`);
  console.log(`  [LLM-Bridge] LLM confidence: ${result.confidence.toFixed(2)}, response: "${result.rawResponse.slice(0, 80)}"`);

  // Return combined
  return [...knownSubGoals, ...llmSubGoals];
}
