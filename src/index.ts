// index.ts — 灵犀记忆服务入口（精简版，仅服务 DSH）
//
// 2026-08-14 简化：移除陪伴者对话系统（chat-engine/persona/affinity/reflection 等）
// 和 HTTP 服务（api/server），灵犀回归纯记忆服务。DSH 是唯一宿主，
// 通过 engine.ts + system-controller.ts 暴露记忆能力。
//
// 启动动作：
//   1. 打开记忆库
//   2. 初始化灵络认知图
//   3. 构建字图索引
//   4. 构建认知向量索引（可用时）
//   5. 触发一次记忆维护周期（可选）

import { loadEnvFile } from "./load-env.js";

// .env 必须在读取任何 process.env 之前加载（DSH 宿主环境里通常没有这些变量）。
// 加载器跳过空值，因此密钥可用环境变量注入、.env 里留空即可。
loadEnvFile();

import { getDbPath, openDb } from "./db/connection.js";
import { initGraph } from "./core/dcgk-engine.js";
import { createDefaultSystemController } from "./system-controller.js";

const DB_PATH = process.env.LINGXI_DB_PATH || getDbPath();
const PROJECT_ID = process.env.LINGXI_PROJECT_ID || "C--Users-Administrator";

async function main(): Promise<void> {
  console.log("=".repeat(50));
  console.log("  灵犀记忆服务（Lingxi Memory Service）");
  console.log("  Pure memory service — DSH only");
  console.log("=".repeat(50));

  // 1. 数据库
  const db = openDb(DB_PATH);
  console.log(`  DB: ${DB_PATH}`);

  // 2. 初始化灵络认知图（记忆认知增强层）
  initGraph();
  console.log("  灵络: 认知图已初始化");

  // 3. 构建字图索引
  try {
    const cg = await import("./core/char-graph.js");
    const stats = cg.buildGraph(PROJECT_ID);
    console.log(`  字图: ${stats.nodeCount}节点 ${stats.edgeCount}边 ${stats.buildTimeMs}ms`);
  } catch (e) {
    console.log(`  字图: 构建失败（${e instanceof Error ? e.message : e}），检索将降级`);
  }

  // 4. 构建认知向量索引（cognitive_v5 可用时）
  try {
    const vindex = await import("./core/fragment-vector-index.js");
    const stats = await vindex.buildVectorIndex(PROJECT_ID);
    console.log(`  向量索引: ${stats.entryCount}条碎片 ${stats.buildTimeMs}ms`);
  } catch {
    console.log("  向量索引: 不可用，跳过（检索将走字图/认知向量/FTS 路径）");
  }

  // 5. 整体层健康探测 —— 打印完整状态（含数据现实与告警），不只第一行。
  //    只打印第一行会让“状态位说 healthy、数据其实是空的”这类问题被藏起来。
  try {
    const ctrl = await createDefaultSystemController();
    await ctrl.probeAll();
    console.log("");
    for (const line of ctrl.formatStatus().split("\n")) {
      console.log("  " + line);
    }
  } catch (e) {
    console.log(`  整体层: 初始化失败（${e instanceof Error ? e.message : e}）`);
  }

  console.log("=".repeat(50));
  console.log("  灵犀记忆服务就绪。DSH 通过 engine.ts 接入。");
  console.log("=".repeat(50));
}

main().catch((e) => {
  console.error("启动失败:", e);
  process.exit(1);
});
