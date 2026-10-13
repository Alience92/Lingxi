// test-recall.ts — 验证记忆召回管线连通
// 用法: cd D:\LingxiServer && node --import tsx test-recall.ts

import "dotenv/config";
import { openDb } from "./db/connection.js";
import { initGraph } from "./core/dcgk-engine.js";
import { recallFromCognitiveGraph } from "./core/memory-recall.js";

const DB_PATH = process.env.LINGXI_DB_PATH ||
  `${process.env.HOME || process.env.USERPROFILE || "."}/.lingxi-server/memory.db`;

async function main() {
  console.log("=".repeat(50));
  console.log("  灵络认知图召回 — 管线验证");
  console.log("=".repeat(50));
  console.log("");

  // 初始化
  const db = openDb(DB_PATH);
  console.log(`DB: ${DB_PATH}`);
  initGraph();
  console.log("灵络: 认知图已初始化");
  console.log("");

  const testCases = [
    "今天代码又报错了，真烦",
    "猪脑花的故事你还记得吗",
    "附近有什么好吃的日料推荐",
    "灵犀商业化让我很头疼",
  ];

  for (const input of testCases) {
    console.log(`--- 输入: "${input}" ---`);
    try {
      const results = await recallFromCognitiveGraph(input, 5);
      if (results.length === 0) {
        console.log("  结果: (无匹配)");
      } else {
        for (let i = 0; i < results.length; i++) {
          const r = results[i]!;
          console.log(`  [${i + 1}] [${r.source}] score=${r.score.toFixed(3)}`);
          console.log(`      ${r.content.slice(0, 120)}${r.content.length > 120 ? "..." : ""}`);
        }
      }
    } catch (e: any) {
      console.log(`  错误: ${e.message}`);
    }
    console.log("");
  }

  console.log("管线验证完成。");
}

main().catch(console.error);
