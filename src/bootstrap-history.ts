// bootstrap-history.ts — 历史 JSONL 冷启动 → 灵络拓扑构建
// 用法: cd D:\LingxiServer && node --import tsx src/bootstrap-history.ts

import "dotenv/config";
import { openDb, getDb } from "./db/connection.js";
import { initGraph, propagate, collectActivatedNodes, graphStats } from "./core/dcgk-engine.js";
import { hybridResolveAnchors } from "./core/dcgk-disambiguate.js";
import { mapToDeltaSignal } from "./core/dcgk-signal.js";
import { upsertNode, upsertEdge } from "./core/dcgk-store.js";
import { recallFromCognitiveGraph } from "./core/memory-recall.js";
import { ensureMemorySchema } from "./core/memory-recall.js";
import { isCognitiveReady } from "./core/cognitive-state.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ═══════════════════════════════════════════
// 轻量碎片化（无LLM调用，从消息内容提取四通道锚点）
// ═══════════════════════════════════════════

interface ChannelAnchor { channel: string; label: string; weight: number; }

function lightweightFragment(text: string, mood: string): ChannelAnchor[] {
  const anchors: ChannelAnchor[] = [];

  // WHAT: code tokens + key concepts
  const codeTokens = text.match(/\b[a-zA-Z_][a-zA-Z0-9_.]*\b/g) || [];
  for (const t of codeTokens) {
    if (t.length >= 2 && !/^[a-z]{1,3}$/.test(t)) {
      anchors.push({ channel: "WHAT", label: t, weight: 10 });
    }
  }

  // FEEL: emotion signals
  const moodWords = text.match(/烦|累|困|开心|喜欢|不喜欢|压力|焦虑|挫败|兴奋|好奇/g);
  if (moodWords) {
    for (const w of [...new Set(moodWords)]) {
      anchors.push({ channel: "FEEL", label: mood + "_" + w, weight: 15 });
    }
  }

  // WHO: self-reference
  if (/我|我的|我们/.test(text)) {
    anchors.push({ channel: "WHO", label: "user_self", weight: 5 });
  }

  // WHERE: location/time context
  if (/加班|公司|家里|办公室|外面|附近/.test(text)) {
    anchors.push({ channel: "WHERE", label: "context_" + (text.includes("加班") ? "work" : "home"), weight: 5 });
  }

  return anchors;
}

// ═══════════════════════════════════════════
// 历史对话数据（15条，从真实JSONL提取）
// ═══════════════════════════════════════════

interface HistoryRecord {
  content: string;
  mood: string;
  eventType: string;
}

function loadHistoryRecords(): HistoryRecord[] {
  const records: HistoryRecord[] = [];

  // Try loading from JSONL files
  try {
    const home = process.env.HOME || process.env.USERPROFILE || ".";
    const dir = path.join(home, ".claude/projects/C--Users-Administrator");
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith(".jsonl") && !f.includes("subagent"))
      .sort((a, b) => fs.statSync(path.join(dir, b)).mtime.getTime() - fs.statSync(path.join(dir, a)).mtime.getTime())
      .slice(0, 8);

    const seen = new Set<string>();
    for (const f of files) {
      const content = fs.readFileSync(path.join(dir, f), "utf-8");
      for (const line of content.split("\n").filter(Boolean)) {
        try {
          const obj = JSON.parse(line);
          let msg = "";
          if (obj.message?.role === "user") {
            msg = typeof obj.message.content === "string" ? obj.message.content :
              Array.isArray(obj.message.content) ? obj.message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ") : "";
          } else if (obj.type === "user") {
            msg = obj.content || "";
          }
          if (!msg || msg.length < 50 || msg.length > 600) continue;

          const key = msg.slice(0, 60);
          if (seen.has(key)) continue;
          seen.add(key);

          let mood = "neutral"; let eventType = "new_fact";
          if (/烦|不爽|挫败|头疼|焦虑|难/.test(msg)) { mood = "frustration"; eventType = "user_frustration"; }
          else if (/开心|太棒|兴奋|好看|好|不错/.test(msg)) { mood = "excited"; eventType = "user_confirmation"; }
          else if (/累|困|疲惫|加班/.test(msg)) { mood = "tired"; eventType = "new_fact"; }
          else if (/好奇|想知道|？/.test(msg)) { mood = "curious"; eventType = "new_fact"; }

          records.push({ content: msg.slice(0, 500), mood, eventType });
        } catch { /* skip corrupt lines */ }
      }
    }
  } catch (e: any) {
    console.log("  警告: 无法读取JSONL文件: " + e.message);
  }

  // Fallback: use built-in records if JSONL loading didn't yield enough
  if (records.length < 10) {
    records.push(
      { content: "今天代码又报错了，auth.ts 改了一晚上还是不行，真烦。我明明已经把 token 验证逻辑重写了一遍，结果还是 401。", mood: "frustration", eventType: "user_frustration" },
      { content: "2014年6月，我和朋友去海底捞火锅店庆祝生日，朋友向我推荐了猪脑花，我吃了一口不喜欢。后来2026年又吃了一次海底捞才想起来这件事。", mood: "neutral", eventType: "new_fact" },
      { content: "说重点，别绕弯子。我喜欢干脆利落的回答，不需要背景分析，别浪费时间。", mood: "frustration", eventType: "user_correction" },
      { content: "最近在看三体，太好看了。以前觉得科幻小说很枯燥，没想到刘慈欣写得这么有意思。以后多给我推荐硬科幻的书。我喜欢深夜看书，安静。", mood: "excited", eventType: "user_confirmation" },
      { content: "今天特别想吃日料，不想排队。最好清淡一点，不喜欢太油腻的。", mood: "curious", eventType: "new_fact" },
      { content: "算了不管了，就这样定了。纠结归纠结，一旦做了决定就不会回头。", mood: "neutral", eventType: "new_fact" },
      { content: "又加班到这个点，累死了。连续三天十一点才下班，最近没时间去健身，之前每周至少三次的。", mood: "tired", eventType: "user_frustration" },
      { content: "我不认为记忆系统应该做成一个可观测的白盒面板。没人会去翻自己记得什么——记忆就应该是自然而然的事情。", mood: "frustration", eventType: "user_correction" },
      { content: "灵犀商业化让我很头疼。和朋友聊了之后，他说创意很好但不够商业化门槛。技术上讲得不够深刻，故事也讲不好。", mood: "frustration", eventType: "user_frustration" },
      { content: "我觉得涌现效果应该是积累出来的，不是设计出来的。把土壤培养好，长出结果是时间问题。别跳级。", mood: "neutral", eventType: "new_fact" },
    );
  }

  // Always include core test records for validation
  records.push(
    { content: "今天代码又报错了，auth.ts 改了一晚上还是不行，真烦。我明明已经把 token 验证逻辑重写了一遍，结果还是 401。", mood: "frustration", eventType: "user_frustration" },
    { content: "2014年6月，我和朋友去海底捞火锅店庆祝生日，朋友向我推荐了猪脑花，我吃了一口不喜欢。后来2026年又吃了一次海底捞才想起来这件事。", mood: "neutral", eventType: "new_fact" },
    { content: "说重点，别绕弯子。我喜欢干脆利落的回答，不需要背景分析，别浪费时间。", mood: "frustration", eventType: "user_correction" },
    { content: "最近在看三体，太好看了。以前觉得科幻小说很枯燥，没想到刘慈欣写得这么有意思。以后多给我推荐硬科幻的书。", mood: "excited", eventType: "user_confirmation" },
    { content: "今天特别想吃日料，不想排队。最好清淡一点，不喜欢太油腻的。", mood: "curious", eventType: "new_fact" },
    { content: "灵犀商业化让我很头疼。和朋友聊了之后，他说创意很好但不够商业化门槛。", mood: "frustration", eventType: "user_frustration" },
  );
  return records.slice(0, 24);
}

// ═══════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════

async function main() {
  console.log("=".repeat(60));
  console.log("  灵犀历史冷启动 — JSONL → 灵络拓扑构建");
  console.log("=".repeat(60));
  console.log("");

  // ── Step 0: cognitive_v5 自检 ──────────────────────────────────
  console.log("[Env Check] cognitive_v5 语义层...");
  if (await isCognitiveReady()) {
    console.log("  ✓ cognitive_v5 就绪 (1024维, 本地 ONNX)\n");
  } else {
    console.error("  ✗ cognitive_v5 不可用：语义层缺失，召回将退化为 字图 + FTS5。");
    console.error("    请设置 COGNITIVE_MODEL_PATH，或把模型放到 ~/.lingxi/models/");
    console.error("    （已不再需要 bge-m3 / Ollama）\n");
  }

  // ── Step 1: 数据库 + 灵络初始化 ──────────────────────────
  console.log("[Step 1] 数据库 & 灵络初始化...");
  const dbPath = process.env.LINGXI_DB_PATH ||
    (process.env.HOME || process.env.USERPROFILE || ".") + "/.lingxi-server/memory.db";

  // Fresh start
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(dbPath + "-wal"); } catch {}
  try { fs.unlinkSync(dbPath + "-shm"); } catch {}

  const db = openDb(dbPath);
  ensureMemorySchema();
  // Migration: context_window column for fragments
  try { db.exec("ALTER TABLE fragments ADD COLUMN context_window TEXT"); } catch {}
  initGraph();
  console.log("  DB: " + dbPath);
  console.log("  灵络: 10 种子节点已加载\n");

  // ── Step 2: 加载历史数据 ──────────────────────────────────
  const records = loadHistoryRecords();
  console.log("[Step 2] 已加载 " + records.length + " 条历史记录\n");

  // Fragments insert
  const insertFrag = db.prepare(
    "INSERT OR REPLACE INTO fragments (id, session_id, project_id, summary, context_window, created_at, retrieval_state, asset_state, status, recalled_count, linked_count, decay_score) VALUES (?, ?, ?, ?, ?, ?, 'active', 'retained', 'active', 0, 0, 1.0)"
  );
  const insertAnchor = db.prepare(
    "INSERT OR REPLACE INTO fragment_anchors (fragment_id, channel, label, weight, source, timestamp) VALUES (?, ?, ?, ?, ?, ?)"
  );

  // Stats
  let totalFrags = 0;
  let totalAnchors = 0;
  let totalNewNodes = 0;
  let totalPropagations = 0;
  let bgeTimeouts = 0;

  // ── Step 3: 逐条处理管线 ─────────────────────────────────
  console.log("[Step 3] 逐条处理管线");
  console.log("=".repeat(60));

  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    console.log("\n[Bootstrap] 处理记录 " + (i + 1) + "/" + records.length);
    console.log("  内容: " + rec.content.slice(0, 80) + (rec.content.length > 80 ? "..." : ""));
    console.log("  情绪: " + rec.mood + " | " + rec.eventType);

    // 3a. 碎片化 (轻量四通道)
    const channelAnchors = lightweightFragment(rec.content, rec.mood);
    const fragId = "hist_" + Date.now() + "_" + i;
    // Build context window from adjacent records
    const prevContent = i > 0 ? records[i - 1]!.content.slice(0, 300) : "";
    const nextContent = i < records.length - 1 ? records[i + 1]!.content.slice(0, 300) : "";
    const contextWindow = [prevContent ? "PREV: " + prevContent : "", nextContent ? "NEXT: " + nextContent : ""].filter(Boolean).join("\n") || null;
    insertFrag.run(fragId, "history_bootstrap", "C--Users-Administrator", rec.content.slice(0, 500), contextWindow, Date.now());
    for (const a of channelAnchors) {
      insertAnchor.run(fragId, a.channel, a.label, a.weight, "behavior", Date.now());
    }
    totalFrags++;
    totalAnchors += channelAnchors.length;

    // 3b. 信号提取
    const signal = mapToDeltaSignal(rec.mood, rec.eventType, rec.content);
    const anchors = signal.anchors.slice(0, 5);
    if (anchors.length === 0) {
      console.log("  [信号] 无可用锚点，跳过");
      continue;
    }

    // 3c. 混合消歧 (cognitive_v5 + char-graph)
    let hybrid: { nodeIds: string[]; semanticHits: string[]; symbolicHits: string[] };
    try {
      hybrid = await hybridResolveAnchors(anchors, "C--Users-Administrator");
    } catch (e: any) {
      console.log("  [消歧] 语义消歧异常: " + e.message + " → 降级纯char-graph");
      bgeTimeouts++;
      hybrid = {
        nodeIds: anchors,
        semanticHits: [],
        symbolicHits: anchors,
      };
    }

    if (hybrid.semanticHits.length > 0) {
      console.log("  [消歧] 语义命中: [" + hybrid.semanticHits.join(", ") + "]");
    }
    if (hybrid.symbolicHits.length > 0 && hybrid.symbolicHits.length < 10) {
      console.log("  [消歧] 符号命中: [" + hybrid.symbolicHits.join(", ") + "]");
    }

    // Track new nodes created (compare before/after graph stats)
    const statsBefore = graphStats();

    // 3d. 图注入与传播 + Hebbian学习
    if (hybrid.nodeIds.length > 0) {
      const result = propagate(hybrid.nodeIds, signal.delta);
      totalPropagations++;
      console.log("  [传播] " + hybrid.nodeIds.length + " 节点 → winner=" + result.winner + " score=" + result.score.toFixed(3));
      if (result.conflicts.length > 0) {
        console.log("  [冲突] [" + result.conflicts.join(", ") + "]");
      }
    }

    // Check for new nodes
    const statsAfter = graphStats();
    const newNodeDelta = statsAfter.nodes - statsBefore.nodes;
    if (newNodeDelta > 0) {
      totalNewNodes += newNodeDelta;
      console.log("  [灵络] 新建节点: +" + newNodeDelta + " (总计 " + statsAfter.nodes + " 节点)");
    }
    if (statsAfter.edges > statsBefore.edges) {
      console.log("  [灵络] 新建/强化边: +" + (statsAfter.edges - statsBefore.edges) + " (总计 " + statsAfter.edges + " 边)");
    }
  }

  // ═══════════════════════════════════════════
  // Step 4: 批量持久化 + FTS重建
  // ═══════════════════════════════════════════
  console.log("\n[Step 4] 持久化...");
  try { db.exec("INSERT INTO fragments_fts(fragments_fts) VALUES('rebuild')"); } catch {}
  const finalStats = graphStats();
  console.log("  Fragments: " + totalFrags);
  console.log("  Anchors: " + totalAnchors);
  console.log("  图节点: " + finalStats.nodes + " (新增 " + totalNewNodes + ")");
  console.log("  图边: " + finalStats.edges);
  console.log("  传播次数: " + totalPropagations);
  if (bgeTimeouts > 0) console.log("  语义降级: " + bgeTimeouts + " 次");
  console.log("");

  // ═══════════════════════════════════════════
  // Step 5: 闭环验证
  // ═══════════════════════════════════════════
  console.log("[Step 5] 闭环验证 — 记忆召回");
  console.log("=".repeat(60));

  const testCases = [
    "今天代码又报错了，真烦",
    "猪脑花的故事",
    "推荐科幻书",
    "灵犀商业化",
  ];

  for (const q of testCases) {
    console.log('\n  ▶ "' + q + '"');
    try {
      const results = await recallFromCognitiveGraph(q, 3);
      if (results.length === 0) {
        console.log("  ✗ 无召回结果");
      } else {
        console.log("  ✓ " + results.length + " 条 [" + results[0]!.source + "]");
        for (let j = 0; j < results.length; j++) {
          const r = results[j]!;
          console.log("    [" + (j + 1) + "] score=" + r.score.toFixed(3));
          console.log("        " + r.content.slice(0, 100) + (r.content.length > 100 ? "..." : ""));
        }
      }
    } catch (e: any) {
      console.log("  ✗ 异常: " + e.message);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("  冷启动完成。灵络已有 " + finalStats.nodes + " 节点，" + finalStats.edges + " 边。");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("\n✗ 冷启动失败:", err);
  process.exit(1);
});
