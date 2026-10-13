# 灵犀记忆服务（Easy Mode）改造计划

> 目标：从「能跑但不能信、只能挂 DSH」改造成「开箱即用、可挂任意 Agent、降级诚实」。
> 立此文档时的基线：`tsc --noEmit` 通过（零错误）；`node --import tsx src/index.ts` 可启动。
>
> **改造前**：`1.0.0`，备份于 `D:\Lingxi mem easy mode.backup-20260911-104217`
> **改造后**：**`2.0.0`**（P0–P6 全部完成），快照存于 `D:\Lingxi mem easy mode.v2.0.0`
> 版本号取自 `package.json`：CLI `doctor` 与 MCP 握手都读它，不再有写死的字面量。

---

## 一、四条目标

| # | 目标 | 判定标准 |
|---|---|---|
| G1 | **去 Ollama** | 唯一模型依赖为 `onnxruntime-node`；空闲常驻内存 = 0 |
| G2 | **单一配置契约** | 全仓库只有一个 `resolveConfig()`；一套环境变量 |
| G3 | **降级诚实** | 无静默 hash 回退；`status()` 反映数据现实 |
| G4 | **开箱即用** | 提供 MCP + CLI 传输层；模型可自动发现；缺失时诚实降级 |

---

## 二、基线体检结果（已验证，非推断）

### 2.1 三套库路径解析

| 位置 | 环境变量 | 默认库 |
|---|---|---|
| `src/config.ts` | `LINGXI_DB_PATH` | `~/.lingxi-server/` |
| `src/db/connection.ts:13` | `LINGXI_HOME` | `~/.lingxi-server/` |
| `src/engine.ts:120` | `AGENTMEMORY_HOME` | `~/.agentmemory/` |

后果：入口不同 → 库不同。实测两库数据量差 6.6 倍（602 vs 2010 碎片）。
`engine.ts` 还用 `AGENTMEMORY_HOME` + `".agentmemory"` 拼接，若该变量已指向 `.agentmemory` 会双重嵌套 → 空库。

### 2.2 四个嵌入实现，三个端点，两个维度

| 模块 | 端点 | 维度 | 状态 |
|---|---|---|---|
| `core/embedder.ts` | `${baseURL}/v1/embeddings`（默认 `127.0.0.1:11434`）| **1536** | 主路径 |
| `core/local-embedder.ts` | `@xenova/transformers`(未安装) → `:11434` | 1024 | **死代码，零引用** |
| `core/cognitive-state.ts` | 本地 ONNX `cognitive_v5` | **1024** | 已就绪，但是"附加路线" |
| `core/dcgk-disambiguate.ts` | 自带 Ollama 客户端 `:11434/api/embed` | 1024 | 独立一套 |

### 2.3 隐藏浪费：写入的向量注定被丢弃

- `db/repository.ts:20,24,75` 用 `getCurrentEmbedder()`（`text-embedding-3-small` @1536）算向量，并写 `vector_model = "text-embedding-3-small"`
- `core/cognitive-state.ts:193` 读取时**只认 `vector_model = 'cognitive_v5'`**
- `core/orchestrator.ts:167` 维护周期扫描 `vector_model != 'cognitive_v5'` 并重算（每轮上限 30 条）

→ 存记忆时那次推理**必然被丢弃**；且新记忆在修复前对语义召回完全不可见（每次最多修 30 条）。

### 2.4 降级不诚实

- `core/embedder.ts:80,95` 失败时静默 `embedHash()`
- `core/embedder.ts:63 isHashOnly()` 只检查"有没有配 key"，不检查端点是否可达 → 端点死了也返回 false
- `core/retriever.ts:15` 据此选用 `API_MIN_SCORE`（严格阈值）去筛哈希噪声
- 实测启动输出：`Batch embedding API failed, using hash fallback` 之后紧接 `Built: 378 fragments (api, text-embedding-3-small)`，最后报 `整体层: healthy`

### 2.5 状态无判别力

- `system-controller.ts` 的 `db` 探针只验证"库能打开"
- 实测：库含 2010 碎片但 `vector_model` 全 NULL、`projects` 空表 → 字图 0 节点 0 边 → 仍报 `healthy`
- `lingmou` 探针与 `cognitive` 探针实现相同（都调 `isCognitiveReady()`）→ 灵眸状态从未真正探测

### 2.6 其他

- `dsh-adapter/index.ts:23` 写死 `file:///D:/LingxiServer/src/engine.ts`（另一个仓库，且该路径存在 → **静默加载错误引擎**）
- `dsh-adapter` 声明 `formatStatus(): string`，实际返回 `Promise<string>`
- `dsh-adapter/package.json` 未声明 `@deepseek-ai/dsh-tools`（代码里 import 了）
- `src/index.ts` 是一次性初始化脚本，非常驻服务（README 描述为"独立进程"）
- `dist/` 不存在 → `npm start` 失败
- `docs/` 残留陪伴者设计文档（README 称已移除）
- `src/config.ts` 仅 6 行，实际未被 `engine.ts` 采用

### 2.7 已经就位的好东西（不要推翻）

- **602/602 碎片向量已是 `cognitive_v5`，1024 维** → 去 Ollama **无需重建向量**
- `core/cognitive-state.ts` 已实现：本地 ONNX、1024 维、懒加载、无网络
- `core/orchestrator.ts` 已在写 `cognitive_v5`（维护回填）
- `onnxruntime-node` 已安装（唯一需要的模型运行时）

---

## 三、阶段计划

### P0 · 安全网 ✅
- [x] 备份源码树（不含 `node_modules`）→ `D:\Lingxi mem easy mode.backup-20260911-104217`
- [ ] （可选，建议）`git init` + `.gitignore` + 首次提交，以便逐步回滚

---

### P1 · 去 Ollama（核心）✅

> **关键设计**：不逐个改调用点，而是**把 `getCurrentEmbedder()` 的实现换成 cognitive 后端**。
> 这样 `repository.ts` / `fragment-vector-index.ts` / `retriever.ts` 的所有调用点**自动**变为 cognitive，
> 且 `repository.ts:75` 写出的 `vector_model` 自动变成 `"cognitive_v5"` —— **一举同时消灭 2.3 的隐藏浪费和不可见 bug**。

- [x] **P1.1** 删除 `src/core/local-embedder.ts`（零引用死代码）
- [x] **P1.2** 重写 `src/core/embedder.ts`：
  - `getCurrentEmbedder()` 返回 cognitive 后端（`model="cognitive_v5"`, `dim=1024`）
  - `embed()` / `embedBatch()` → `encodeCognitiveState` / `encodeCognitiveBatch`
  - 删除 `embedHash()` 与 hash 回退路径
  - `isHashOnly()` 保留但标 `@deprecated`，委托给新的 `isSemanticUnavailable()`
  - **保留并 `export` `cosineSimilarity`**（`signal-channel.ts:1`、`retriever.ts:3` 在用）
  - 附带：`cognitive-state.ts` 新增 `isCognitiveModelPresent()`（同步、缓存、不触发加载）
- [x] **P1.3** `src/core/fragment-vector-index.ts` 整体重写：`indexMode` 改为 `"unavailable" | "cognitive"`；新增 `decodeVector()` 解 4096B→1024 维；**优先复用 `vector_model='cognitive_v5'` 存量向量**，只对缺失/异源者调 `embedBatch`；两者皆无 → 记 `unavailable` 并打印诚实日志
- [x] **P1.4** `src/core/retriever.ts`：
  - `:959` route-2 语义路径**无需改动** —— 它调用 `getCurrentEmbedder().embed()`，P1.2 后已自动是 cognitive
  - `:15,134,798` 门控改用 `isSemanticUnavailable()`；旧逻辑「只有显式配了非 Ollama URL 才启用语义」已废弃，改为「cognitive 模型是否存在」
  - `:1101-1115` 认知偏置的向量查询补上 `vector_model = 'cognitive_v5'` 过滤（否则跨模型向量可能被混算）
- [x] **P1.5** `src/core/dcgk-disambiguate.ts` → 移除自带 Ollama 客户端（`EMBED_URL`/`EMBED_MODEL`/`checkOllama`/`EMBED_BATCH_MAX`），内部 `embedBatch` 改走 `encodeCognitiveBatch`；bigram 兜底、缓存、`useEmbedding` 阈值逻辑全部保留不动
- [x] **P1.6** 删除 bge-m3 启动门禁：`src/bootstrap-env.ts`、`src/bootstrap-history.ts` 改查 `isCognitiveReady()`，且**不再 `process.exit(1)`**（改为警告 + 继续，交由字图/FTS5 降级）
- [x] **P1.7** 全仓库复查 `11434` / `ollama` 残留：**功能性引用已清零**，仅剩注释与「已不再需要 bge-m3/Ollama」这类说明文本
- [x] **P1.8** `tsc --noEmit` exit 0 + 实测启动通过（见下）

#### P1 实测证据（2026-09-11）

前置条件：**端口 11434 确认关闭**（Ollama 不可用），测试库为 `~/.agentmemory/memory.db` 的临时副本。

| 项 | 结果 |
|---|---|
| 启动 | 成功，自行退出，无报错 |
| 向量索引 | `[VectorIdx] Built: 378 fragments in 11ms (cognitive, cognitive_v5)` |
| 重新编码 | **0 条** —— 378 条全部复用存量向量（11ms 即证） |
| 启动前 | 602/602 `cognitive_v5`，4096B→1024 维 |
| 启动后 | 602/602 `cognitive_v5`，4096B→1024 维（**完全一致**） |
| hash 回退 | 未出现 |
| bge-m3 / 11434 | 日志中未出现 |

---

### P2 · 单一配置契约 ✅

> **基线修正**：体检时以为有三套路径解析，实际 `src/config.ts` **零引用（死代码）**。
> 真正在用的只有 `connection.ts:getDbPath()`（默认 `~/.lingxi-server`）和 `engine.ts:120`（默认 `~/.agentmemory`，且会二次拼接）。

- [x] **P2.1** `src/config.ts` 重写为 `resolveConfig()`（不再是死代码）：
  ```
  程序化 override > LINGXI_DB_PATH > LINGXI_HOME/memory.db
                 > 已存在的历史库(~/.agentmemory, ~/.lingxi-server) > ~/.lingxi/memory.db
  ```
  同时导出 `ensureDbDir()` 与 `envWithLegacy()`。
  **对计划的有意偏离**：第 4 步“已存在的历史库”是新增的 —— 计划原为直接落到 `~/.lingxi`，
  但那会使既有 602 条记忆在升级后“消失”。宁可多一步存在性探测。
  `modelPath` 解析**未**放入本阶段（留给 P4.1）。
- [x] **P2.2** `src/db/connection.ts:getDbPath()` → 委托 `resolveConfig()`
- [x] **P2.3** `src/engine.ts:120` → 委托 `resolveConfig()`，**已移除 `AGENTMEMORY_HOME` 与 `.agentmemory` 的二次拼接**；顺手删掉不再使用的 `os` / `path` 导入
- [x] **P2.4** `AGENTMEMORY_*` 统一为 `LINGXI_*`，过渡期保留别名并打一次性弃用警告：
  - `AGENTMEMORY_MODEL_DIR` → `LINGXI_MODEL_DIR`（`cognitive-state.ts:28`）
  - `AGENTMEMORY_SEMANTIC` → `LINGXI_SEMANTIC`（`retriever.ts`）
  - `AGENTMEMORY_PERF_TIMING` → `LINGXI_PERF_TIMING`（`retriever.ts`，两处改为复用模块常量 `PERF_TIMING`）
  - `AGENTMEMORY_HOME` 已彻底移除
- [x] **P2.5** 更新 `.env.example`（含完整解析顺序、弃用对照表、"不再需要 Ollama/bge-m3" 说明）

#### P2 实测证据（2026-09-11）

配置解析顺序逐项验证通过（临时探针，已删）：

| 场景 | 结果 |
|---|---|
| 无环境变量（历史库存在）| `~/.agentmemory/memory.db`，source=`legacy DB (compat)` ✅ 不丢数据 |
| 显式 override | 胜出 |
| `LINGXI_DB_PATH` | 胜出 |
| override vs `LINGXI_DB_PATH` | override 胜 |
| `LINGXI_HOME` | `$LINGXI_HOME/memory.db` |
| `LINGXI_DB_PATH` vs `LINGXI_HOME` | `LINGXI_DB_PATH` 胜 |
| `envWithLegacy` | unset→undefined；仅旧名→旧值+警告；新名旧名共存→新名且不重复警告 |

回归启动：与 P1 完全一致（602/602 `cognitive_v5`、378 条索引、11ms、前后状态一致）。

---

### P3 · 降级诚实与可观测 ✅

> **基线修正**：体检时写“`lingmou` 探针与 `cognitive` 探针实现相同”。实际更严重——
> **本仓库 `src/` 根本没有灵眸 encoder 的任何代码**，灵眸实现在独立子包 `lingmou-model/`（`src/` 不导入它）。
> 所以原探针是一句彻头彻尾的谎话：它报的是 cognitive 模型的状态，却挂着“灵眸”的名字。

- [x] **P3.1** `SystemStatus` 新增 `dataReality: DataReality \| null`：
  ```ts
  { fragments, withCognitiveVectors, graphNodes, graphEdges }
  ```
  由 `readDataReality()` 读取；单条查询失败按 0 计，DB 未打开返回 null，**绝不抛错**。
- [x] **P3.2** 新增 `deriveDataWarnings()` + `overall` 规则：
  - `fragments > 0 && graphNodes === 0` → 告警“图谱推演路径不可用”
  - `withCognitiveVectors / fragments < 0.5` → 告警“语义召回覆盖不足”
  - 有任何数据告警时，`overall` **不得为 healthy**（降为 degraded）
- [x] **P3.3** `lingmou` 探针改为**真实探测**：检查 `LINGXI_MODEL_DIR` 下 `stage1.onnx` / `stage2.onnx` 是否存在；
  缺失时抛错并把原因写进 `status().errors`。刻意不加载 ONNX（一次健康检查不值得 ~800MB 内存）。
  标签也改为“灵眸 encoder (macbert-2stage) — 仅探测模型文件”，不再含糊。
- [x] **P3.4** 嵌入失败不再静默：
  - `embedder.ts` 新增 `_lastEmbedError` + `getLastEmbedError()`，`embed`/`embedBatch` 失败时记录原因、成功时清空
  - `cognitive` 探针失败时抛出具因错误（模型缺失 / 模型存在但加载失败），进入 `status().errors`
  - `LINGXI_STRICT`（默认 `1`）：**模型存在但加载失败**时把 `cognitive` 升级为关键能力 → `overall = down`；
    模型**根本缺失**按降级处理（与 P4.2 保持一致）
- [x] **附带**：`index.ts` 原先只打印 `formatStatus()` 的**第一行** —— 这正是“healthy 掩盖一切”的直接原因。
  改为打印完整状态（含数据现实与告警）。

#### P3 实测证据（2026-09-11）

前置：Ollama 端口 11434 关闭。同一份代码，仅换库：

| 场景 | 数据现实 | overall | 告警 |
|---|---|---|---|
| `~/.lingxi-server`（2010 碎片）| 碎片=2010(有向量0) 灵络节点=1821 边=1304 | **degraded**（修复前为 healthy）| “仅 0/2010 条碎片有 cognitive_v5 向量（0%）” |
| `~/.agentmemory`（602 碎片）| 碎片=602(有向量602) 灵络节点=113 边=13 | healthy | 无 |

`lingmou [live]`：真实探测到 `stage1.onnx` / `stage2.onnx`（`D:/AgentMemory/tools/two-stage-output`）。

`.env` 中的 `AGENTMEMORY_MODEL_DIR` 已改为 `LINGXI_MODEL_DIR`（弃用警告随之消失）。

---

### P4 · 模型发现（开箱即用的前提）✅

> **基线修正**：`cognitive-state.ts` 原先把模型路径写死为 `D:/AgentMemory/tools/cognitive-model-output/cognitive_v5.onnx`，
> 而 tokenizer 用 `envWithLegacy(...) || ""` 兜底 —— `path.join("", "tokenizer", "vocab.txt")` 得到**相对路径**，
> 依赖 cwd，换台机器就是 ENOENT。两者现在统一由 `resolveModelPath()` 解析。

- [x] **P4.1** `config.ts` 新增 `resolveModelPath()`，多候选发现，**永不抛错、永不 exit**：
  ```
  cognitive 模型：COGNITIVE_MODEL_PATH > LINGXI_MODEL_DIR > ~/.lingxi/models > 旧默认路径（告警）
  vocab：        模型同目录 > LINGXI_MODEL_DIR > ~/.lingxi/models > 旧默认路径（告警）
  灵眸：         LINGXI_MODEL_DIR > ~/.lingxi/models > 旧默认路径（告警）
  ```
  返回 `{ cognitiveModelPath, cognitiveSource, lingmouModelDir, lingmouSource, vocabPath, vocabSource, warnings }`，
  source 字段供 P5.3 的 `lingxi doctor` 展示。
- [x] **P4.2** 找不到模型时**不 exit**（启动路径仅剩通用崩溃兜底）：
  `cognitive-state.ts` 导出 `getCognitiveLastError()`，缺失/加载失败时给出**可操作**的原因；
  `system-controller` 的 `cognitive` 探针把它带进 `status().errors`，`overall` 降为 `degraded`。
- [x] **P4.3** 支持 int8 量化 + 一次性脚本 `scripts/quantize-cognitive-model.py`（npm: `quantize:cognitive`）。
  **附带一处对计划的有意偏离**：计划要求「int8 优先」，**实测后改为默认 fp32 优先** —— 理由见下。
- [x] **P4.4** tokenizer 路径不再用空字符串兜底；缺失时抛出带修复指引的错误（不再产生相对路径 ENOENT）。

#### P4 实测证据（2026-09-11）

**A. 全新机器（无任何模型）模拟** —— 临时隐藏 `cognitive-model-output` 与 `two-stage-output`，跑完由 `finally` 还原，
还原后逐字节校验：`RESTORE EXACT: True`（16/16 文件，尺寸全等）。

| 项 | 结果 |
|---|---|
| 启动 | 未崩溃，正常走到「就绪」（`EXITCODE = 0`）|
| `cognitive` | `[down] — 模型文件缺失（语义层不可用，将退化为 字图 + FTS5）` |
| `lingmou` | `[down] — 灵眸模型目录未找到：需含 stage1.onnx + stage2.onnx，可通过 LINGXI_MODEL_DIR 指定` |
| `overall` | `degraded`（既不谎报 healthy，也不误判 down）|
| 存量向量 | `[VectorIdx] Built: 378 fragments in 11ms` —— 已有碎片零重编码，仍可检索 |

**B. `resolveModelPath()` 候选顺序**（探针逐项验证，已删）：

| 场景 | cognitive 命中 | 来源 |
|---|---|---|
| baseline（`.env` 只给 `LINGXI_MODEL_DIR`）| fp32 | 旧默认路径（带迁移告警）|
| `LINGXI_PREFER_INT8=1` + int8 目录 | int8 | `LINGXI_MODEL_DIR`（带质量告警）|
| 目录内只有 int8、未显式开启 | int8 | `LINGXI_MODEL_DIR`（带质量告警）—— 唯一的选项 |
| 显式 `COGNITIVE_MODEL_PATH` | fp32 | `COGNITIVE_MODEL_PATH (explicit)` |
| 不设任何环境变量 | fp32 | 旧默认路径（带告警）|

**C. int8 量化实测**（`cognitive_v5.onnx` → int8，104s）：

| 指标 | 结果 |
|---|---|
| 体积 | 416.8 MB → **105.0 MB（25%）** |
| 加载 | 808 ms → **410 ms** |
| 向量自一致性 | **cos(fp32, int8) mean=0.916，min=0.829** ⚠️ |
| 检索 top-1 | 一致 |
| 检索 top-3 | 3/3 |
| 检索 top-5 | **3/5** ⚠️ |

**这直接推翻了「int8 优先」：** 本仓库多处用**绝对分数阈值**（`cognitiveVectorSearch` 的 `s > 0.45`、`getDefaultMinScore()` 等），
自一致性 0.92 意味着分数整体偏移 → 会改变召回结果。把 int8 设为默认就是**静默降低质量**，
与本次改造的核心目标相悖。因此改为：

- 默认 **fp32 优先**（保真，与存量向量同源）；
- int8 仅在 fp32 缺失时被选用（仍可用），且 `warnings` 明确写出实测数据；
- 想用 int8 省内存：`LINGXI_PREFER_INT8=1`。

**D. 向量完整性**（只读复查）：

| 库 | fragments | cognitive_v5 | 其它模型 | 非 4096B 向量 |
|---|---|---|---|---|
| `~/.agentmemory` | 602 | **602** | 0 | **0** |
| `~/.lingxi-server` | 2010 | 0 | 0 | 0 |

回归启动与 P3 完全一致；`tsc --noEmit` exit 0。

---

### P4.5 · 密钥清理（用户追加）✅

- [x] **全项目秘密扫描**（排除 `node_modules`），模式：`sk-[A-Za-z0-9_-]{10,}`、`*_API_KEY`、`apiKey`、`password`/`secret`/`Bearer`/token/PEM：
  - **真实密钥只有一处**：`.env:1` 的 `DEEPSEEK_API_KEY`。
  - 其余命中均为 `node_modules` 第三方代码，或占位符（`.env.example` 的 `sk-your-key-here`、
    `src/tools/generate-source-a-fix.ts` 的 `sk-placeholder`、README/docs 的 `sk-...`/`<real key>`）—— 均无需改动。
  - 无 `.env.local` / `.env.*.local` 等衍生文件；`src/` 无硬编码密钥。
- [x] `.env` 第 1 行改为 `DEEPSEEK_API_KEY=`（**空置**），key 不再落盘。
- [x] 新增 `.gitignore`（仓库目前无版本控制）：忽略 `.env` 与 `*.onnx`/`*.pt`/`*.db`/`dist`/`node_modules` 等。
- [x] `llm` 探针补齐失败原因（原来静默返回 `false`）：
  `未配置 DEEPSEEK_API_KEY：LLM 分片/生成不可用（宿主注入 llm 时不需要，可忽略此项）`

#### 后果（实测，2026-09-11）

密钥清空后，两场景均变为 `✕ llm [down]`，`overall = degraded`（`llm` 非关键能力，不会把系统判为 `down`）。
这是**真实状态**，不是回归：无 key 时 LLM 分片/生成确实不可用，而字图 / FTS5 / cognitive 语义路径不受影响。

> ⚠️ **建议立刻吊销该 Key。** 它已在本地以明文存在，且已进入对话记录，应视为已泄露。
> 请到 DeepSeek 控制台吊销 `sk-4b2f...3020` 并生成新 Key，通过环境变量注入：
> `$env:DEEPSEEK_API_KEY="sk-..."`（PowerShell）。新版不再写回 `.env`。

---

### P5 · 传输层（打通所有 Agent）✅

- [x] **P5.1** `src/mcp/server.ts`：MCP stdio server（官方 `@modelcontextprotocol/sdk@1.30.0`），
      暴露 `memory_status` / `memory_search` / `memory_remember`
      → 一次性打通 Claude Code / Cursor / Cline / Zed / Continue / ohmyagent
- [x] **P5.2** `src/cli.ts`：`lingxi remember|recall|status|doctor|reindex`
- [x] **P5.3** `lingxi doctor`：版本 / 运行时 / 记忆库（路径+来源+大小）/ 项目 / 模型（路径+来源+告警）/ 环境变量 / 能力 / 数据现实；支持 `--json`
- [x] **P5.4** `package.json` 增加 `bin`（`lingxi` → `dist/cli.js`，`lingxi-mcp` → `dist/mcp/server.js`）与 `npm run mcp` / `npm run cli`

#### 三个必须记住的实现要点

1. **stdout 纯净性是 MCP 的命门。** stdio 传输下 stdout 只能承载 JSON-RPC 帧，
   而本项目各模块用 `console.log` 打进度（`[VectorIdx]`、`[灵络消歧]`、`[Fusion Score]` …），
   一旦写进 stdout 就会污染协议流、让客户端解析失败。
   做法：在 **任何业务模块被求值之前** 把 `console.log/info/warn` 改道到 stderr（源文件顶部）。
   ESM 的 `import` 会被提升，**所以业务模块必须用动态 `await import()`**，静态 import 会让改道失效。
2. **宿主启动 MCP 进程时不带我们的环境变量** —— MCP server 必须自己调 `loadEnvFile()`，
   且要早于 `engine` / `config` 的求值。为此抽出了共享的 `src/load-env.ts`（`index.ts` 也改为复用它）。
   该加载器**跳过空值**，因此 `DEEPSEEK_API_KEY=` 留空不阻止用环境变量注入密钥。
3. **构建产物的 shebang 会被 `tsc` 保留**，但必须在源码首行；POSIX 下 npm 的 `bin` 依赖它。
   本次踩过一次：先构建后加 shebang，`dist` 里就没有，必须重新构建。

#### 实测证据（2026-09-11，`tsc` exit 0，`npm run build` exit 0）

| 检查 | 结果 |
|---|---|
| MCP `initialize` | `{"name":"lingxi-memory","version":"1.0.0"}`，协议 `2024-11-05` ✅ |
| MCP `tools/list` | 3 个工具 ✅ |
| MCP `memory_status` | 返回完整诚实状态 + 结构化 `dataReality` ✅ |
| MCP `memory_search` | 真实召回：`user_model` 0.7053 / `lingluo_fused_char_only` 0.6500 / `vector_search` 0.3267 ✅ |
| MCP 非法参数 | 正确返回 `-32602` 校验错误 ✅ |
| **MCP stdout 纯净性** | `tsx` 与 `dist` 两次均为：3–5 行输出，**非 JSON 行 = 0** ✅ |
| MCP `dist` 冷启动 | 315 ms 完成握手 ✅ |
| CLI 退出码 | 8/8 符合契约 ✅ |
| CLI `doctor` | 正确报出模型来源与“命中旧默认路径”告警 ✅ |
| `npm pack --dry-run` | 110 文件 / 220 kB，含 `dist/cli.js` 与 `dist/mcp/server.js`，无意外文件 ✅ |

**CLI 退出码契约（已写入 `--help`）**：`0` 正常（**含 `degraded`** —— 服务可用但有降级项，不应让
脚本/CI 失败）；`1` `down`（关键能力不可用）；`2` 用法/参数错误。

#### 两处有意保留、勿动的细节

- **`.env` 保留 `LINGXI_MODEL_DIR=D:/AgentMemory/tools/two-stage-output`。**
  实测确认：`cognitive-model-output/tokenizer/vocab.txt` **不存在**，所以当前生效的 vocab 是
  `two-stage-output/tokenizer/vocab.txt`（109,540 B）。删掉这行后解析会**落到同一个文件**
  （经旧默认路径兜底），因此删/留都不改变 vocab、不影响已有 602 条向量。
  保留的理由：`.env` 已在 `.gitignore` 内（新用户拿到空 .env），而非标准路径在其它机器上会被
  `isFile`/`isDir` 探测静默跳过并退化为诚实降级，**无害**。
- **`cognitive_v5.int8.onnx` 在本机不存在**，只有 fp32（416,759,767 B）—— 与 P4.3 的 fp32 优先默认一致，无冲突。

---

### P6 · 适配层修正 ✅

定位：dsh-adapter 改为**薄封装本仓库的 `createLingxiEngine`**，与 MCP server 共用同一套引擎实现，
不再指向旧全量版 `D:/LingxiServer`。

- [x] **P6.1** 引擎来源：`ENGINE_URL` 从写死的 `file:///D:/LingxiServer/src/engine.ts` 改为
      **相对本文件解析**（`new URL('../src/engine.ts', import.meta.url)`，回退 `../dist/engine.js`），
      并新增 `Config.engineUrl` 可覆盖。用 URL 而非字符串拼接，才能正确处理路径里的空格（本仓库路径含空格）。
- [x] **P6.2** 类型漂移：**删掉手写的 `LingxiEngineHandle`**，改为 `import type { LingxiEngine } from '../src/engine.js'`
      —— 直接用真实接口，`formatStatus(): Promise<string>` 自动正确（宿主不再拿到 `"[object Promise]"`）。
- [x] **P6.3** `dsh-adapter/package.json` 补 `@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm`
      （均为宿主提供的 **peerDependency**）。
- [x] **P6.4** 攒批策略移入 core：新增 `src/core/session-batcher.ts`；adapter 现在只做「订阅宿主事件 → 投喂」，无策略。
- [~] **P6.5** 清理 `docs/` 陪伴者残留文档 —— **不纳入新版本**（旧版遗留的陪伴者时代设计文档，保留作历史）。

#### P6.6 · 接入真实宿主包后，暴露出一个「埋在代码里的死功能」

上一轮我只能手写 `.d.ts` shim，因此只能保证「adapter 对本仓库代码的调用被校验」。
后来在本机找到了真实包并改为直接引用它们，**立刻报出 4 个真实 bug** ——
**上游 `deepseek-harness/lingxi-memory/src/index.ts` 也全部存在，只是它从未被类型检查过**：

| # | 真实契约 | 旧代码 | 后果 |
|---|---|---|---|
| ① | `GenerateOptions.messages: Message[]`，`content` 是 `ContentBlock[]` | `content: user`（裸字符串），用 `as never` 压下去 | 契约不符，靠 cast 掩盖 |
| ② | `ctx.on('session/event', (session, event: SessionEvent) => void)`，`event` 是按 `type` 判别的联合 | 手写 `event: { type: string; data?: { content?: unknown } }` | 类型不符，同时掩盖了 ③ |
| ③ | `user/message` 的 `data` 是 `UserMessage`（`content: ContentBlock[]`）；`assistant/message` 的正文在 **`data.message.content`** | 两句都按 `event.data.content` 当字符串取 | **`autoFragment` 从未工作过**：`typeof content === 'string'` 恒为假，**一条记忆都没写进去** |
| ④ | `McpServer` 版本应随 package.json | `src/mcp/server.ts` 硬编码 `"1.0.0"` | 升版本后 MCP 握手会报旧值，而宿主界面显示的正是它 |

额外修正（随 ③ 一并处理）：`user/message` **不只**承载用户输入 —— DSH 会把文件变更通知、
`AGENTS.md`、cron 等注入内容也发成 `user/message`，靠 `source.kind` 区分。
现按 `source.kind === 'user'` 过滤，否则**系统噪声会被当成用户记忆写进库**。

修法：①②用宿主工厂 `createUserMessage({ content, source })` 构造真实 `Message`；
③改为让 TS 从重载上下文推断 `event` 类型（不再手写形状），并按真实路径取内容；
④改为从 package.json 读版本（与 `cli.ts` 一致，消除重复字面量）。

#### 如何复现「对真实宿主包做类型检查」

真实包就在本机 DSH 运行时里（**不需要从 npm 安装**）。把作用域软链进本仓库 node_modules 即可：

```powershell
New-Item -ItemType Junction -Path 'D:\Lingxi mem easy mode\node_modules\@deepseek-ai' `
         -Target "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai"
npm run typecheck:adapter
```

实测版本：`@deepseek-ai/cordis@4.0.1`、`@deepseek-ai/dsh-tools@0.1.0-rc.5`。

> `typecheck:adapter` **有意不放进 `npm run check`**：它需要 DSH 宿主包。
> 本仓库定位是「可挂任意 Agent」（MCP 宿主根本不需要 DSH），
> 把它塞进 `check` 会让没装 DSH 的机器 `npm ci && npm run check` 直接失败。

#### 实测证据（2026-09-11）

| 检查 | 结果 |
|---|---|
| `npm run check` | typecheck + build 均 exit 0（不依赖 DSH）✅ |
| `npm run typecheck:adapter` | **对真实 `@deepseek-ai` 包** exit 0 ✅ |
| **负向测试**（证明检查有效） | 故意复现旧 bug 后 tsc 如实报错：<br>`TS2322: Type 'Promise<string>' is not assignable to type 'string'`<br>`TS2551: Property 'recallX' does not exist on type 'LingxiEngine'. Did you mean 'recall'?`<br>`TS2551: Property 'dataRealityX' does not exist on type 'SystemStatus'.` ✅ |
| 真实包发现的 bug | 接入真实包后报出 ①②③④；修复后 exit 0 ✅ |
| `session-batcher` 单测 | **22 / 22 通过** ✅ |
| MCP 握手版本 | `{"name":"lingxi-memory","version":"2.0.0"}`（随 package.json）✅ |
| MCP 回归（重建后 dist） | SMOKE PASS，321 ms 握手，stdout 非 JSON 行 = 0 ✅ |
| 真实记忆库向量完整性 | 602/602 `cognitive_v5`，**全部 4096 B（dim 1024）**，异常 0 条 ✅ |
| CLI 回归 | `status` exit 0；`doctor --json` 字段正确，`DEEPSEEK_API_KEY = (unset)` ✅ |

> 所有测试均对**库副本**执行（`LINGXI_DB_PATH` 指向 `%TEMP%` 拷贝），真实库全程只读。

#### 仍需你处理

- ⚠️ **吊销 `.env` 里那个 DeepSeek Key**（值已清空，但旧 Key 明文存在过并进入对话记录，应视为已泄露）。

---

## 四、验收

每个阶段结束：
1. `npm run typecheck` 必须 exit 0
2. 关键阶段（P1/P2/P4）额外跑一次实测启动
3. P1 完成后实测：启动日志中**不得出现** `hash fallback` / `11434` / `bge-m3`

最终验收（G1–G4）：
- `npm run typecheck` 通过
- 启动后 `status().dataReality.withVectors === fragments`
- 全仓库 `grep -i "11434\|ollama\|bge-m3"` 仅剩注释/文档
- `lingxi doctor` 输出完整
- MCP server 可被 `claude mcp add` 挂载

---

## 五、风险与约束

| 风险 | 缓解 |
|---|---|
| 无版本控制，改错难回滚 | 已做目录备份；建议 `git init` |
| P1.2 换掉 embedder 影响面大（3 个文件多处调用）| 保持接口形状不变，只换实现；每步 typecheck |
| 现有 602 条 cognitive_v5 向量不可损坏 | 实测确认启动不写回向量；改动后复核 `vector_model` 分布 |
| 模型文件 416 MB 未随包 | P4 处理后降级可跑；量化可降至 ~105 MB |
| `retriever.ts` 68 KB，改动需谨慎 | 只改门控与 route-2 调用点，不动融合权重 |

---

## 六、执行顺序建议

`P0 → P1 → P2 → P3 → P4 → P5 → P6`

理由：P1 收益最大且最独立；P2 是 G4 的前提；P3 让改造过程可验证；P4/P5 是"开箱即用"的实体；P6 收尾。
