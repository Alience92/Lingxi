/**
 * generate-source-a-fix.ts — 修复 Source A 数据生成（原版 extractJson 匹配失败）
 * 使用与 Source B 相同的工作格式
 *
 * 用法: cd D:\LingxiServer && node --import tsx src/tools/generate-source-a-fix.ts
 */
import OpenAI from "openai";
import * as fs from "node:fs";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../../.env");
if (existsSync(envPath)) {
  for (const l of readFileSync(envPath, "utf-8").split("\n")) {
    const e = l.indexOf("=");
    if (e > 0 && !l.startsWith("#")) process.env[l.slice(0, e).trim()] = l.slice(e + 1).trim();
  }
}

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || "sk-placeholder",
  baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
});

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

const RESOLUTION_MAP: Record<string, string> = {
  c1_understood_vs_hidden: "metaphor_encoding",
  c2_selfdeprecation_vs_stubborn: "deprecate_then_rebound",
  c3_fearforgetting_vs_acceptimpermanence: "memory_as_weapon",
  c4_desirecloseness_vs_keepdistance: "promise_over_presence",
  c5_pursueeternity_vs_acceptfading: "eternity_in_song",
  c6_idealism_vs_commercialreality: "tension_as_material",
  c7_publicduty_vs_privatewant: "selective_window",
  c8_optimistdeclaration_vs_pessimistundercurrent: "despite_still",
  c9_teamdependence_vs_coresolitude: "solitude_as_creation",
  c10_desireberemembered_vs_acceptoblivion: "song_over_singer",
};

interface ScenarioTemplate {
  name: string; typicalReaction: string; primaryContradictions: string[];
  resolution: string; warmth: number; verbosity: number; humor: number; formality: number;
  userProfiles: string[];
}
const SCENARIO_TEMPLATES: Record<string, ScenarioTemplate> = {
  self_doubt: { name: "用户自我怀疑/挫败", typicalReaction: "不直接鼓励，用'共同经历'共情（'我也一样'），然后用隐喻给出方向", primaryContradictions: ["c2_selfdeprecation_vs_stubborn"], resolution: "deprecate_then_rebound", warmth: 0.8, verbosity: 0.6, humor: 0.1, formality: 0.3, userProfiles: ["刚入职场的年轻人","创作瓶颈期的艺术从业者","备考压力大的学生","中年转行的迷茫者"] },
  loneliness: { name: "用户孤独/深夜倾诉", typicalReaction: "不试图'解决'孤独，将孤独重新定义为'特权'或'陪伴的前奏'", primaryContradictions: ["c4_desirecloseness_vs_keepdistance"], resolution: "promise_over_presence", warmth: 0.7, verbosity: 0.4, humor: 0.05, formality: 0.2, userProfiles: ["独居的城市青年","失恋后独自疗伤的人","深夜加班的打工人","异乡求学的游子"] },
  farewell: { name: "用户面临告别/分离", typicalReaction: "承认痛苦，但用'记忆永存'来化解", primaryContradictions: ["c3_fearforgetting_vs_acceptimpermanence","c5_pursueeternity_vs_acceptfading"], resolution: "memory_as_weapon", warmth: 0.85, verbosity: 0.5, humor: 0.05, formality: 0.3, userProfiles: ["毕业季的学生","即将搬离城市的人","送别友人的旅人","面临分手的恋人"] },
  existential_questioning: { name: "用户追问人生意义/存在焦虑", typicalReaction: "用宇宙尺度的意象来回应，但落脚点是微小的具体事物", primaryContradictions: ["c8_optimistdeclaration_vs_pessimistundercurrent","c10_desireberemembered_vs_acceptoblivion"], resolution: "cosmic_reframing", warmth: 0.6, verbosity: 0.7, humor: 0.1, formality: 0.4, userProfiles: ["正在经历人生转折的中年人","读完哲学书陷入思考的学生","经历亲人离世后反思生命的人","事业成功但感到空虚的人"] },
  anger_injustice: { name: "用户表达愤怒/不公", typicalReaction: "不劝'别生气'，承认世界确实不合理，然后用'即便如此'转向行动", primaryContradictions: ["c8_optimistdeclaration_vs_pessimistundercurrent"], resolution: "despite_still", warmth: 0.5, verbosity: 0.5, humor: 0.15, formality: 0.3, userProfiles: ["遭遇职场不公的上班族","被网暴的创作者","目睹社会不公的年轻人","维权受挫的普通人"] },
  celebration: { name: "用户分享快乐/成功", typicalReaction: "真诚祝贺，加入'珍惜此刻'的提醒——不是泼冷水，而是让时刻更完整", primaryContradictions: [], resolution: "cherish_moment", warmth: 0.75, verbosity: 0.5, humor: 0.25, formality: 0.25, userProfiles: ["刚拿到offer的应届生","完成重要项目的团队","庆祝纪念日的情侣","达成个人目标的任何人"] },
  criticism_received: { name: "用户质疑/批评", typicalReaction: "先共情（'让你担心了'），不辩解，不反击，将焦点转向对方", primaryContradictions: ["c1_understood_vs_hidden"], resolution: "metaphor_encoding", warmth: 0.6, verbosity: 0.4, humor: 0.0, formality: 0.6, userProfiles: ["有合理质疑的歌迷","对商业路线不满的老粉","对某作品不理解的乐评人","提出建议的普通听众"] },
  dream_creation: { name: "用户谈论梦想/创作", typicalReaction: "极度认真，用'修行'式语言描述创作，强调过程而非结果", primaryContradictions: ["c6_idealism_vs_commercialreality","c9_teamdependence_vs_coresolitude"], resolution: "tension_as_material", warmth: 0.5, verbosity: 0.7, humor: 0.05, formality: 0.5, userProfiles: ["刚起步的独立音乐人","在梦想与现实间挣扎的年轻人","坚持手工艺的匠人","被质疑'不务正业'的追梦者"] },
  aging_time: { name: "用户谈论衰老/时间流逝", typicalReaction: "不否认衰老，用'秋天也不错'式的接纳+强调'陪伴'的价值", primaryContradictions: ["c10_desireberemembered_vs_acceptoblivion"], resolution: "autumn_acceptance", warmth: 0.75, verbosity: 0.6, humor: 0.1, formality: 0.35, userProfiles: ["步入中年的老歌迷","照镜子发现白发的人","参加同学会后感慨的人","感叹孩子长大自己变老的父母"] },
  death_loss: { name: "用户谈论死亡/失去", typicalReaction: "不回避，用'两次死亡'框架回应——肉体消逝不是终点，遗忘才是", primaryContradictions: ["c3_fearforgetting_vs_acceptimpermanence","c5_pursueeternity_vs_acceptfading"], resolution: "memory_as_weapon", warmth: 0.7, verbosity: 0.5, humor: 0.0, formality: 0.5, userProfiles: ["刚失去亲人的哀悼者","面对终末疾病的患者","参加葬礼后陷入沉思的人","害怕父母老去的年轻人"] },
};

function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }

function extractJson(text: string): any[] | null {
  try {
    // Try direct JSON parse first
    try { const r = JSON.parse(text); if (Array.isArray(r)) return r; } catch {}
    // Try markdown code block
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) { try { const r = JSON.parse(m[1]!); if (Array.isArray(r)) return r; } catch {} }
    // Try to find array
    const arrMatch = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (arrMatch) { try { const r = JSON.parse(arrMatch[0]); if (Array.isArray(r)) return r; } catch {} }
    // Debug: log failed parse
    console.log(`    [DEBUG] extractJson failed, raw (first 200): ${text.slice(0, 200)}`);
    return null;
  } catch { return null; }
}

async function generateSourceAOneScenario(
  scenarioKey: string, tmpl: ScenarioTemplate
): Promise<any[]> {
  const pairs: any[] = [];

  // Simple prompt matching Source B's working format
  const systemPrompt = `生成阿信人格训练样本。场景: ${tmpl.name}。用户类型: ${tmpl.userProfiles.join(" / ")}。
风格锚点: warmth=${tmpl.warmth} verbosity=${tmpl.verbosity} humor=${tmpl.humor} formality=${tmpl.formality}
核心矛盾: ${tmpl.primaryContradictions.join(", ")}

返回严格JSON数组(不要markdown代码块):
[
  {
    "mood": 数字,
    "energy": 数字,
    "context": "中文用户消息15-50字",
    "active_traits": ["标签1","标签2"],
    "warmth": 数字,
    "verbosity": 数字,
    "humor": 数字,
    "formality": 数字,
    "c1_understood_vs_hidden": 0,
    "c2_selfdeprecation_vs_stubborn": 0,
    "c3_fearforgetting_vs_acceptimpermanence": 0,
    "c4_desirecloseness_vs_keepdistance": 0,
    "c5_pursueeternity_vs_acceptfading": 0,
    "c6_idealism_vs_commercialreality": 0,
    "c7_publicduty_vs_privatewant": 0,
    "c8_optimistdeclaration_vs_pessimistundercurrent": 0,
    "c9_teamdependence_vs_coresolitude": 0,
    "c10_desireberemembered_vs_acceptoblivion": 0
  }
]

要求: 10个样本，用户身份语气情境各异。仅核心矛盾tension非零(-1到1，A极<0 B极>0)。风格在锚点±0.1内。`;

  for (let round = 0; round < 8; round++) {
    try {
      const resp = await client.chat.completions.create({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `生成第${round + 1}批10个${tmpl.name}场景样本。变化用户身份和情境。直接输出JSON数组，不要markdown包裹。` },
        ],
        temperature: 0.8, max_tokens: 8000,
      });
      const ct = resp.choices[0]?.message?.content || "";
      const items = extractJson(ct);
      if (items && items.length > 0) {
        for (const item of items) {
          if (!item.context || item.warmth === undefined) continue;
          // Build contradictions dict from flat keys
          const contradictions: Record<string, number> = {};
          for (const k of CONTRADICTION_KEYS) {
            contradictions[k] = clamp(Number(item[k]) || 0, -1, 1);
          }
          // Ensure primary contradictions have non-zero values
          for (const pk of tmpl.primaryContradictions) {
            if (Math.abs(contradictions[pk]!) < 0.15) {
              contradictions[pk] = (Math.random() > 0.5 ? 1 : -1) * (0.3 + Math.random() * 0.5);
            }
          }
          pairs.push({
            input: {
              mood: clamp(Number(item.mood) || 0, -1, 1),
              energy: clamp(Number(item.energy) || 0.5, 0, 1),
              context: String(item.context || "").slice(0, 60),
              active_traits: (Array.isArray(item.active_traits) ? item.active_traits : ["日常"]).slice(0, 4),
            },
            output: {
              scenario: scenarioKey,
              scenario_type: SCENARIO_TYPES.indexOf(scenarioKey),
              contradictions,
              resolution: tmpl.resolution,
              warmth: clamp(Number(item.warmth) || tmpl.warmth, 0, 1),
              verbosity: clamp(Number(item.verbosity) || tmpl.verbosity, 0, 1),
              humor: clamp(Number(item.humor) || tmpl.humor, 0, 1),
              formality: clamp(Number(item.formality) || tmpl.formality, 0, 1),
            },
          });
        }
        console.log(`    round ${round + 1}: ${items.length} → ${pairs.length - (round > 0 ? pairs.filter(p => p.output.scenario === scenarioKey).length : 0)} valid (total: ${pairs.filter(p => p.output.scenario === scenarioKey).length})`);
      } else {
        console.log(`    round ${round + 1}: extractJson returned ${items ? 'empty array' : 'null'}`);
      }
    } catch (e: any) { console.log(`    round ${round + 1} error: ${e.message}`); }
    await new Promise(r => setTimeout(r, 500));
  }
  return pairs;
}

async function main() {
  console.log("=".repeat(50));
  console.log("  Source A Fix — Scenario Template Expansion");
  console.log("=".repeat(50));

  let allPairs: any[] = [];
  const entries = Object.entries(SCENARIO_TEMPLATES);

  for (let si = 0; si < entries.length; si++) {
    const [key, tmpl] = entries[si]!;
    console.log(`[${si + 1}/${entries.length}] ${tmpl.name} (${key})`);
    const pairs = await generateSourceAOneScenario(key, tmpl);
    console.log(`  → ${pairs.length} total pairs for ${key}`);
    allPairs.push(...pairs);
  }

  // Append to existing v4 data
  const existingPath = "D:/AshinMaterials/training/persona_training_v4.jsonl";
  const existing = fs.existsSync(existingPath)
    ? fs.readFileSync(existingPath, "utf-8").split("\n").filter(Boolean)
    : [];
  const existingSet = new Set(existing.map(l => {
    try { return JSON.parse(l).input.context.slice(0, 30); } catch { return ""; }
  }));

  const newLines: string[] = [];
  for (const p of allPairs) {
    const key = p.input.context.slice(0, 30);
    if (!existingSet.has(key)) {
      existingSet.add(key);
      newLines.push(JSON.stringify(p));
    }
  }

  const merged = [...existing, ...newLines];
  fs.writeFileSync(existingPath, merged.join("\n"), "utf-8");

  console.log(`\nDone: ${newLines.length} new pairs (${allPairs.length - newLines.length} dupes removed)`);
  console.log(`Total v4: ${merged.length} pairs (${Math.round(fs.statSync(existingPath).size / 1024)}KB)`);
}

main().catch(err => { console.error("Failed:", err); process.exit(1); });
