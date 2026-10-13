#!/usr/bin/env node
// cli.ts — 灵犀记忆服务 CLI
//
// 与 MCP server 并列的第二种传输层：给不方便挂 MCP 的场合（脚本、CI、人工排障）用。
//
//   lingxi remember <文本>    写入记忆
//   lingxi recall  <查询>     检索记忆
//   lingxi status             完整状态（含数据现实与告警）
//   lingxi doctor             排障所需的全部信息
//   lingxi reindex            重建字图 / 向量索引（复用存量向量，不重编码）

import { parseArgs } from "node:util";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnvFile } from "./load-env.js";
import { openDb } from "./db/connection.js";
import { resolveConfig, resolveModelPath } from "./config.js";
import { createLingxiEngine } from "./engine.js";

const ENV_FILE = loadEnvFile();

const USAGE = `灵犀记忆服务 CLI

用法: lingxi <命令> [选项]

命令:
  remember <文本>     写入记忆（--session <id> --project <id>）
  recall <查询>       检索记忆（--limit <n>，默认 8）
  status              打印完整系统状态（含数据现实与数据告警）
  doctor              打印排障所需的全部信息（版本/配置/模型/能力/环境变量）
  reindex             重建字图与向量索引（复用已存向量，不重新编码）

选项:
  --json              以 JSON 输出（status / doctor）
  --limit <n>         recall 返回条数上限
  --session <id>      remember 的会话 ID
  --project <id>      remember 的项目 ID
  -h, --help          显示本帮助

退出码:
  0  正常（含 degraded —— 服务可用，但有降级项）
  1  down —— 关键能力不可用
  2  用法 / 参数错误`;

function pkgVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const j = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf-8")) as { version?: string };
    return j.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** 展示环境变量：密钥类只报告是否已设置，绝不打印值。 */
function envSnapshot(): Record<string, string> {
  const names = [
    "LINGXI_DB_PATH", "LINGXI_HOME", "LINGXI_MODEL_DIR", "COGNITIVE_MODEL_PATH",
    "LINGXI_SEMANTIC", "LINGXI_STRICT", "LINGXI_PREFER_INT8", "LINGXI_DEBUG",
    "LINGXI_PROJECT_ID", "LINGXI_PROFILE_ID",
  ];
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = process.env[n];
    out[n] = v === undefined || v === "" ? "(unset)" : v;
  }
  const key = process.env.DEEPSEEK_API_KEY;
  out.DEEPSEEK_API_KEY = key && key.length > 10 ? `已设置（${key.length} 字符，不显示）` : "(unset)";
  for (const legacy of ["AGENTMEMORY_MODEL_DIR", "AGENTMEMORY_SEMANTIC", "AGENTMEMORY_HOME"]) {
    if (process.env[legacy] !== undefined) out[`${legacy} (已弃用)`] = process.env[legacy] || "(empty)";
  }
  return out;
}

async function cmdStatus(asJson: boolean): Promise<number> {
  const cfg = resolveConfig();
  const engine = createLingxiEngine({ dbPath: cfg.dbPath });
  await engine.probeAll();
  const s = engine.status();

  if (asJson) {
    console.log(JSON.stringify(s, null, 2));
    return s.overall === "down" ? 1 : 0;
  }
  console.log(await engine.formatStatus());
  return s.overall === "down" ? 1 : 0;
}

async function cmdDoctor(asJson: boolean): Promise<number> {
  const cfg = resolveConfig();
  const model = resolveModelPath();
  const engine = createLingxiEngine({ dbPath: cfg.dbPath });
  await engine.probeAll();
  const s = engine.status();

  let dbSize: number | null = null;
  try { dbSize = existsSync(cfg.dbPath) ? statSync(cfg.dbPath).size : null; } catch { dbSize = null; }

  const report = {
    version: pkgVersion(),
    runtime: { node: process.version, platform: `${process.platform} ${process.arch}` },
    envFile: ENV_FILE,
    db: {
      path: cfg.dbPath,
      source: cfg.dbPathSource,
      exists: existsSync(cfg.dbPath),
      sizeBytes: dbSize,
      sizeMB: dbSize === null ? null : Math.round(dbSize / 1e6 * 10) / 10,
    },
    project: { id: cfg.projectId, profileId: cfg.profileId, claudeProjectsDir: cfg.claudeProjectsDir },
    models: {
      cognitive: { path: model.cognitiveModelPath, source: model.cognitiveSource },
      vocab: { path: model.vocabPath, source: model.vocabSource },
      lingmou: { dir: model.lingmouModelDir, source: model.lingmouSource },
      warnings: model.warnings,
    },
    env: envSnapshot(),
    status: {
      overall: s.overall,
      criticalDown: s.criticalDown,
      degradedList: s.degradedList,
      errors: s.errors,
      dataReality: s.dataReality,
      dataWarnings: s.dataWarnings,
      capabilities: Object.fromEntries(
        Object.entries(s.capabilities).map(([k, v]) => [k, { status: v.status, label: v.label, lastError: v.lastError }]),
      ),
    },
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return s.overall === "down" ? 1 : 0;
  }

  const line = (k: string, v: unknown) => console.log(`  ${k.padEnd(18)} ${v}`);
  console.log("═".repeat(64));
  console.log(`  灵犀记忆服务 doctor`);
  console.log("═".repeat(64));
  console.log("\n[版本 / 运行时]");
  line("version", report.version);
  line("node", report.runtime.node);
  line("platform", report.runtime.platform);
  line(".env", ENV_FILE ?? "(未找到)");

  console.log("\n[记忆库]");
  line("path", report.db.path);
  line("source", report.db.source);
  line("exists", report.db.exists);
  line("size", report.db.sizeMB === null ? "(缺失)" : `${report.db.sizeMB} MB`);

  console.log("\n[项目]");
  line("projectId", report.project.id);
  line("profileId", report.project.profileId);

  console.log("\n[模型]");
  line("cognitive", `${model.cognitiveModelPath ?? "(未找到)"}  ← ${model.cognitiveSource}`);
  line("vocab", `${model.vocabPath ?? "(未找到)"}  ← ${model.vocabSource}`);
  line("lingmou", `${model.lingmouModelDir ?? "(未找到)"}  ← ${model.lingmouSource}`);
  if (model.warnings.length > 0) {
    console.log("  模型告警:");
    for (const w of model.warnings) console.log(`    ! ${w}`);
  }

  console.log("\n[环境变量]");
  for (const [k, v] of Object.entries(report.env)) line(k, v);

  console.log("\n[能力 / 数据现实]");
  console.log(await engine.formatStatus());

  console.log("\n" + "═".repeat(64));
  console.log(s.overall === "down"
    ? "  结论: down —— 关键能力不可用，请先看上面 [最近错误]"
    : s.overall === "degraded"
      ? "  结论: degraded —— 服务可用，但有降级项（见 [降级/失效] 与 [数据告警]）"
      : "  结论: healthy");
  console.log("═".repeat(64));
  return s.overall === "down" ? 1 : 0;
}

async function cmdRemember(text: string, sessionId?: string, projectId?: string): Promise<number> {
  const cfg = resolveConfig();
  const engine = createLingxiEngine({ dbPath: cfg.dbPath, projectId });
  const n = await engine.remember({ transcript: text, sessionId });
  if (n > 0) {
    console.log(`已写入 ${n} 条记忆碎片。`);
    return 0;
  }
  console.log("内容无实质信息量（空 / 纯确认 / 仅标点），未写入任何碎片。");
  return 0;
}

async function cmdRecall(query: string, limit: number): Promise<number> {
  const cfg = resolveConfig();
  const engine = createLingxiEngine({ dbPath: cfg.dbPath });
  const results = await engine.recall(query, { limit });
  if (results.length === 0) {
    console.log(`未检索到与「${query}」相关的记忆。`);
    return 0;
  }
  results.forEach((r, i) => {
    console.log(`${i + 1}. [score=${r.score.toFixed(4)}] (${r.source})`);
    console.log(`   ${r.content.replace(/\s+/g, " ").slice(0, 400)}`);
  });
  return 0;
}

async function cmdReindex(): Promise<number> {
  const cfg = resolveConfig();
  openDb(cfg.dbPath);

  const { initGraph } = await import("./core/dcgk-engine.js");
  initGraph();
  console.log("灵络: 认知图已初始化");

  try {
    const cg = await import("./core/char-graph.js");
    const stats = cg.buildGraph(cfg.projectId);
    console.log(`字图: ${stats.nodeCount} 节点 ${stats.edgeCount} 边 ${stats.buildTimeMs}ms`);
  } catch (e) {
    console.log(`字图: 重建失败（${e instanceof Error ? e.message : e}）`);
  }

  try {
    const vi = await import("./core/fragment-vector-index.js");
    const stats = await vi.buildVectorIndex(cfg.projectId);
    console.log(`向量索引: ${stats.entryCount} 条碎片 ${stats.buildTimeMs}ms`);
  } catch (e) {
    console.log(`向量索引: 不可用（${e instanceof Error ? e.message : e}）`);
  }
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    console.log(USAGE);
    return argv.length === 0 ? 2 : 0;
  }

  const cmd = argv[0]!;
  let parsed;
  try {
    parsed = parseArgs({
      args: argv.slice(1),
      options: {
        limit: { type: "string" },
        session: { type: "string" },
        project: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
    });
  } catch (e) {
    console.error(`参数错误: ${e instanceof Error ? e.message : e}`);
    console.error(USAGE);
    return 2;
  }

  const { values, positionals } = parsed;
  if (values.help) { console.log(USAGE); return 0; }
  const asJson = values.json === true;

  switch (cmd) {
    case "status":
      return cmdStatus(asJson);
    case "doctor":
      return cmdDoctor(asJson);
    case "remember": {
      const text = positionals.join(" ").trim();
      if (!text) { console.error("用法: lingxi remember <文本>"); return 2; }
      return cmdRemember(text, values.session, values.project);
    }
    case "recall": {
      const query = positionals.join(" ").trim();
      if (!query) { console.error("用法: lingxi recall <查询> [--limit n]"); return 2; }
      const limit = values.limit === undefined ? 8 : Number.parseInt(values.limit, 10);
      if (!Number.isFinite(limit) || limit < 1) { console.error("--limit 必须是 >= 1 的整数"); return 2; }
      return cmdRecall(query, limit);
    }
    case "reindex":
      return cmdReindex();
    default:
      console.error(`未知命令: ${cmd}\n`);
      console.log(USAGE);
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("失败:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
