// system-controller.ts — 灵犀记忆系统整体层（System Controller）
//
// 目标：让整个记忆系统成为一个自愈的整体——每个能力都有健康探测、降级链、
// 熔断与自动恢复，单个能力失效不阻塞其他能力，且整体状态可观测。
//
// 设计原则：
//  - 不侵入各核心模块（只包装调用，模块本身保持职责单一）
//  - 探测结果带 TTL 缓存，避免每次调用都触发重探测拖慢主路径
//  - 能力失败 → 标记 degraded → 走降级链 → 绝不静默丢失
//  - 熔断后由 probe() 探测恢复，自动回 live
//
// 能力列表（与核心模块一一对应）：
//   db            数据库（读写基础）
//   llm           分片/生成 LLM（DSH ctx.llm 或 DeepSeek API）
//   lingmou       灵眸 encoder（macbert-2stage 通道分类）
//   cognitive     cognitive_v5 语义向量检索
//   chargraph     字图检索
//   lingluo       DCGK 灵络认知图
//   hourglass     碎片沙漏（维护）
//   distill       蒸馏（用户模型内化）
//   signals       轻量信号
//   orchestrator  生命周期维护周期

import { getDb } from "./db/connection.js";
import { envWithLegacy, resolveModelPath } from "./config.js";

export type CapabilityStatus = "live" | "degraded" | "down" | "unknown";

export interface CapabilityProbe {
  /** 健康探测：成功返回 true，失败抛错或返回 false */
  (): boolean | Promise<boolean>;
  /** 探测描述（用于 status 展示） */
  describe?: string;
}

export interface Capability<T = unknown> {
  id: string;
  label: string;
  probe: CapabilityProbe;
  /** 是否关键能力（down 时记入系统级告警） */
  critical?: boolean;
  /** 最近一次失败的错误信息 */
  lastError: string | null;
  /** 当前状态 */
  status: CapabilityStatus;
  /** 连续失败计数（熔断用） */
  consecutiveFailures: number;
  /** 最近一次状态变化时间 */
  lastTransitionAt: number;
  /** 最近一次探测时间 */
  lastProbeAt: number;
}

/** 数据的实际形态 —— 与能力状态位正交。状态位说“接口通不通”，它说“数据在不在”。 */
export interface DataReality {
  fragments: number;
  withCognitiveVectors: number;
  graphNodes: number;
  graphEdges: number;
}

export interface SystemStatus {
  overall: "healthy" | "degraded" | "down";
  capabilities: Record<string, {
    status: CapabilityStatus;
    label: string;
    lastError: string | null;
    lastProbeAt: number;
    consecutiveFailures: number;
  }>;
  criticalDown: string[];
  degradedList: string[];
  errors: string[];
  /** 数据现实；DB 未打开时为 null */
  dataReality: DataReality | null;
  /** 由数据现实推出的告警（会阻止 overall 判为 healthy） */
  dataWarnings: string[];
  checkedAt: number;
}

const PROBE_TTL_MS = 30_000;      // 探测结果缓存 30s
const CIRCUIT_BREAK_THRESHOLD = 3; // 连续失败 3 次熔断 → degraded

/** 读取数据现实。单条查询失败按 0 计；DB 未打开则返回 null —— 绝不因此抛错。 */
function readDataReality(): DataReality | null {
  let db;
  try { db = getDb(); } catch { return null; }
  const one = (sql: string): number => {
    try { return (db.prepare(sql).get() as { c?: number } | undefined)?.c ?? 0; } catch { return 0; }
  };
  return {
    fragments: one("SELECT COUNT(*) AS c FROM fragments"),
    withCognitiveVectors: one(
      "SELECT COUNT(*) AS c FROM fragments WHERE vector IS NOT NULL AND vector_model = 'cognitive_v5'",
    ),
    graphNodes: one("SELECT COUNT(*) AS c FROM dcgk_nodes"),
    graphEdges: one("SELECT COUNT(*) AS c FROM dcgk_edges"),
  };
}

/** 由数据现实推出告警。这些告警会阻止 overall 被判为 healthy。 */
function deriveDataWarnings(r: DataReality | null): string[] {
  if (!r) return [];
  const out: string[] = [];
  if (r.fragments > 0 && r.graphNodes === 0) {
    out.push(`有 ${r.fragments} 条碎片但灵络认知图为空（0 节点）—— 图谱推演路径不可用`);
  }
  if (r.fragments > 0) {
    const ratio = r.withCognitiveVectors / r.fragments;
    if (ratio < 0.5) {
      out.push(
        `仅 ${r.withCognitiveVectors}/${r.fragments} 条碎片有 cognitive_v5 向量` +
        `（${(ratio * 100).toFixed(0)}%）—— 语义召回覆盖不足`,
      );
    }
  }
  return out;
}

export class SystemController {
  private capabilities = new Map<string, Capability>();
  private probeCache = new Map<string, { ok: boolean; at: number }>();
  private errors: string[] = [];

  /** 注册一个能力 */
  register<T>(spec: {
    id: string;
    label: string;
    probe: CapabilityProbe;
    critical?: boolean;
  }): void {
    this.capabilities.set(spec.id, {
      id: spec.id,
      label: spec.label,
      probe: spec.probe,
      critical: spec.critical ?? false,
      lastError: null,
      status: "unknown",
      consecutiveFailures: 0,
      lastTransitionAt: Date.now(),
      lastProbeAt: 0,
    });
  }

  /** 探测单个能力（带 TTL 缓存） */
  async probe(id: string, force = false): Promise<boolean> {
    const cap = this.capabilities.get(id);
    if (!cap) return false;

    const cached = this.probeCache.get(id);
    if (!force && cached && Date.now() - cached.at < PROBE_TTL_MS) {
      return cached.ok;
    }

    let ok = false;
    try {
      ok = await cap.probe();
    } catch (e) {
      ok = false;
      cap.lastError = e instanceof Error ? e.message : String(e);
    }
    cap.lastProbeAt = Date.now();
    this.probeCache.set(id, { ok, at: Date.now() });

    // 状态迁移：熔断 + 自动恢复
    // 语义：down = 当前探测失败（瞬时）；degraded = 连续失败达阈值（已熔断，持续故障）
    if (ok) {
      if (cap.status !== "live") {
        cap.status = "live";
        cap.lastTransitionAt = Date.now();
      }
      cap.consecutiveFailures = 0;
      cap.lastError = null;
    } else {
      cap.consecutiveFailures++;
      if (cap.consecutiveFailures >= CIRCUIT_BREAK_THRESHOLD) {
        // 达到熔断阈值 → degraded（持续故障）
        if (cap.status !== "degraded") {
          cap.status = "degraded";
          cap.lastTransitionAt = Date.now();
        }
      } else if (cap.status !== "down") {
        // 首次/少量失败 → down（瞬时）
        cap.status = "down";
        cap.lastTransitionAt = Date.now();
      }
      // 记录错误（保留最近 20 条）
      if (cap.lastError) {
        this.errors.push(`[${cap.id}] ${cap.lastError}`);
        if (this.errors.length > 20) this.errors.shift();
      }
    }
    return ok;
  }

  /** 探测所有能力 */
  async probeAll(force = false): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    for (const id of this.capabilities.keys()) {
      out[id] = await this.probe(id, force);
    }
    return out;
  }

  /** 执行一个能力调用，失败时走降级路径并标记 degraded */
  async withCapability<T>(
    id: string,
    fn: () => Promise<T> | T,
    fallback?: () => Promise<T> | T,
  ): Promise<{ ok: boolean; value: T | null; degradedTo: string | null }> {
    const cap = this.capabilities.get(id);
    try {
      const value = await fn();
      if (cap) {
        cap.consecutiveFailures = 0;
        cap.lastError = null;
        if (cap.status !== "live") {
          cap.status = "live";
          cap.lastTransitionAt = Date.now();
        }
        this.probeCache.set(id, { ok: true, at: Date.now() });
      }
      return { ok: true, value, degradedTo: null };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (cap) {
        cap.lastError = msg;
        cap.consecutiveFailures++;
        if (cap.consecutiveFailures >= CIRCUIT_BREAK_THRESHOLD) {
          if (cap.status !== "degraded") {
            cap.status = "degraded";
            cap.lastTransitionAt = Date.now();
          }
        } else if (cap.status !== "down") {
          cap.status = "down";
          cap.lastTransitionAt = Date.now();
        }
        this.probeCache.set(id, { ok: false, at: Date.now() });
        this.errors.push(`[${id}] ${msg}`);
        if (this.errors.length > 20) this.errors.shift();
      }
      if (fallback) {
        try {
          const fv = await fallback();
          return { ok: false, value: fv, degradedTo: id };
        } catch (fe) {
          this.errors.push(`[${id}/fallback] ${fe instanceof Error ? fe.message : String(fe)}`);
          if (this.errors.length > 20) this.errors.shift();
        }
      }
      return { ok: false, value: null, degradedTo: id };
    }
  }

  /** 标记一次外部观察到的能力失败（供调用方手动上报） */
  reportFailure(id: string, error: string): void {
    const cap = this.capabilities.get(id);
    if (!cap) return;
    cap.lastError = error;
    cap.consecutiveFailures++;
    if (cap.consecutiveFailures >= CIRCUIT_BREAK_THRESHOLD) {
      if (cap.status !== "degraded") {
        cap.status = "degraded";
        cap.lastTransitionAt = Date.now();
      }
    } else if (cap.status !== "down") {
      cap.status = "down";
      cap.lastTransitionAt = Date.now();
    }
    this.probeCache.set(id, { ok: false, at: Date.now() });
    this.errors.push(`[${id}] ${error}`);
    if (this.errors.length > 20) this.errors.shift();
  }

  /** 获取单个能力状态 */
  getStatus(id: string): Capability["status"] | undefined {
    return this.capabilities.get(id)?.status;
  }

  /** 整体状态查询 */
  status(): SystemStatus {
    const capabilities: SystemStatus["capabilities"] = {};
    const criticalDown: string[] = [];
    const degradedList: string[] = [];

    for (const cap of this.capabilities.values()) {
      capabilities[cap.id] = {
        status: cap.status,
        label: cap.label,
        lastError: cap.lastError,
        lastProbeAt: cap.lastProbeAt,
        consecutiveFailures: cap.consecutiveFailures,
      };
      if (cap.status === "down" && cap.critical) criticalDown.push(cap.id);
      if (cap.status === "degraded" || cap.status === "down") degradedList.push(cap.id);
    }

    const dataReality = readDataReality();
    const dataWarnings = deriveDataWarnings(dataReality);

    let overall: SystemStatus["overall"] = "healthy";
    if (criticalDown.length > 0) overall = "down";
    else if (degradedList.length > 0) overall = "degraded";
    // 状态位只能说“接口通不通”，不能凌驾于数据现实之上：
    // 数据明显不可用时，即使所有探针都通过也不得报 healthy。
    if (overall === "healthy" && dataWarnings.length > 0) overall = "degraded";

    return {
      overall,
      capabilities,
      criticalDown,
      degradedList,
      errors: [...this.errors],
      dataReality,
      dataWarnings,
      checkedAt: Date.now(),
    };
  }

  /** 格式化状态（console / 工具输出可读）。若能力尚未探测过，先触发一次探测。 */
  async formatStatusAsync(): Promise<string> {
    // 有未探测能力时先探测，避免输出全 unknown
    let needsProbe = false;
    for (const cap of this.capabilities.values()) {
      if (cap.status === "unknown" || cap.lastProbeAt === 0) { needsProbe = true; break; }
    }
    if (needsProbe) await this.probeAll();
    return this.formatStatus();
  }

  /** 格式化状态（console / 工具输出可读） */
  formatStatus(): string {
    const s = this.status();
    const lines = [
      `灵犀记忆系统整体状态: ${s.overall}`,
      `  检查时间: ${new Date(s.checkedAt).toLocaleString()}`,
      `  能力: ${Object.keys(s.capabilities).length} 个`,
    ];
    for (const [id, c] of Object.entries(s.capabilities)) {
      const mark = c.status === "live" ? "●" : c.status === "degraded" ? "▲" : c.status === "down" ? "✕" : "○";
      const err = c.lastError ? ` — ${c.lastError.slice(0, 80)}` : "";
      lines.push(`  ${mark} ${id} [${c.status}]${err}`);
    }
    if (s.degradedList.length > 0) lines.push(`  降级/失效: ${s.degradedList.join(", ")}`);
    if (s.criticalDown.length > 0) lines.push(`  关键失效: ${s.criticalDown.join(", ")}`);
    if (s.dataReality) {
      const d = s.dataReality;
      lines.push(
        `  数据现实: 碎片=${d.fragments}(有向量${d.withCognitiveVectors}) ` +
        `灵络节点=${d.graphNodes} 边=${d.graphEdges}`,
      );
    }
    if (s.dataWarnings.length > 0) {
      lines.push(`  数据告警 (${s.dataWarnings.length}):`);
      for (const w of s.dataWarnings) lines.push(`    ! ${w}`);
    }
    if (s.errors.length > 0) {
      lines.push(`  最近错误 (${s.errors.length}):`);
      for (const e of s.errors.slice(-5)) lines.push(`    - ${e.slice(0, 100)}`);
    }
    return lines.join("\n");
  }

  /** 获取原始错误列表 */
  getErrors(): string[] {
    return [...this.errors];
  }
}

/**
 * 构建默认能力注册表（标准探针，不侵入核心模块）。
 * 返回一个已注册好全部能力的 SystemController。
 */
export async function createDefaultSystemController(): Promise<SystemController> {
  const ctrl = new SystemController();

  // db — 数据库可读写
  ctrl.register({
    id: "db",
    label: "数据库",
    critical: true,
    probe: () => {
      const db = getDb();
      db.prepare("SELECT 1").get();
      return true;
    },
  });

  // llm — 分片/生成 LLM（注入的 llm 或 API key）
  ctrl.register({
    id: "llm",
    label: "分片/生成 LLM",
    critical: false,
    probe: () => {
      const key = process.env.DEEPSEEK_API_KEY || "";
      // 宿主（如 DSH）可注入 ctx.llm，此时无需 key；探针无法感知注入，只能报“未配置”。
      if (key.length <= 10) {
        throw new Error(
          "未配置 DEEPSEEK_API_KEY：LLM 分片/生成不可用（宿主注入 llm 时不需要，可忽略此项）",
        );
      }
      return true;
    },
  });

  // lingmou — 灵眸 encoder（macbert-2stage ONNX）
  // 注意：灵眸的实现在本仓库的 lingmou-model/ 子包，src/ 并不导入它。
  // 因此这里只做模型文件存在性探测 —— 不能复用 cognitive 探针（那是在测另一个模型）。
  // 也刻意不加载 ONNX：一次健康检查不值得付出 ~800MB 内存。
  ctrl.register({
    id: "lingmou",
    label: "灵眸 encoder (macbert-2stage) — 仅探测模型文件",
    critical: false,
    probe: () => {
      const { lingmouModelDir } = resolveModelPath();
      if (!lingmouModelDir) {
        throw new Error(
          "灵眸模型目录未找到：需含 stage1.onnx + stage2.onnx，可通过 LINGXI_MODEL_DIR 指定",
        );
      }
      return true;
    },
  });

  // cognitive — cognitive_v5 语义向量检索
  // 模型“存在但加载/编码失败”是真实故障（LINGXI_STRICT 下升级为关键能力 → overall=down）；
  // 模型“根本不存在”是全新安装的常态，按降级处理。
  const { isCognitiveReady, isCognitiveModelPresent, getCognitiveLastError } =
    await import("./core/cognitive-state.js");
  const { getLastEmbedError } = await import("./core/embedder.js");
  const cognitiveModelPresent = isCognitiveModelPresent();
  const strictMode = (envWithLegacy("LINGXI_STRICT", "AGENTMEMORY_STRICT") ?? "1") !== "0";
  ctrl.register({
    id: "cognitive",
    label: "cognitive_v5 语义检索",
    critical: strictMode && cognitiveModelPresent,
    probe: async () => {
      if (await isCognitiveReady()) return true;
      const detail =
        getCognitiveLastError() ||
        getLastEmbedError() ||
        (cognitiveModelPresent
          ? "模型存在但加载/编码失败"
          : "模型文件缺失（语义层不可用，将退化为 字图 + FTS5）");
      throw new Error(detail);
    },
  });

  // chargraph — 字图检索
  ctrl.register({
    id: "chargraph",
    label: "字图检索",
    critical: false,
    probe: () => {
      try {
        const db = getDb();
        // 字图数据存在于内存构建；这里探测 DB 可读 + 表存在
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fragments'").get();
        return true;
      } catch {
        return false;
      }
    },
  });

  // lingluo — DCGK 灵络认知图
  ctrl.register({
    id: "lingluo",
    label: "灵络 (DCGK 认知图)",
    critical: false,
    probe: () => {
      try {
        const db = getDb();
        db.prepare("SELECT COUNT(*) as c FROM dcgk_nodes").get();
        return true;
      } catch {
        return false;
      }
    },
  });

  // hourglass — 碎片沙漏（维护）
  ctrl.register({
    id: "hourglass",
    label: "碎片沙漏 (维护)",
    critical: false,
    probe: () => true, // 纯函数维护，无外部依赖，始终可用
  });

  // distill — 蒸馏（用户模型内化）
  ctrl.register({
    id: "distill",
    label: "蒸馏 (用户模型内化)",
    critical: false,
    probe: () => true, // 纯函数维护
  });

  // signals — 轻量信号
  ctrl.register({
    id: "signals",
    label: "轻量信号",
    critical: false,
    probe: () => {
      try {
        const db = getDb();
        db.prepare("SELECT 1 FROM lightweight_signals LIMIT 1").get();
        return true;
      } catch {
        return false;
      }
    },
  });

  // orchestrator — 生命周期维护周期
  ctrl.register({
    id: "orchestrator",
    label: "生命周期维护周期",
    critical: false,
    probe: () => true, // 维护周期由 engine.maintain 触发，运行时判定
  });

  return ctrl;
}
