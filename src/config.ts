// config.ts — 单一配置契约（P2）
//
// 旧版有三套各自为政的库路径解析（本文件 / db/connection.ts / engine.ts），
// 其中本文件零引用（死代码），engine.ts 还会把 AGENTMEMORY_HOME 与
// ".agentmemory" 二次拼接，产生 ~/.agentmemory/.agentmemory/memory.db 空库。
// 现在所有路径解析都必须经过 resolveConfig()。
//
// dbPath 解析顺序：
//   1. 显式传入的 override（宿主注入优先）
//   2. LINGXI_DB_PATH
//   3. LINGXI_HOME/memory.db
//   4. 已存在的历史库（~/.agentmemory、~/.lingxi-server）—— 兼容，避免升级后丢数据
//   5. ~/.lingxi/memory.db（全新安装的默认位置）
//
// 第 4 步是对改造计划的一处有意偏离：计划原为直接落到 ~/.lingxi，
// 但那会使用户既有的 602 条记忆在升级后"消失"。宁可多一步存在性探测。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface LingxiConfig {
  home: string;
  dbPath: string;
  /** dbPath 的来源，供 `lingxi doctor` 展示与排障 */
  dbPathSource: string;
  projectId: string;
  profileId: string;
  claudeProjectsDir: string;
  isDebug: boolean;
}

/** 历史库位置，按优先级排列（仅用于第 4 步的存在性探测）。 */
const LEGACY_DB_DIRS = [".agentmemory", ".lingxi-server"];

export function resolveConfig(
  overrides: { dbPath?: string; projectId?: string; profileId?: string } = {},
): LingxiConfig {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir() || ".";
  const env = process.env;

  let dbPath: string;
  let dbPathSource: string;
  if (overrides.dbPath) {
    dbPath = overrides.dbPath;
    dbPathSource = "config.dbPath (explicit)";
  } else if (env.LINGXI_DB_PATH) {
    dbPath = env.LINGXI_DB_PATH;
    dbPathSource = "LINGXI_DB_PATH";
  } else if (env.LINGXI_HOME) {
    dbPath = path.join(env.LINGXI_HOME, "memory.db");
    dbPathSource = "LINGXI_HOME";
  } else {
    const legacy = LEGACY_DB_DIRS
      .map((d) => path.join(home, d, "memory.db"))
      .find((p) => fs.existsSync(p));
    if (legacy) {
      dbPath = legacy;
      dbPathSource = "legacy DB (compat)";
    } else {
      dbPath = path.join(home, ".lingxi", "memory.db");
      dbPathSource = "default (~/.lingxi)";
    }
  }

  const projectId = overrides.projectId || env.LINGXI_PROJECT_ID || "C--Users-Administrator";
  const profileId = overrides.profileId || env.LINGXI_PROFILE_ID || "user_default";

  return {
    home,
    dbPath,
    dbPathSource,
    projectId,
    profileId,
    claudeProjectsDir: env.LINGXI_CLAUDE_DIR || path.join(home, ".claude", "projects", projectId),
    isDebug: env.LINGXI_DEBUG === "1",
  };
}

/** 确保库文件所在目录存在。返回传入路径，便于链式使用。 */
export function ensureDbDir(dbPath: string): string {
  const dir = path.dirname(path.resolve(dbPath));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dbPath;
}

// ── 环境变量：LINGXI_* 优先，兼容旧名 AGENTMEMORY_* ──────────

const warnedLegacy = new Set<string>();

/**
 * 读取配置项：优先 `primary`（LINGXI_*），回退旧名 `legacy`（AGENTMEMORY_*）。
 * 命中旧名时打印一次弃用警告。旧名计划在下一个大版本移除。
 */
export function envWithLegacy(primary: string, legacy: string): string | undefined {
  const v = process.env[primary];
  if (v !== undefined) return v;
  const old = process.env[legacy];
  if (old !== undefined && !warnedLegacy.has(legacy)) {
    warnedLegacy.add(legacy);
    console.error(`[灵犀] 环境变量 ${legacy} 已弃用，请改用 ${primary}。`);
  }
  return old;
}

// ── 模型发现（P4.1）────────────────────────────────────────────
//
// 开箱即用的前提：用户不设任何环境变量也能找到模型；找不到时不崩溃，
// 而是返回 null 由调用方诚实降级（字图 + FTS5，status 标 degraded）。

export interface ModelPathResolution {
  /** cognitive_v5 ONNX 模型绝对路径；未找到为 null */
  cognitiveModelPath: string | null;
  /** cognitive 模型来源描述，供 `lingxi doctor` 展示 */
  cognitiveSource: string;
  /** 灵眸 macbert-2stage 模型目录（含 stage1.onnx/stage2.onnx）；未找到为 null */
  lingmouModelDir: string | null;
  lingmouSource: string;
  /** tokenizer/vocab.txt 绝对路径；未找到为 null */
  vocabPath: string | null;
  vocabSource: string;
  /** 解析过程中的告警（命中旧默认路径 / 未找到模型） */
  warnings: string[];
}

/**
 * 同目录内的候选顺序。
 *
 * 实测（2026-09-11，cognitive_v5.onnx → int8）：体积 416.8MB→105.0MB（25%），
 * 加载 808ms→410ms，但 fp32/int8 的向量自一致性只有 mean cos=0.916（min 0.829），
 * 且检索 top-5 只重合 3/5。本仓库多处使用**绝对分数阈值**（如 s > 0.45），
 * 分数整体偏移会改变召回结果 —— 所以不能让 int8 静默成为默认。
 *
 * 默认 fp32 优先（保真）；int8 仅在 fp32 缺失时使用（并告警），
 * 或由 LINGXI_PREFER_INT8=1 显式启用。
 */
const FP32_FILE = "cognitive_v5.onnx";
const INT8_FILE = "cognitive_v5.int8.onnx";

/** 允许在候选里出现的模型文件名（int8 亦可被发现，只是顺序在后）。 */
const COGNITIVE_MODEL_FILES = [FP32_FILE, INT8_FILE];

function orderedCognitiveModelFiles(): string[] {
  const preferInt8 =
    (envWithLegacy("LINGXI_PREFER_INT8", "AGENTMEMORY_PREFER_INT8") ?? "0") !== "0";
  return preferInt8 ? [INT8_FILE, FP32_FILE] : [FP32_FILE, INT8_FILE];
}

/** 灵眸 two-stage 模型文件（两个都需存在才认为该目录可用）。 */
const LINGMOU_MODEL_FILES = ["stage1.onnx", "stage2.onnx"];

/** 旧版本写死的模型目录；仍支持，但命中时告警，提示迁移。 */
const LEGACY_COGNITIVE_DIRS = ["D:/AgentMemory/tools/cognitive-model-output"];
const LEGACY_LINGMOU_DIRS = ["D:/AgentMemory/tools/two-stage-output"];

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * 多候选发现模型路径。**永不抛错、永不 exit**。
 *
 * cognitive 模型：显式 COGNITIVE_MODEL_PATH > LINGXI_MODEL_DIR > ~/.lingxi/models > 旧默认路径（告警）
 * vocab：模型同目录 > LINGXI_MODEL_DIR > ~/.lingxi/models > 旧默认路径（告警）
 * 灵眸：LINGXI_MODEL_DIR > ~/.lingxi/models > 旧默认路径（告警）
 */
export function resolveModelPath(
  overrides: { modelPath?: string } = {},
): ModelPathResolution {
  const warnings: string[] = [];
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir() || ".";
  const explicit = overrides.modelPath || process.env.COGNITIVE_MODEL_PATH || "";
  const userDir = envWithLegacy("LINGXI_MODEL_DIR", "AGENTMEMORY_MODEL_DIR") || "";
  const newDefault = path.join(home, ".lingxi", "models");

  // 用户可指定的“模型根目录”候选（用于找模型、vocab、灵眸三样东西）
  const roots: Array<{ dir: string; src: string; legacy: boolean }> = [];
  if (userDir) roots.push({ dir: userDir, src: "LINGXI_MODEL_DIR", legacy: false });
  roots.push({ dir: newDefault, src: "~/.lingxi/models", legacy: false });
  for (const d of LEGACY_COGNITIVE_DIRS) roots.push({ dir: d, src: `旧默认路径 ${d}`, legacy: true });
  for (const d of LEGACY_LINGMOU_DIRS) roots.push({ dir: d, src: `旧默认路径 ${d}`, legacy: true });

  // 1) cognitive 模型
  let cognitiveModelPath: string | null = null;
  let cognitiveSource = "";
  const modelCands: Array<{ p: string; src: string; legacy: boolean }> = [];
  const modelFiles = orderedCognitiveModelFiles();
  if (explicit) modelCands.push({ p: explicit, src: "COGNITIVE_MODEL_PATH (explicit)", legacy: false });
  for (const r of roots) {
    for (const f of modelFiles) {
      modelCands.push({ p: path.join(r.dir, f), src: r.src, legacy: r.legacy });
    }
  }
  for (const c of modelCands) {
    if (isFile(c.p)) {
      cognitiveModelPath = path.resolve(c.p);
      cognitiveSource = c.src;
      if (c.legacy) {
        warnings.push(`cognitive 模型命中旧默认路径：${cognitiveModelPath}；建议迁到 ${newDefault} 或设 LINGXI_MODEL_DIR`);
      }
      if (path.basename(cognitiveModelPath) === INT8_FILE) {
        warnings.push(
          "正在使用 int8 量化模型：体积约为 fp32 的 25%，但实测自一致性 cos≈0.92、检索 top-5 重合 3/5；" +
          "绝对分数阈值可能偏移。如需最高保真请提供 fp32 的 cognitive_v5.onnx",
        );
      }
      break;
    }
  }
  if (!cognitiveModelPath) {
    cognitiveSource = "未找到";
    warnings.push(`未找到 cognitive 模型（已尝试 ${modelCands.length} 个候选）—— 语义层不可用，退化为 字图 + FTS5`);
  }

  // 2) tokenizer vocab
  let vocabPath: string | null = null;
  let vocabSource = "";
  const vocabCands: Array<{ p: string; src: string; legacy: boolean }> = [];
  if (cognitiveModelPath) {
    vocabCands.push({
      p: path.join(path.dirname(cognitiveModelPath), "tokenizer", "vocab.txt"),
      src: "模型同目录/tokenizer",
      legacy: false,
    });
  }
  for (const r of roots) {
    vocabCands.push({ p: path.join(r.dir, "tokenizer", "vocab.txt"), src: r.src, legacy: r.legacy });
  }
  for (const c of vocabCands) {
    if (isFile(c.p)) {
      vocabPath = path.resolve(c.p);
      vocabSource = c.src;
      if (c.legacy) warnings.push(`tokenizer vocab 命中旧默认路径：${vocabPath}`);
      break;
    }
  }
  if (!vocabPath) {
    vocabSource = "未找到";
    warnings.push(`未找到 tokenizer/vocab.txt（已尝试 ${vocabCands.length} 个候选）—— 无法编码文本`);
  }

  // 3) 灵眸 two-stage 模型目录
  let lingmouModelDir: string | null = null;
  let lingmouSource = "";
  for (const r of roots) {
    if (!isDir(r.dir)) continue;
    if (LINGMOU_MODEL_FILES.every((f) => isFile(path.join(r.dir, f)))) {
      lingmouModelDir = path.resolve(r.dir);
      lingmouSource = r.src;
      if (r.legacy) warnings.push(`灵眸模型命中旧默认路径：${lingmouModelDir}；建议迁到 ${newDefault}`);
      break;
    }
  }
  if (!lingmouModelDir) {
    lingmouSource = "未找到";
    warnings.push(`未找到灵眸模型（需 ${LINGMOU_MODEL_FILES.join(" + ")}）—— 通道分类不可用`);
  }

  return {
    cognitiveModelPath,
    cognitiveSource,
    lingmouModelDir,
    lingmouSource,
    vocabPath,
    vocabSource,
    warnings,
  };
}
