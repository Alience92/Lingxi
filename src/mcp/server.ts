#!/usr/bin/env node
// src/mcp/server.ts — 灵犀记忆 MCP server（stdio 传输）
//
// 目的：一次性把记忆能力挂到任意支持 MCP 的宿主
//   Claude Code / Cursor / Cline / Zed / Continue / ohmyagent …
//
// 宿主配置示例（Claude Code）：
//   claude mcp add lingxi -- node --import tsx "D:/Lingxi mem easy mode/src/mcp/server.ts"
// 或（构建后）：
//   claude mcp add lingxi -- node "D:/Lingxi mem easy mode/dist/mcp/server.js"
//
// 暴露 3 个工具：memory_status / memory_search / memory_remember
//
// ⚠️ stdio 传输要求 stdout 只承载 JSON-RPC 帧。本项目各模块用 console.log 打进度
//    （如 `[VectorIdx] Built: …`），一旦写进 stdout 就会污染协议流、导致客户端解析失败。
//    所以：**在任何业务模块被求值之前**先把 console.log/info/warn 改道到 stderr。
//    ESM 的 import 会被提升，因此业务模块必须用动态 import。

console.log = (...args: unknown[]) => { console.error(...args); };
console.info = (...args: unknown[]) => { console.error(...args); };
console.warn = (...args: unknown[]) => { console.error(...args); };

import type { LingxiEngine } from "../engine.js";

const { loadEnvFile } = await import("../load-env.js");
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = await import("zod");
const { createLingxiEngine } = await import("../engine.js");
const { resolveConfig } = await import("../config.js");

// 宿主（Claude Code / Cursor …）启动本进程时不会带上我们的环境变量，
// 所以 .env 必须在这里加载，且要早于 engine/config 的求值。
const ENV_FILE = loadEnvFile();

const cfg = resolveConfig();
const engine: LingxiEngine = createLingxiEngine({ dbPath: cfg.dbPath });

// 版本号从 package.json 读取，不写死字面量 —— 否则升版本时 MCP 握手会报旧值，
// 而宿主界面上显示的正是这个值（cli.ts 也采用同一做法）。
// 从 src/mcp 与 dist/mcp 两个位置向上都是仓库根，故 "../../package.json" 两边都成立。
const PKG_VERSION: string = await (async () => {
  try {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const j = JSON.parse(readFileSync(resolve(here, "../../package.json"), "utf-8")) as { version?: string };
    return j.version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

const server = new McpServer({ name: "lingxi-memory", version: PKG_VERSION });

// ── memory_status ────────────────────────────────────────────────────
server.registerTool(
  "memory_status",
  {
    title: "灵犀记忆状态",
    description:
      "返回灵犀记忆服务的健康状态：各能力（db / llm / lingmou / cognitive / 字图 / 灵络 / …）、" +
      "数据现实（碎片数、含 cognitive_v5 向量的碎片数、认知图节点与边）以及数据告警。排障时先看这个。",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    await engine.probeAll();
    const s = engine.status();
    const lines = await engine.formatStatus();
    const structured = {
      overall: s.overall,
      criticalDown: s.criticalDown,
      degradedList: s.degradedList,
      errors: s.errors,
      dataReality: s.dataReality,
      dataWarnings: s.dataWarnings,
      capabilities: Object.fromEntries(
        Object.entries(s.capabilities).map(([k, v]) => [k, { status: v.status, label: v.label, lastError: v.lastError }]),
      ),
    };
    return {
      content: [
        { type: "text", text: lines },
        { type: "text", text: JSON.stringify(structured, null, 2) },
      ],
    };
  },
);

// ── memory_search ────────────────────────────────────────────────────
server.registerTool(
  "memory_search",
  {
    title: "检索记忆",
    description:
      "按「语义 + 字图 + 词法」融合召回已存记忆，返回按相关度降序的条目（含分数与来源通道）。" +
      "语义层不可用时自动降级到字图/FTS5，不会报错。",
    inputSchema: {
      query: z.string().min(1).describe("检索关键词或自然语言问句"),
      limit: z.number().int().min(1).max(50).optional().describe("返回条数上限，默认 8"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ query, limit }) => {
    const top = limit ?? 8;
    const results = await engine.recall(query, { limit: top });
    if (results.length === 0) {
      return { content: [{ type: "text", text: `未检索到与「${query}」相关的记忆。` }] };
    }
    const text = results
      .map((r, i) => `${i + 1}. [score=${r.score.toFixed(4)}] (${r.source})\n   ${r.content.replace(/\s+/g, " ").slice(0, 400)}`)
      .join("\n");
    return { content: [{ type: "text", text }] };
  },
);

// ── memory_remember ──────────────────────────────────────────────────
server.registerTool(
  "memory_remember",
  {
    title: "写入记忆",
    description:
      "把一段对话或事实写入长期记忆（四通道分片 → 灵络认知图 → 向量索引）。" +
      "无 LLM key 时会退化为原文兜底碎片，仍会写入。返回写入的碎片数。",
    inputSchema: {
      transcript: z.string().min(1).describe("要记住的内容，可直接给原文对话"),
      sessionId: z.string().optional().describe("会话 ID，用于把同一来源的碎片归并"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ transcript, sessionId }) => {
    const n = await engine.remember({ transcript, sessionId });
    const text = n > 0
      ? `已写入 ${n} 条记忆碎片。`
      : "内容无实质信息量（空/纯确认/仅标点），未写入任何碎片。";
    return { content: [{ type: "text", text }] };
  },
);

// ── 启动 ─────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);

// 只写 stderr：stdout 归 JSON-RPC。
console.error(`[灵犀MCP] ready — db=${cfg.dbPath} (${cfg.dbPathSource}), project=${cfg.projectId}, env=${ENV_FILE ?? "(未找到)"}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.error(`[灵犀MCP] ${sig} — 退出`);
    process.exit(0);
  });
}
