// bootstrap-env.ts — 灵犀冷启动 + 最小真实环境构建
// 用法: cd D:\LingxiServer && node --import tsx src/bootstrap-env.ts

import "dotenv/config";
import { openDb, getDb } from "./db/connection.js";
import { initGraph, propagate, collectActivatedNodes } from "./core/dcgk-engine.js";
import { resolveAnchors } from "./core/dcgk-disambiguate.js";
import { mapToDeltaSignal } from "./core/dcgk-signal.js";
import { recallFromCognitiveGraph } from "./core/memory-recall.js";
import { ensureMemorySchema } from "./core/memory-recall.js";
import { isCognitiveReady } from "./core/cognitive-state.js";

// 常用中文词库（技术/情绪/饮食/生活）
const CN_DICT = new Set([
  "代码","报错","加班","熬夜","睡眠","健身","开会","下班","项目",
  "猪脑花","海底捞","日料","寿司","火锅","清淡","油腻","排队",
  "三体","科幻","刘慈欣","硬科幻","读书","看书","推荐",
  "干脆","直接","绕弯子","浪费","重点","背景","解决",
  "累死","好累","真烦","太好","开心","不喜欢","太好看",
  "纠结","决定","回头","犹豫","不管",
  "token","auth","401","LLM","API","auth.ts","日料","代码","报错","纠结","不喜欢","加班","健身","下班",
]);

function extractBetterAnchors(text: string, maxAnchors: number = 5): string[] {
  const anchors: string[] = [];

  // ① 词库匹配（最长优先）
  const sorted = [...CN_DICT].sort((a, b) => b.length - a.length);
  for (const word of sorted) {
    if (text.includes(word)) {
      anchors.push(word);
      if (anchors.length >= maxAnchors) return anchors;
    }
  }

  // ② 情绪词
  const moods = text.match(/烦|累|困|开心|喜欢|不喜欢/g);
  if (moods) { for (const m of moods) { if (!anchors.includes(m)) anchors.push(m); } }

  // ③ Code tokens
  const codeRe = /\b[a-zA-Z_][a-zA-Z0-9_.]*\b/g;
  let m: RegExpExecArray | null;
  while ((m = codeRe.exec(text)) !== null) {
    const t = m[0];
    if (t.length < 2 || /^[a-z]{1,3}$/.test(t)) continue;
    if (/[a-z][A-Z]/.test(t) || /_/.test(t) || /\.[a-z]+$/i.test(t) || /^[A-Z]{2,6}$/.test(t) || /\d/.test(t)) {
      if (!anchors.includes(t)) anchors.push(t);
    }
  }

  return anchors.slice(0, maxAnchors);
}

const TEST_RECORDS = [
  { content: "今天代码又报错了，auth.ts 改了一晚上还是不行，真烦。我明明已经把 token 验证逻辑重写了一遍，结果还是 401。感觉今晚又要熬夜了，最近睡眠本来就不够。", mood: "frustration", eventType: "user_frustration" },
  { content: "拿我一个亲身经历去说，2014年6月的时候，我和朋友去海底捞火锅店庆祝生日，朋友特意向我推荐了猪脑花这个食材，我吃了一口不喜欢。后来再吃海底捞又想起来这件事。", mood: "neutral", eventType: "new_fact" },
  { content: "说重点，别绕弯子。你直接告诉我这个问题怎么解决就行，不需要给我列一堆背景分析。我喜欢干脆利落的回答，别浪费时间。", mood: "frustration", eventType: "user_correction" },
  { content: "最近在看三体，太好看了，以前觉得科幻小说很枯燥，没想到刘慈欣写得这么有意思。以后多给我推荐硬科幻的书。我喜欢在深夜看书，安静没人打扰。", mood: "excited", eventType: "user_confirmation" },
  { content: "我今天特别想吃日料，但是不想排队。最好清淡一点的，我不喜欢太油腻的。", mood: "curious", eventType: "new_fact" },
  { content: "算了不管了，就这样定了。纠结归纠结，但一旦做了决定就不会回头。", mood: "neutral", eventType: "new_fact" },
  { content: "又加班到这个点，累死了。连续三天晚上十一点才下班，最近也没时间去健身，之前每周至少去三次的。", mood: "tired", eventType: "user_frustration" },
];

async function main() {
  console.log("=".repeat(55));
  console.log("  灵犀冷启动 — 最小真实环境构建");
  console.log("=".repeat(55) + "\n");

  console.log("[Step 0] cognitive_v5 语义层...");
  if (await isCognitiveReady()) {
    console.log("  cognitive_v5 就绪 (1024维, 本地 ONNX)\n");
  } else {
    console.error("  cognitive_v5 不可用：语义层缺失，召回将退化为 字图 + FTS5。");
    console.error("  请设置 COGNITIVE_MODEL_PATH，或把模型放到 ~/.lingxi/models/");
    console.error("  （已不再需要 bge-m3 / Ollama）\n");
  }

  console.log("[Step 1] 数据库...");
  const dbPath = process.env.LINGXI_DB_PATH || (process.env.HOME || process.env.USERPROFILE || ".") + "/.lingxi-server/memory.db";
  const db = openDb(dbPath);
  ensureMemorySchema(); try { db.exec("ALTER TABLE fragments ADD COLUMN context_window TEXT"); } catch {}
  console.log("  DB: " + dbPath + "\n");

  console.log("[Step 2] 灵络认知图...");
  initGraph();
  console.log("  10个种子节点已加载");

  // 清空旧碎片数据
  try { db.exec("DELETE FROM fragments"); } catch {}
  console.log("");

  console.log("[Step 3] 碎片化 + 冷启动...");
  const insertFrag = db.prepare("INSERT OR REPLACE INTO fragments (id, session_id, project_id, summary, created_at, retrieval_state, asset_state, status, recalled_count, linked_count, decay_score) VALUES (?, ?, ?, ?, ?, 'active', 'retained', 'active', 0, 0, 1.0)");
  const insertAnchor = db.prepare("INSERT OR REPLACE INTO fragment_anchors (fragment_id, channel, label, weight, source, timestamp) VALUES (?, ?, ?, ?, ?, ?)");
  let count = 0;
  for (let i = 0; i < TEST_RECORDS.length; i++) {
    const rec = TEST_RECORDS[i]!;
    const anchors = extractBetterAnchors(rec.content, 5);
    console.log("  [" + (i + 1) + "] " + rec.content.slice(0, 55) + "...");
    console.log("      锚点: [" + anchors.join(", ") + "] | 情绪: " + rec.mood);

    let resolved: string[] = [];
    try { resolved = await resolveAnchors(anchors); } catch (e: any) { console.log("      消歧异常: " + e.message); }
    if (resolved.length > 0) {
      const sig = mapToDeltaSignal(rec.mood, rec.eventType, rec.content);
      const r = propagate(resolved, sig.delta);
      console.log("      命中: " + resolved.length + " | 传播 winner=" + r.winner + " score=" + r.score.toFixed(3));
    } else {
      console.log("      命中: 0 (新概念由消歧自动创建)");
    }

    const fragId = "bs_" + Date.now() + "_" + i;
    insertFrag.run(fragId, "bootstrap", "C--Users-Administrator", rec.content.slice(0, 500), Date.now());
    // Insert anchors into fragment_anchors table
    for (const a of anchors) {
      insertAnchor.run(fragId, "WHAT", a, 10, "behavior", Date.now());
    }
    count++;
  }
  console.log("\n  " + count + " 条碎片写入 fragments 表\n");
  try { db.exec("INSERT INTO fragments_fts(fragments_fts) VALUES('rebuild')"); console.log("  FTS 索引已重建"); } catch {}

  console.log("[Step 4] 认知图状态...");
  const stats = (await import("./core/dcgk-engine.js")).graphStats();
  console.log("  节点: " + stats.nodes + " | 边: " + stats.edges);
  const act = collectActivatedNodes(0.01);
  console.log("  激活节点 (>0.01): " + act.length);
  for (const n of act.slice(0, 5)) console.log("    " + n.id + ": A=" + n.activation.toFixed(3));
  console.log("");

  console.log("[Step 5] 记忆召回验证");
  console.log("=".repeat(55));
  const queries = ["今天代码又报错了，真烦", "猪脑花的故事", "推荐科幻书", "好吃的日料"];
  for (const q of queries) {
    console.log('\n  "' + q + '"');
    const myAnchors = extractBetterAnchors(q, 5);
    console.log("  锚点: [" + myAnchors.join(", ") + "]");
    let resolved: string[] = [];
    try { resolved = await resolveAnchors(myAnchors); } catch (e: any) { console.log("  消歧失败: " + e.message); }
    console.log("  消歧: " + myAnchors.length + "->" + resolved.length + "命中" + (resolved.length > 0 ? " [" + resolved.slice(0, 3).join(", ") + "]" : ""));
    if (resolved.length > 0) {
      propagate(resolved, 0);
      const activated = collectActivatedNodes(0.3);
      console.log("  传播: " + activated.length + "节点 >0.3");
      for (const n of activated.slice(0, 4)) console.log("      " + n.id + ": A=" + n.activation.toFixed(3));
    }
    const results = await recallFromCognitiveGraph(q, 3);
    if (results.length === 0) {
      console.log("  召回: (无匹配)");
    } else {
      console.log("  召回: " + results.length + "条 [" + results[0]!.source + "]");
      for (let j = 0; j < results.length; j++) {
        const r = results[j]!;
        console.log("      [" + (j + 1) + "] score=" + r.score.toFixed(3) + " " + r.content.slice(0, 80) + (r.content.length > 80 ? "..." : ""));
      }
    }
  }
  console.log("\n" + "=".repeat(55) + "\n  冷启动完成。\n" + "=".repeat(55));
}

main().catch((err) => { console.error("失败:", err); process.exit(1); });
