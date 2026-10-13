/**
 * convert-v3-to-v4.ts — 将 v3 训练数据转换为 v4 格式（弱监督补充样本）
 *
 * 用法: cd D:\LingxiServer && node --import tsx src/tools/convert-v3-to-v4.ts
 */
import * as fs from "node:fs";

const V3_FILE = "D:/AshinMaterials/training/persona_training_v3_extreme.jsonl";
const V4_OUT = "D:/AshinMaterials/training/persona_training_v3_to_v4.jsonl";

const SCENARIO_TYPES = [
  "self_doubt", "loneliness", "farewell", "existential_questioning",
  "anger_injustice", "celebration", "criticism_received",
  "dream_creation", "aging_time", "death_loss",
];

const CONTRADICTION_KEYS = [
  "c1_understood_vs_hidden", "c2_selfdeprecation_vs_stubborn",
  "c3_fearforgetting_vs_acceptimpermanence", "c4_desirecloseness_vs_keepdistance",
  "c5_pursueeternity_vs_acceptfading", "c6_idealism_vs_commercialreality",
  "c7_publicduty_vs_privatewant", "c8_optimistdeclaration_vs_pessimistundercurrent",
  "c9_teamdependence_vs_coresolitude", "c10_desireberemembered_vs_acceptoblivion",
];

const SCENARIO_KEYWORDS: Record<string, string[]> = {
  self_doubt: ["怀疑", "不行", "失败", "做不到", "不够好", "错", "自卑", "没用"],
  loneliness: ["孤独", "一个人", "深夜", "寂寞", "没人", "想哭", "失眠", "空虚"],
  farewell: ["再见", "离别", "离开", "搬走", "再也见不到", "告别", "散了", "结束"],
  existential_questioning: ["意义", "活着", "为什么不", "人生", "存在", "迷茫", "不知道怎么办"],
  anger_injustice: ["凭什么", "不公平", "愤怒", "受不了", "恶心", "过分"],
  celebration: ["庆祝", "成功", "开心", "终于", "完成了", "拿到了", "感恩"],
  criticism_received: ["质疑", "批评", "商业化", "变了", "不认同"],
  dream_creation: ["创作", "梦想", "写歌", "灵感", "卡住", "瓶颈", "音乐"],
  aging_time: ["老了", "时间", "青春", "以前", "年纪", "岁月", "过得好快"],
  death_loss: ["死", "失去", "过世", "去世", "走了", "葬礼", "再也不", "天国"],
};

function detectScenario(context: string, traits: string[]): { key: string; idx: number } {
  const ctx = (context + " " + traits.join(" ")).toLowerCase();
  let bestKey = "self_doubt";
  let bestScore = 0;
  for (const [key, keywords] of Object.entries(SCENARIO_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) if (ctx.includes(kw)) score++;
    if (score > bestScore) { bestScore = score; bestKey = key; }
  }
  const idx = SCENARIO_TYPES.indexOf(bestKey);
  return { key: bestKey, idx: idx >= 0 ? idx : 0 };
}

function neutralContradictions(): Record<string, number> {
  const obj: Record<string, number> = {};
  for (const k of CONTRADICTION_KEYS) obj[k] = 0.0;
  return obj;
}

// Simple heuristic contradiction activation based on traits + context
function inferContradictions(
  scenario: string, traits: string[], warmth: number, humor: number
): Record<string, number> {
  const c = neutralContradictions();
  const ctx = traits.join(" ") + " " + scenario;

  // Self-deprecation pattern: low warmth in serious situations, traits suggest self-doubt
  if (ctx.includes("瓶颈") || ctx.includes("失败") || ctx.includes("自卑") || ctx.includes("自我怀疑")) {
    c.c2_selfdeprecation_vs_stubborn = warmth > 0.6 ? -0.5 : 0.5;
  }
  // Hidden vs understood
  if (ctx.includes("孤独") || ctx.includes("深夜") || ctx.includes("批评") || ctx.includes("质疑")) {
    c.c1_understood_vs_hidden = ctx.includes("孤独") ? -0.4 : 0.3;
  }
  // Time/death awareness
  if (scenario === "death_loss" || scenario === "aging_time" || ctx.includes("死亡") || ctx.includes("时间")) {
    c.c3_fearforgetting_vs_acceptimpermanence = -0.5;
    c.c5_pursueeternity_vs_acceptfading = -0.4;
  }
  // Closeness vs distance
  if (scenario === "loneliness" || ctx.includes("孤独") || ctx.includes("深夜")) {
    c.c4_desirecloseness_vs_keepdistance = -0.4;
  }
  // Optimism vs pessimism
  if (ctx.includes("迷茫") || ctx.includes("不知道") || ctx.includes("为什么")) {
    c.c8_optimistdeclaration_vs_pessimistundercurrent = -0.3;
  }
  // Team vs solitude
  if (ctx.includes("创作") || ctx.includes("瓶颈") || ctx.includes("写")) {
    c.c9_teamdependence_vs_coresolitude = 0.4;
  }
  // Remembered vs forgotten
  if (scenario === "death_loss" || scenario === "aging_time" || ctx.includes("死亡")) {
    c.c10_desireberemembered_vs_acceptoblivion = -0.5;
  }
  // Idealism vs commercial
  if (ctx.includes("商业") || ctx.includes("质疑") || ctx.includes("批评")) {
    c.c6_idealism_vs_commercialreality = 0.3;
  }

  return c;
}

function main() {
  console.log("Converting v3 → v4 (弱监督)...");

  const lines = fs.readFileSync(V3_FILE, "utf-8").split("\n").filter(Boolean);
  const converted: any[] = [];

  for (const line of lines) {
    const p = JSON.parse(line);
    const inp = p.input || p;
    const out = p.output || p;

    const scenario = detectScenario(inp.context || "", inp.active_traits || []);
    const contradictions = inferContradictions(
      scenario.key, inp.active_traits || [], out.warmth ?? 0.5, out.humor ?? 0.2
    );

    converted.push({
      input: {
        mood: inp.mood ?? 0,
        energy: inp.energy ?? 0.5,
        context: inp.context || "",
        active_traits: (inp.active_traits || []).slice(0, 4),
      },
      output: {
        scenario: scenario.key,
        scenario_type: scenario.idx,
        contradictions,
        resolution: "metaphor_encoding", // Default, will be weakly supervised
        warmth: out.warmth ?? 0.5,
        verbosity: out.verbosity ?? 0.5,
        humor: out.humor ?? 0.2,
        formality: out.formality ?? 0.4,
        _weak_supervision: true, // Marker for training (use lower weight if desired)
      },
    });
  }

  fs.writeFileSync(V4_OUT, converted.map(p => JSON.stringify(p)).join("\n"), "utf-8");
  console.log(`Converted: ${converted.length} pairs → ${V4_OUT}`);
  console.log(`(弱监督样本 — 场景和矛盾由规则推断，仅作数据补充)`);
}

main();
