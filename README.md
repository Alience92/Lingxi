# 灵犀记忆系统 · Easy Mode

> 导出日期：2026-08-14
> 来源：`D:\LingxiServer`（简化后版本）
> 定位：**纯记忆服务** —— 只做"记 / 存 / 取 / 忘"，不包含陪伴者对话系统。
> 状态：**已清理完成**（移除陪伴者全部残留：人格训练脚本/数据、二维码配对、HTTP 服务）

---

## 这是什么

灵犀记忆系统的精简版：一个自带整体层（能力健康探测 + 降级链 + 熔断自愈）的
Agent 记忆服务，官方宿主是 **DeepSeek Harness (DSH)**。

**包含的能力**：
- **写入**：四通道分片（WHAT/FEEL/WHO/WHERE）+ 短内容兜底
- **存储**：SQLite（碎片/锚点/链接/FTS5/向量/用户模型/蒸馏规则/灵络图）
- **检索**：灵络认知图 + 字图 + cognitive_v5 语义向量 + FTS5 四路融合
- **维护**：碎片沙漏 + 衰减 + 蒸馏 + 条件化 dreaming
- **感知**：灵眸 encoder（macbert-2stage 通道分类）+ 轻量信号提取
- **整体层**：10 能力健康探测、降级链、熔断与自动恢复、状态查询

**不含**（已按简化设计移除）：陪伴者对话系统、人格建模、好感度、反思引擎、
生活状态、网络搜索、内容安全、HTTP/SSE 服务、手机壳配对。

---

## 目录结构

```
Lingxi mem easy mode/
├── src/                       # 记忆服务核心（63 个 .ts）
│   ├── engine.ts              # 宿主无关引擎入口（DSH 接入点）
│   ├── system-controller.ts   # 整体层（健康/降级/熔断）
│   ├── index.ts               # 纯记忆服务启动入口
│   ├── config.ts / types.ts
│   ├── core/                  # 记忆核心 + 灵络认知层
│   │   ├── fragmenter.ts      分片    memory-recall.ts  召回融合
│   │   ├── retriever.ts       检索    char-graph.ts     字图
│   │   ├── cognitive-state.ts 语义向量 embedder.ts       嵌入
│   │   ├── orchestrator.ts    生命周期 state-gate.ts     写入门
│   │   ├── v7-long-term-memory.ts 沙漏/蒸馏
│   │   ├── dcgk-*.ts          灵络认知图（7 文件）
│   │   └── ...
│   ├── db/                    # connection / schema / repository
│   └── tools/                 # 记忆评测脚本
├── lingmou-model/src/smallmodel/   # 灵眸 encoder 源码（通道分类）
├── dsh-adapter/               # DSH cordis 插件（memory_search/remember/status）
├── docs/                      # 设计文档（简化设计 / 状态层审计）
├── package.json / tsconfig.json
└── .env                       # 运行配置（含 API key，注意保管）
```

---

## 运行要求

| 项 | 要求 |
|---|---|
| Node.js | ≥ 18（推荐 22+） |
| 依赖安装 | `npm install`（better-sqlite3 / onnxruntime-node / openai / uuid / dotenv） |
| 记忆库 | 默认 `~/.lingxi-server/memory.db`（可用 `LINGXI_DB_PATH` 覆盖） |
| cognitive_v5 模型 | `D:/AgentMemory/tools/cognitive-model-output/cognitive_v5.onnx`（或设 `COGNITIVE_MODEL_PATH`） |
| 灵眸模型 | `D:/AgentMemory/tools/two-stage-output/{stage1,stage2}.onnx + tokenizer/vocab.txt`（或设 `AGENTMEMORY_MODEL_DIR`） |
| LLM | `DEEPSEEK_API_KEY`（分片/生成用） |

### 环境变量（.env）

```bash
DEEPSEEK_API_KEY=sk-...                      # 必需（分片/LLM）
DEEPSEEK_BASE_URL=https://api.deepseek.com
AGENTMEMORY_MODEL_DIR=D:/AgentMemory/tools/two-stage-output     # 灵眸模型目录
COGNITIVE_MODEL_PATH=D:/AgentMemory/tools/cognitive-model-output/cognitive_v5.onnx
LINGXI_PROJECT_ID=C--Users-Administrator     # 项目隔离
# LINGXI_DB_PATH=...                         # 覆盖默认记忆库路径
```

---

## 使用方式

### A. 启动记忆服务（独立进程）

```bash
npm run dev        # node --import tsx src/index.ts
```

启动会依次：打开记忆库 → 初始化灵络图 → 构建字图索引 → 构建向量索引 → 整体层健康探测。

### B. 作为 DSH 插件接入（推荐）

1. 把 `dsh-adapter/` 放到一个目录（例如 `deepseek-harness-master/lingxi-memory/`），
   确保 `node_modules` 有 `@deepseek-ai/cordis` + `zod`。
2. 编辑 adapter 里的 `ENGINE_URL` 指向本目录的 `src/engine.ts`：
   ```ts
   const ENGINE_URL = 'file:///D:/Lingxi mem easy mode/src/engine.ts';
   ```
3. 在 DSH profile 的 `cordis.patch.yml` 挂载：
   ```yaml
   - insert:
       - id: lingxi-memory
         name: 'file:///D:/Lingxi mem easy mode/dsh-adapter/index.ts'
         config:
           autoFragment: true
   ```
4. 重启 DSH，会话中即可用 `memory_search` / `memory_remember` / `memory_status`。

### C. 直接调用引擎（脚本/其他宿主）

```ts
import { createLingxiEngine } from './src/engine.ts';

const engine = createLingxiEngine({ dbPath: 'C:/Users/.../memory.db' });

await engine.remember({ transcript: '用户: 喜欢简洁沟通' });   // 记
await engine.search('用户偏好', 5);                            // 取
await engine.recall('用户 偏好', { limit: 5 });                 // 认知图召回
await engine.maintain();                                       // 维护周期
console.log(engine.formatStatus());                            // 整体状态
```

---

## 工具脚本

```bash
npm run typecheck    # tsc --noEmit
npm run build        # tsc → dist/
npm run eval:retrieval   # 检索评测（需模型与 key）
npm run eval:v7-memory   # 长期记忆 + 沙漏 + 用户建模验收
npm run eval:stability   # 长跑稳定性测试
```

---

## 注意

- `.env` 内含**真实 API key**，请勿外传/入库。
- 模型文件（cognitive_v5.onnx ~416MB、灵眸 stage1/2 各 ~409MB）**未包含**在本导出中，
  需另行放置并通过环境变量指向。
- `node_modules` **未包含**，首次使用请 `npm install`。
- 记忆数据（memory.db）**未包含**，需要单独迁移或从零开始积累。
