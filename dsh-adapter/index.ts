// lingxi-memory — 灵犀记忆系统 DSH Adapter（cordis 插件）
//
// 定位：**薄封装**。真正的记忆实现在本仓库 `src/engine.ts`，本文件只做三件事：
//   1. 把 `ctx.llm` 适配成引擎需要的 `LlmProvider.complete`
//   2. 把引擎能力注册成 DSH 工具（memory_search / memory_remember / memory_status）
//   3. 可选：监听会话事件，攒批自动分片入库
//
// 与 MCP 传输层的关系：两者调用**同一个** `createLingxiEngine`，
// 所以 MCP 宿主（Claude Code / Cursor …）与 DSH 宿主的记忆行为一致，不存在两套实现。
//
// ── P6 修正记录 ──────────────────────────────────────────────
// P6.1 引擎来源：旧版写死 `file:///D:/LingxiServer/src/engine.ts`（**另一套全量版实现**，
//      且路径可能不存在）。现改为相对本文件解析 `../src/engine.ts`（或构建后的
//      `../dist/engine.js`），可用 `Config.engineUrl` 覆盖。
// P6.2 类型漂移：旧版手写了 `LingxiEngineHandle`，把 `formatStatus()` 声明成 `string`，
//      而引擎实际返回 `Promise<string>` —— 宿主拿到的是 `"[object Promise]"`。
//      现**直接 `import type` 本仓库的真实接口**，不再手写副本，tsc 可逐方法校验。
// P6.3 依赖缺失：导入了 `@deepseek-ai/dsh-tools` 却没声明，现补为 peerDependency
//      （与 cordis 一致 —— 两者都由宿主提供，本仓库无法从 npm 获取）。
// P6.4 诚实信号：memory_status 现在同时输出 `dataReality` / `dataWarnings`，
//      让 DSH 宿主也看得到“状态位 healthy 但数据其实是空的”这类问题。
//
// ── P6.6 对接真实宿主包后发现的三个真实 bug ──────────────────
// 之前只能用手写 .d.ts shim，现改为直接引用宿主真实包（`.dsh/profiles`）的类型，
// 立刻暴露出以下问题 —— **上游 `lingxi-memory` 也存在，只是从未被类型检查过**：
//
//  ① `messages[].content` 必须是 `ContentBlock[]`，不是字符串。
//     上游用 `as never` 把它压下去，掩盖了契约不符。现用宿主工厂 `createUserMessage` 构造。
//  ② `ctx.on('session/event')` 的真实签名是 `(session, event: SessionEvent) => void`，
//     `event` 是按 `type` 判别的联合，`data` 形状随变体而异。手写事件形状既过不了类型检查，
//     也掩盖了下一个 bug。现改为让 TS 从重载上下文推断。
//  ③ **autoFragment 从未工作过**：`user/message` 的 `data` 是 `UserMessage`（`content` 为
//     `ContentBlock[]`），而 `assistant/message` 的正文在 `data.message.content`。
//     上游两句都按 `event.data.content` 当字符串取，`typeof content === 'string'` 恒为假，
//     所以**一条记忆都没写进去**。另：`user/message` 也可能是注入上下文（AGENTS.md、
//     文件变更通知、cron），需按 `source.kind === 'user'` 过滤，否则系统噪声会进记忆库。

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';

// 真实接口来自本仓库，不手写副本 —— 任何签名漂移都会被 tsc 捕获。
import type { LingxiEngine, LingxiEngineConfig, LlmProvider } from '../src/engine.js';
// 攒批策略在 core，adapter 只做「订阅 → 投喂」。
import { createSessionBatcher } from '../src/core/session-batcher.js';

export const name = 'lingxi-memory';
export const inject = ['tools', 'llm', 'sessions'] as const;

/** 配置字段。集中定义，供 schema 与默认值复用，避免默认值写两遍而漂移。 */
const ConfigShape = {
  /** 记忆库路径；留空则由引擎自动发现（LINGXI_DB_PATH > LINGXI_HOME > 历史库 > ~/.lingxi） */
  dbPath: z.string().default(''),
  /** 模型目录；留空则由引擎多候选发现（P4）。旧版默认写死 D:/AgentMemory/... */
  modelDir: z.string().default(''),
  /** 显式指定引擎入口（file:// URL）。留空则相对本文件解析 ../src/engine.ts 或 ../dist/engine.js */
  engineUrl: z.string().default(''),
  provider: z.string().default('deepseek-official'),
  model: z.string().default('deepseek-v4-flash'),
  /** 监听 DSH 会话事件，攒批自动分片入库 */
  autoFragment: z.boolean().default(false),
};

// 整体默认值用「函数」而非对象字面量，两个原因：
//   a) zod 4 的 .default() 要求传入**输出类型**。旧写法 .default({}) 在 zod 4 下不合法
//      —— 这是 zod 3→4 迁移遗留，一直没暴露，因为此前没有任何 tsconfig 覆盖 dsh-adapter/，
//      本文件从未被类型检查过。
//   b) 函数形式每次 parse 都生成新对象，避免多次解析共享同一个可变默认值。
export const Config = z.object(ConfigShape).default(() => z.object(ConfigShape).parse({}));

/** 相对本文件的引擎入口候选（源码优先，其次构建产物）。 */
const ENGINE_CANDIDATES = ['../src/engine.ts', '../dist/engine.js'] as const;

/**
 * 解析引擎入口 URL。
 * 用 `new URL(相对路径, import.meta.url)` 而非写死盘符：仓库换位置也能工作，
 * 且 `fileURLToPath`/`URL` 会正确处理路径里的空格（本仓库路径含空格）。
 */
function resolveEngineUrl(override: string): string {
  if (override) return override;
  for (const rel of ENGINE_CANDIDATES) {
    const url = new URL(rel, import.meta.url);
    if (existsSync(fileURLToPath(url))) return url.href;
  }
  throw new Error(
    `[${name}] 找不到本仓库的引擎入口。已尝试：${ENGINE_CANDIDATES.join('、')}` +
    `（相对于 ${import.meta.url}）。请通过 Config.engineUrl 显式指定。`,
  );
}

interface EngineModule {
  createLingxiEngine(config: LingxiEngineConfig): LingxiEngine;
}

/** 消息内容块的最小结构面（真实 ContentBlock 的可赋值子集，避免额外 peer 依赖）。 */
type TextishBlock = { readonly type: string; readonly text?: string };

/**
 * 从消息内容块中抽取纯文本。
 *
 * 真实契约里 `UserMessage.content` / `AssistantMessage.content` 是 `ContentBlock[]`，
 * **不是字符串**。上游代码按字符串处理（`typeof content === 'string'`），该判断恒为假，
 * 因此 `autoFragment` 实际上从未写入过任何记忆。此处按真实形状抽取。
 */
function extractText(blocks: readonly TextishBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') parts.push(b.text);
  }
  return parts.join('\n');
}

export function apply(ctx: Context, config: z.infer<typeof Config>) {
  // ── ctx.llm → LlmProvider.complete 适配 ──
  const llm: LlmProvider = {
    complete: async (system: string, user: string): Promise<string> => {
      let text = '';
      const stream = ctx.llm.stream({
        provider: config.provider,
        model: config.model,
        system: system || undefined,
        // 真实契约要求 messages 是完整 Message[]（含 id / source）。
        // 用宿主工厂构造，而不是靠 `as never` 绕过检查。
        messages: [
          createUserMessage({
            content: [{ type: 'text', text: user }],
            source: { kind: 'user' },
          }),
        ],
      });
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta' && chunk.text) text += chunk.text;
      }
      return text;
    },
  };

  let engine: LingxiEngine | null = null;
  async function getEngine(): Promise<LingxiEngine> {
    if (!engine) {
      const mod = (await import(resolveEngineUrl(config.engineUrl))) as EngineModule;
      engine = mod.createLingxiEngine({
        dbPath: config.dbPath,
        llm,
        modelDir: config.modelDir,
      });
    }
    return engine;
  }

  // ── memory_status 工具（整体层状态查询）──
  ctx.tools.register(defineTool({
    name: 'memory_status',
    description:
      'Check the Lingxi memory system overall status: capability health (live/degraded/down), ' +
      'degradation list, recent errors, plus dataReality (fragment/vector/graph counts) and dataWarnings.',
    parameters: {
      refresh: { type: 'boolean', description: 'Force re-probe all capabilities (default false, uses cached probe results)' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { refresh?: boolean }) {
      const e = await getEngine();
      if (args.refresh) await e.probeAll();
      // formatStatus(): Promise<string> —— 必须 await，否则宿主拿到 "[object Promise]"
      const text = await e.formatStatus();

      // 把诚实信号也以结构化形式给出，便于宿主程序化判断
      const s = e.status();
      const structured = {
        overall: s.overall,
        criticalDown: s.criticalDown,
        degradedList: s.degradedList,
        errors: s.errors,
        dataReality: s.dataReality,
        dataWarnings: s.dataWarnings,
      };
      return `${text}\n\n${JSON.stringify(structured, null, 2)}`;
    },
  }));

  // ── memory_search 工具（结果附带降级提示）──
  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: 'Search the Lingxi memory system (semantic + char-graph + lexical fusion, degrades gracefully).',
    parameters: {
      query: { type: 'string', required: true, description: 'Search query' },
      limit: { type: 'number', description: 'Max results (default 5)' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { query: string; limit?: number }) {
      const e = await getEngine();
      const r = await e.search(args.query, args.limit ?? 5);
      let out = r.length > 0 ? r.join('\n---\n') : '(no memory hits)';
      // 能力降级提示：检索依赖的语义能力失效时告知，而非静默
      try {
        const st = e.status();
        if (st.degradedList?.length > 0) {
          out += `\n\n[memory_status] 降级能力: ${st.degradedList.join(', ')} — 部分检索路径已降级`;
        }
      } catch { /* 状态查询失败不阻塞主结果 */ }
      return out;
    },
  }));

  // ── memory_remember 工具（结果附带降级提示）──
  ctx.tools.register(defineTool({
    name: 'memory_remember',
    description: 'Record a memory into the Lingxi system (four-channel fragmentation, falls back to raw text without an LLM).',
    parameters: {
      content: { type: 'string', required: true, description: 'What to remember' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { content: string }) {
      const e = await getEngine();
      const n = await e.remember({ transcript: `User: ${args.content}` });
      let out = `recorded ${n} fragments into Lingxi memory`;
      try {
        const st = e.status();
        if (st.degradedList?.includes('llm')) {
          out += ' (LLM 分片降级：已直接落库原文，未走四通道分片)';
        }
      } catch { /* 状态查询失败不阻塞主结果 */ }
      return out;
    },
  }));

  // ── 会话自动分片（autoFragment）──
  // 攒批策略在 core（session-batcher）：adapter 只负责「订阅宿主事件 → 投喂」，不含策略。
  if (config.autoFragment) {
    const batcher = createSessionBatcher({
      async flush(transcript: string) {
        try {
          const e = await getEngine();
          await e.remember({ transcript });
        } catch { /* 分片失败静默，不阻塞会话 */ }
      },
    });

    // 参数类型由 ctx.on 的重载上下文推断为真实 SessionEvent，不手写事件形状
    // （手写形状会与宿主的判别联合漂移，且掩盖真实 bug）。
    ctx.on('session/event', async (_session, event) => {
      let blocks: readonly TextishBlock[];
      if (event.type === 'user/message') {
        // 只记真实用户输入。DSH 会把文件变更通知 / AGENTS.md / cron 等注入内容
        // 也发成 user/message，靠 source.kind 区分 —— 否则系统噪声会被写进记忆。
        if (event.data.source.kind !== 'user') return;
        blocks = event.data.content;
      } else if (event.type === 'assistant/message') {
        // 助手消息的正文在 data.message.content，**不是** data.content。
        blocks = event.data.message.content;
      } else {
        return;
      }

      const text = extractText(blocks);
      if (text === '') return;
      try {
        await batcher.push(text);
      } catch { /* push 内的 flush 已自行处理，这里仅防御 */ }
    });
  }
}
