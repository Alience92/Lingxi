// engine.ts — 灵犀记忆引擎宿主无关入口
//
// createLingxiEngine(config) 返回宿主无关的记忆引擎 API，供外部宿主
// （DSH Adapter / 手机壳 / Claude Code hooks）复用。工厂负责注入
// 依赖（DB 路径 / LLM / 模型目录），内部模块照常工作。
//
// 注入依赖：
//   dbPath            记忆库路径（默认 ~/.agentmemory）
//   llm               LLM 回调（DSH 用 ctx.llm 适配；不传则用 DEEPSEEK_API_KEY）
//   modelDir          灵眸/cognitive 模型目录
//   cognitiveModelPath cognitive_v5 模型路径
//   projectId / profileId  会话隔离

import { v4 as uuid } from "uuid";
import { openDb, getDb } from "./db/connection.js";
import { resolveConfig } from "./config.js";
import { fragmentTranscript, isPureAck, type FragmentLlm } from "./core/fragmenter.js";
import { recallFromCognitiveGraph, searchMemories } from "./core/memory-recall.js";
import { runMemoryOrchestrator, type OrchestratorResult } from "./core/orchestrator.js";
import { recordFragment } from "./core/state-gate.js";
import { extractSignals, persistLightweightSignals } from "./core/lightweight-extractor.js";
import { SystemController, createDefaultSystemController, type SystemStatus } from "./system-controller.js";
import type { RecallResult } from "./core/memory-recall.js";

/** 宿主 LLM 回调（system 可空）。DSH Adapter 用 ctx.llm.stream 适配为 complete。 */
export interface LlmProvider {
  complete(system: string, user: string): Promise<string>;
}

export interface LingxiEngineConfig {
  dbPath?: string;
  llm?: LlmProvider;
  modelDir?: string;
  cognitiveModelPath?: string;
  projectId?: string;
  profileId?: string;
}

export interface LingxiEngine {
  /** 四通道分片入库。返回写入的碎片数。 */
  remember(input: { transcript: string; sessionId?: string; projectId?: string }): Promise<number>;
  /** 语义召回（字图 + cognitive 融合，失败自动降级）。 */
  recall(query: string, opts?: { limit?: number }): Promise<RecallResult[]>;
  /** 显式检索（失败自动降级）。 */
  search(query: string, limit?: number): Promise<string[]>;
  /** 触发一次统一维护周期（蒸馏/衰减/沙漏）。 */
  maintain(): Promise<OrchestratorResult>;
  /** 轻量信号摄入（无 LLM）。 */
  ingestSignal(text: string, role?: "user" | "assistant"): Promise<void>;
  /** 整体状态查询（能力健康/降级/错误）。 */
  status(): SystemStatus;
  /** 探测全部能力（刷新缓存）。 */
  probeAll(): Promise<Record<string, boolean>>;
  /** 格式化状态文本（自动先探测未探测能力；供工具/日志展示）。 */
  formatStatus(): Promise<string>;
}

/** 提取单条记忆输入中的实质内容（去角色前缀/语气词后取有信息量的主体） */
function extractContentBody(transcript: string): string {
  return transcript
    .split("\n")
    .map((l) => l.trim().replace(/^(用户|User|assistant|Assistant|助手|我)[:：]\s*/i, ""))
    .filter((l) => l.length > 0)
    .join(" ");
}

/** 判断输入是否有实质信息量（非纯确认/闲聊、非空、长度达标） */
export function hasSubstantiveContent(transcript: string): boolean {
  const body = extractContentBody(transcript);
  if (body.length < 4) return false;
  if (isPureAck(body)) return false;
  // 仅由标点/语气词/无信息符号构成 → 无实质内容
  if (/^[\s，。！？、；：""''（）()…\-—,.!?;:]+$/.test(body)) return false;
  return true;
}

/** 生成兜底 WHAT 碎片：原文做 summary，抽取关键词，无 LLM 依赖 */
export function buildFallbackFragment(
  transcript: string,
  sessionId: string,
  fragProjectId: string,
): Omit<import("./types.js").Fragment, "decayScore" | "lastRecalledAt" | "recalledCount" | "retrievalState" | "assetState" | "distilledTo"> | null {
  const body = extractContentBody(transcript);
  if (!hasSubstantiveContent(transcript)) return null;

  const clean = body.slice(0, 180);
  // 关键词：取前 5 个词/短语（中文按 4-8 字滑窗粗提取，英文按空格）
  const tokens: string[] = [];
  for (const m of body.matchAll(/[\u4e00-\u9fff]{2,8}|[A-Za-z][A-Za-z0-9_.-]{1,20}/g)) {
    const t = m[0];
    if (!tokens.includes(t)) tokens.push(t);
    if (tokens.length >= 5) break;
  }

  return {
    id: uuid(),
    sessionId,
    projectId: fragProjectId,
    anchors: [{
      channel: "WHAT",
      label: clean.slice(0, 50),
      weight: 10,
      source: "clustering",
      timestamp: Date.now(),
    }],
    linkedIds: [],
    linkedCount: 0,
    summary: clean,
    subtype: null,
    scope: null,
    keywords: tokens.join(", "),
    rawPrefix: null,
    createdAt: Date.now(),
  };
}

export function createLingxiEngine(config: LingxiEngineConfig): LingxiEngine {
  // ── 注入依赖 ──────────────────────────────────────────────────
  // 库路径统一走 resolveConfig()：旧版在此把 AGENTMEMORY_HOME 与 ".agentmemory"
  // 二次拼接，会得到 ~/.agentmemory/.agentmemory/memory.db 这样的空库。
  const cfg = resolveConfig({
    dbPath: config.dbPath,
    projectId: config.projectId,
    profileId: config.profileId,
  });
  openDb(cfg.dbPath);

  if (config.modelDir) process.env.LINGXI_MODEL_DIR = config.modelDir;
  if (config.cognitiveModelPath) process.env.COGNITIVE_MODEL_PATH = config.cognitiveModelPath;
  process.env.LINGXI_PROJECT_ID = cfg.projectId;
  process.env.LINGXI_PROFILE_ID = cfg.profileId;

  const projectId = cfg.projectId;
  const apiKey = process.env.DEEPSEEK_API_KEY || "";
  const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";

  // 分片 LLM：注入的 llm 优先，否则 OpenAI 默认
  const fragmentLlm: FragmentLlm | undefined = config.llm
    ? (prompt: string) => config.llm!.complete("", prompt)
    : undefined;

  // ── 整体层：能力注册 + 健康探测 + 降级链 + 熔断 ──────────────
  // 异步注册（探测器含动态 import），失败不阻塞引擎创建——降级为无整体层。
  let controller: SystemController | null = null;
  createDefaultSystemController().then((c) => { controller = c; }).catch(() => {});
  const getController = async (): Promise<SystemController | null> => {
    if (!controller) {
      try { controller = await createDefaultSystemController(); } catch { return null; }
    }
    return controller;
  };

  return {
    async remember(input) {
      const sessionId = input.sessionId || `engine-${Date.now()}`;
      const fragProjectId = input.projectId || projectId;

      // 分片（LLM 能力）→ 失败时整体层兜底为直接落库原文碎片
      const ctrl = await getController();
      const r = ctrl
        ? await ctrl.withCapability<number>(
            "llm",
            async () => {
              const { output } = await fragmentTranscript(
                { transcript: input.transcript, sessionId, projectId: fragProjectId },
                apiKey, model, "https://api.deepseek.com", fragmentLlm,
              );
              let fragments = output.fragments.slice(0, 30);
              if (fragments.length === 0 && hasSubstantiveContent(input.transcript)) {
                const fallback = buildFallbackFragment(input.transcript, sessionId, fragProjectId);
                if (fallback) fragments = [fallback];
              }
              for (const f of fragments) {
                recordFragment({
                  sessionId,
                  projectId: fragProjectId,
                  summary: f.summary,
                  keywords: f.keywords,
                  subtype: f.subtype ?? null,
                  rawText: input.transcript.length <= 500 ? input.transcript : undefined,
                }, "engine");
              }
              return fragments.length;
            },
            () => {
              // LLM 失效降级：直接落原文（保证记录不丢失）
              if (hasSubstantiveContent(input.transcript)) {
                const fallback = buildFallbackFragment(input.transcript, sessionId, fragProjectId);
                if (fallback) {
                  recordFragment({
                    sessionId,
                    projectId: fragProjectId,
                    summary: fallback.summary,
                    keywords: fallback.keywords,
                    subtype: fallback.subtype ?? null,
                    rawText: input.transcript.length <= 500 ? input.transcript : undefined,
                  }, "engine-fallback");
                  return 1;
                }
              }
              return 0;
            },
          )
        : { ok: true, value: 0, degradedTo: null };

      // 无整体层时保持原逻辑
      if (!ctrl) {
        const { output } = await fragmentTranscript(
          { transcript: input.transcript, sessionId, projectId: fragProjectId },
          apiKey, model, "https://api.deepseek.com", fragmentLlm,
        );
        let fragments = output.fragments.slice(0, 30);
        if (fragments.length === 0 && hasSubstantiveContent(input.transcript)) {
          const fallback = buildFallbackFragment(input.transcript, sessionId, fragProjectId);
          if (fallback) fragments = [fallback];
        }
        for (const f of fragments) {
          recordFragment({
            sessionId,
            projectId: fragProjectId,
            summary: f.summary,
            keywords: f.keywords,
            subtype: f.subtype ?? null,
            rawText: input.transcript.length <= 500 ? input.transcript : undefined,
          }, "engine");
        }
        return fragments.length;
      }

      return r.value ?? 0;
    },

    async recall(query, opts) {
      // 语义召回（cognitive + 灵络融合）→ 失败降级到显式搜索
      const ctrl = await getController();
      if (!ctrl) return recallFromCognitiveGraph(query, opts?.limit ?? 5);
      const r = await ctrl.withCapability<RecallResult[]>(
        "cognitive",
        () => recallFromCognitiveGraph(query, opts?.limit ?? 5),
        async () => {
          const strings = await searchMemories(query, opts?.limit ?? 5);
          return strings.map((s, i) => ({
            content: s,
            score: Math.max(0, 1 - i * 0.1),
            source: "v5_retriever" as const,
          }));
        },
      );
      return r.value ?? [];
    },

    async search(query, limit) {
      // 显式检索 → 失败降级到 FTS5/原始匹配（searchMemories 内部已有 V5 降级）
      const ctrl = await getController();
      if (!ctrl) return searchMemories(query, limit ?? 5);
      const r = await ctrl.withCapability<string[]>(
        "chargraph",
        () => searchMemories(query, limit ?? 5),
        async () => {
          // 最后兜底：LIKE 匹配
          const db = getDb();
          const rows = db.prepare(
            "SELECT summary FROM fragments WHERE project_id = ? AND (summary LIKE ? OR keywords LIKE ?) AND retrieval_state IN ('active','warm') AND asset_state != 'user_deleted' ORDER BY decay_score DESC LIMIT ?"
          ).all(projectId, `%${query}%`, `%${query}%`, limit ?? 5) as Array<{ summary: string }>;
          return rows.map((r) => r.summary);
        },
      );
      return r.value ?? [];
    },

    async maintain() {
      return runMemoryOrchestrator();
    },

    async ingestSignal(text, role = "user") {
      const signals = role === "assistant"
        ? (await import("./core/lightweight-extractor.js")).extractAssistantSignals(text)
        : extractSignals(text);
      if (signals.length > 0) {
        persistLightweightSignals(projectId, `engine-${Date.now()}`, signals);
      }
    },

    status(): SystemStatus {
      const c = controller;
      return c ? c.status() : {
        overall: "degraded",
        capabilities: {},
        criticalDown: [],
        degradedList: [],
        errors: ["整体层未初始化"],
        dataReality: null,
        dataWarnings: ["整体层未初始化 —— 数据现实未探测"],
        checkedAt: Date.now(),
      };
    },

    async probeAll(): Promise<Record<string, boolean>> {
      const c = await getController();
      return c ? c.probeAll(true) : {};
    },

    async formatStatus(): Promise<string> {
      const c = await getController();
      return c ? c.formatStatusAsync() : "整体层未初始化";
    },
  };
}
