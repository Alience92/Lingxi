# 灵犀陪伴者 (Lingxi Soul Companion) — 完整技术规格书

> **定位**: 个人 AI 记忆伴侣 · BYOC (Bring Your Own Cloud) 独立部署
> **核心引擎**: 灵络 v3 认知图谱 (DCGK — Dynamic Cognitive Graph Kernel)
> **仓库**: [Alience92/Lingxi-soul-companion](https://github.com/Alience92/Lingxi-soul-companion)
> **日期**: 2026-06-16

---

## 一、设计功能 vs 已完成功能

| # | 功能模块 | 设计目标 | 状态 |
|---|---------|---------|------|
| 1 | 灵络 v3 认知图谱引擎 | Hebbian学习+STC+eligibility traces, 8元认知操作种子节点, 2情绪节点 | ✅ |
| 2 | bge-m3 语义消歧 | 中文嵌入消歧, COSINE_MERGE=0.70/CREATE=0.60 | ✅ |
| 3 | 字图符号映射 | Char-Graph 字面overlap路径, 与bge-m3互补 | ✅ |
| 4 | 双路融合召回 | bgeScore×0.7 + charScore×0.3 加权融合, Fallback V5 retriever | ✅ |
| 5 | 两阶段 SSE 对话 | Stage1 buffer(<1ms) → Stage2 LLM(SSE final), 动态System Prompt | ✅ |
| 6 | Persona 风格推断 | warmth/verbosity/humor/formality 四维, 当前规则版 | ✅ 规则版 |
| 7 | 反思引擎 | LLM扫描图谱→内部观察→REFLECTION碎片, 8h冷却, isProactive标记 | ✅ |
| 8 | 内部时钟 | 定时唤醒灵络, dreaming周期 + 主动关怀扫描, 测试2min/生产30min | ✅ |
| 9 | 主动推送闭环 | 时钟扫描→reflect(isProactive)→碎片→前端轮询(8s)→is_read去重→204 | ✅ |
| 10 | 影子模式采集 | 旁路扫描JSONL→静默更新灵络, 跟踪文件位置, 不干预主流程 | ✅ |
| 11 | 移动端情境摄入 | MobileContextPayload→灵络静默更新→异常触发反思→低电量抑制 | ✅ |
| 12 | 内容安全边界 | 性/违法/私密数据三层硬约束, 关键词黑名单+正则脱敏, <1ms | ✅ |
| 13 | 生活状态建模 | mood/energy 动态追踪+7日趋势+触发词/证据链 | ✅ |
| 14 | 亲和力系统 | 对话事件→好感度增减→长期关系建模 | ✅ |
| 15 | 沙漏衰减 | 碎片活性随时间衰减, 重要记忆持久化 | ✅ |
| 16 | 偏好图谱 | 从对话提取偏好→因果发现→预测探针 | ✅ |
| 17 | 网络搜索增强 | 意图检测→搜索→来源引用 | ✅ |
| 18 | 聊天持久化 | 消息存储+状态快照+历史加载 | ✅ |
| 19 | 双通道网络架构 | WiFi局域网直连(首选)+信令穿透(兜底) | ✅ 设计 |
| 20 | 小模型 Persona 训练 | DistilBERT/ModernBERT ~66M 替换规则版 | ⏳ P1 |
| 21 | 元认知层完整重构 | dcgk-observer 预测探针 + dcgk-inject 预响应注入 | ⏳ P0 部分 |
| 22 | 灵络 dreaming 收敛 | dreaming与reflection-engine统一 | ⏳ P0 |
| 23 | 语音/TTS 集成 | 语音输入+输出 | ⏳ P1 |
| 24 | 移动端 App | iOS/Android 薄壳, 双通道网络实现 | ⏳ P2 |
| 25 | 多角色切换 | 多Persona配置+动态切换 | ⏳ P3 |
| 26 | 代码保护/混淆 | 防逆向+API Key保护 | ⏳ |

**统计: 19/26 完成 (73%)**

---

## 二、技术池

| 层 | 技术 |
|----|------|
| 运行时 | Node.js 22 + TypeScript 5 + tsx |
| 数据库 | better-sqlite3 (WAL, 47表, 33次渐进迁移) |
| 嵌入 | Ollama (本地 127.0.0.1:11434) + bge-m3 |
| LLM | DeepSeek API (api.deepseek.com) + OpenAI SDK 兼容协议 |
| 算法 | Hebbian Learning, STC, Eligibility Trace, Asymmetric Feedback (neg=5×, pos=0.3×) |
| 网络 | HTTP REST + SSE + CORS |
| 安全 | 关键词黑名单 + 正则脱敏 + .env手动解析 |
| 关键参数 | COSINE_MERGE=0.70, CREATE=0.60, PROPAGATION=3步, DECAY=0.5 |

---

## 三、核心功能依赖关系

```
POST /api/chat (用户输入)
  ├─ content-safety.ts — 安全检查 (sexual/illegal→拒绝, private→脱敏)
  ├─ life-state-model.ts — mood/energy 状态更新
  ├─ preference-graph.ts — 偏好提取+更新
  ├─ chat-engine.ts — 两阶段回复
  │   ├─ Stage1 buffer: persona-carrier + memory-recall (双路融合) + web-search
  │   └─ Stage2 LLM: System Prompt [角色+禁忌+记忆] → SSE push final
  ├─ affinity-system.ts — 好感度更新
  └─ chat-history.ts — 持久化

后台周期 (internal-clock, 每2分钟):
  ├─ dcgk-engine.lingluoDreaming() — 影子采集 + 衰减 + 反思
  └─ proactiveScan() — mood<-0.3? → reflect({isProactive:true}) → fragments

前端轮询 (mobile-sim, 每8秒):
  └─ GET /api/v1/proactive-care → is_proactive=1 AND is_read=0 → 返回 → 标记已读 → 204
```

---

## 四、API 端点

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/api/health` | 健康检查 + 时钟状态 |
| GET | `/api/state` | 生活状态快照 |
| POST | `/api/chat` | 对话 (SSE两阶段) |
| GET | `/api/history` | 聊天历史 |
| GET | `/api/events` | SSE事件流 |
| GET | `/api/reflection` | 反思日志 |
| POST | `/api/reflection/trigger?force=1` | 手动触发反思 |
| GET | `/api/affinity` | 亲和力状态 |
| GET | `/api/decay` | 衰减统计 |
| GET | `/api/preferences` | 偏好图谱 |
| POST | `/api/v1/context` | 移动端情境摄入 |
| GET | `/api/v1/proactive-care?device_id=xxx` | 主动关怀拉取 (is_read去重) |
| GET | `/api/lingluo/evolution` | 灵络图演化状态 |
| GET+POST | `/api/shadow` | 影子采集 |

---

## 五、数据流

### 灵络认知图谱
```
用户文本 + mood
  → dcgk-signal: mapToDeltaSignal() → {anchors, delta}
  → dcgk-disambiguate: hybridResolveAnchors()
      Path A: bge-m3 embedding → cosine → merge/create
      Path B: char-graph 字图匹配
  → dcgk-engine: propagate(nodeIds, delta) → 3步扩散激活
  → dcgk-engine: hebbianUpdate(event) → STC加权更新
  → dcgk-store: persistIfChanged() → SQLite
```

### 主动推送闭环
```
时钟 tick (2min)
  → [Internal Clock] 正在扫描认知图...
  → lingluoDreaming() (影子+衰减+反思)
  → proactiveScan()
      mood<-0.3 OR energy<0.3 OR trend↓?
      → reflect({force:true, isProactive:true})
      → fragments (is_proactive=1, is_read=0)

前端轮询 (8s)
  → GET /api/v1/proactive-care
  → is_proactive=1 AND is_read=0 → 返回 → UPDATE is_read=1
  → 无 → 204
```

---

## 六、6月16日全部任务指令与执行结果

共 **12 条**，按时间顺序（08:01 ~ 15:08 UTC）。

---

### #1 重写 memory-recall.ts 的核心召回逻辑 `08:01`

**原文**:
> 【任务指令：重写 memory-recall.ts 的核心召回逻辑】
> 背景：当前的 memory-recall.ts 使用了错误的 FTS5 关键词搜索。需要将其重写为基于"灵络 v3 认知图"的召回管线，并保留 V5 检索作为降级方案。
> 目标：实现 recallFromCognitiveGraph(userInput, limit=5)
> 核心步骤：信号提取→锚点消歧(bge-m3)→图传播(2步)→碎片映射→降级V5

**执行结果**:
- ✅ 创建 `memory-recall.ts` (~300行): 双路召回 + FragmentScore 加权融合
- ✅ 创建 `test-recall.ts`: 模拟输入验证管线连通
- ✅ bge-m3 超时→自动降级 V5 retriever

---

### #2 执行灵犀冷启动与最小真实环境构建 `08:06`

**原文**:
> 【任务指令：执行灵犀冷启动与最小真实环境构建】
> 背景：管线代码已验证通过。当前阻碍验证的是环境缺失和数据冷启动。需要用少量高质量真实数据完成系统的"第一次呼吸"。
> 要求：编写 bootstrap-env.ts — 环境自检(bge-m3)→碎片化(5-10条JSONL)→图冷启动→验证召回

**执行结果**:
- ✅ 创建 `bootstrap-env.ts`: 自检 + 碎片化 + 图冷启动 + 召回验证
- ✅ 5条真实数据 → fragments + dcgk_nodes/edges 表
- ✅ 验证: "今天代码又报错了" → anchors → 图节点 → Fragment原文

---

### #3 实现双路召回融合，解决 Limbo 区问题 `08:23`

**原文**:
> 【任务指令：实现双路召回融合，解决 Limbo 区问题】
> 背景：单靠 bge-m3，高频宽泛词汇（如"代码"、"报错"）cosine 落入 0.50-0.70 Limbo 区导致漏召回。
> 目标：bge-m3 语义路径 + 字图字面路径双路并行融合。Path A: bge-m3 (COSINE_CREATE=0.60)，Path B: char-graph 字面匹配

**执行结果**:
- ✅ `dcgk-disambiguate.ts`: `hybridResolveAnchors()` 双路融合函数
- ✅ `COSINE_CREATE`: 0.30 → 0.50 → 0.60 (bge-m3 中文基线校准)
- ✅ `char-graph.ts`: 符号路径提取 fragment anchors
- ✅ 合并: Set_A ∪ Set_B

---

### #4 实现基于分数的加权融合排序 `08:34`

**原文**:
> 【任务指令：实现基于分数的加权融合排序 (Score Fusion)】
> 背景：双路召回后 Fragment 排序存在随机性。需要基于分数的确定性排序。
> 目标：FragmentScore {bgeScore, charScore} × 加权融合: bgeScore×0.7 + charScore×0.3 → 降序

**执行结果**:
- ✅ `memory-recall.ts`: FragmentScore 接口 + 加权融合排序
- ✅ source 分类: fused_bge_priority / char_only / both
- ✅ Map<fragmentKey, FragmentScore> 去重合并

---

### #5 执行历史 JSONL 数据冷启动与灵络拓扑构建 `08:44`

**原文**:
> 【任务指令：执行历史 JSONL 数据冷启动与灵络拓扑构建】
> 背景：灵络图仅10个种子节点。需要将本地真实历史对话批量转化为认知拓扑和SQLite碎片。
> 目标：编写 bootstrap-history.ts — 10-20条JSONL → signal→disambiguate→propagate→hebbian→persist 闭环

**执行结果**:
- ✅ 创建 `bootstrap-history.ts` (~500行): 完整冷启动管线
- ✅ 本机 6/9 真实数据 (63条消息) → 82节点 + 146边
- ✅ 关键修复: `bootstrapEdges` neutral delta→弱边w=0.15双连情绪节点
- ✅ 边修复: 10→146条 (解决 in-memory vs SQLite 边丢失)

---

### #6 实现内部时钟与反思引擎 `08:51`

**原文**:
> 【任务指令：实现内部时钟与反思引擎 (Internal Clock & Reflection)】
> 背景：需要赋予系统"内生动力"，在没有用户新输入的情况下主动扫描认知图。
> 目标：internal-clock.ts (定时唤醒) + reflection-engine.ts (LLM反思→持久化REFLECTION碎片)，8h冷却

**执行结果**:
- ✅ `internal-clock.ts`: startClock/stopClock/tick, 30min默认间隔
- ✅ `reflection-engine.ts` (~240行): reflect() + 冷却 + DeepSeek + 持久化
- ✅ `run-reflection.ts` + `test-reflection.ts`: 3场景定量测试(工作压力/情绪恢复/技术讨论)

---

### #7 修复 P0 到 P1 的 3 个核心 Blocker `09:14`

**原文**:
> 【任务指令：修复 P0 到 P1 的 3 个核心 Blocker】
> Blocker 1: Hebbian 初始建边 — 新节点与情绪节点自动建边 w=0.2
> Blocker 2: 碎片上下文窗口 — 不存孤立单条，增加 PREV/NEXT
> Blocker 3: 前端时间戳 — 历史消息显示原始时间而非"现在"

**执行结果**:
- ✅ B1: `bootstrapEdges()` neutral delta + `createConceptNode`→bootstrapEdges
- ✅ B2: fragments 新增 `context_window` 列 + fragmenter 存储上下文
- ✅ B3: /api/history 返回 created_at + frontend addRawMessage 使用原始时间戳

---

### #8 P1 启动 - 人格载体接口定义与数据合成 `09:18`

**原文**:
> 【任务指令：P1 启动 - 人格载体 (Persona Carrier) 接口定义与数据合成 Pipeline】
> 目标：定义 PersonaStyle 接口 (warmth/verbosity/humor/formality)，定义 PersonaInferenceInput，编写 LLM 辅助数据合成脚本

**执行结果**:
- ✅ `types.ts`: PersonaStyle + PersonaInferenceInput 接口
- ✅ `persona-carrier.ts`: 6条情绪驱动规则推断
- ✅ `synthesize-persona-data.ts` + `persona_training_data.jsonl`

---

### #9 实现两阶段响应与 Persona 注入 `09:38`

**原文**:
> 【任务指令：实现两阶段响应 (Two-Stage Response) 与 Persona 注入】
> 目标：SSE两阶段消息推送 — Stage1 buffer(<100ms)→Stage2 LLM(final)，动态System Prompt含Persona约束

**执行结果**:
- ✅ `chat-engine.ts` (~240行): generateReplyTwoStage(ctx, ssePush)
- ✅ SSE双类型: type=buffer ("..."动画) → type=final (替换)
- ✅ 动态 Prompt: [角色设定]+[核心禁忌]+[背景记忆]
- ✅ styleToPrompt(): 四维参数→自然语言约束

---

### #10 P2 启动 - 情境摄入协议与双通道网络骨架 `12:58`

**原文**:
> 【任务指令：P2 启动 - 情境摄入协议 (Context Ingestion) 与双通道网络骨架】
> 目标：定义 MobileContextPayload 严格接口(最小必要+脱敏)，POST /api/v1/context 服务端接收，mood→delta映射，双通道网络架构设计

**执行结果**:
- ✅ `types.ts`: MobileContextPayload (activity_state/mood/location/battery)
- ✅ `server.ts`: POST /api/v1/context — 验证→delta→propagate→异常触发反思
- ✅ `docs/network-architecture.md`: WiFi直连+信令穿透双通道
- ✅ mood→delta: stressed=-0.3, fatigued=-0.2, happy=0.2

---

### #11 P2 验证 - 构建极简移动端模拟器与端到端闭环测试 `13:11`

**原文**:
> 【任务指令：P2 验证 - 构建极简移动端模拟器与端到端闭环测试】
> 目标：创建 public/mobile-sim.html — 6个情境按钮+消息展示区+手动拉取关怀+手动触发反思，验证BYOC完整闭环

**执行结果**:
- ✅ `public/mobile-sim.html` v1 (~170行): 6情境按钮 + 手动拉取 + 手动反思
- ✅ 端到端闭环: 情境推送→灵络更新→反思生成→关怀拉取 全部通过

---

### #12 修复主动推送闭环，实现真正的主动关怀 `15:08`

**原文**:
> 【任务指令：修复主动推送闭环，实现真正的与主动关怀】
> 背景：用户在前端无法感知到灵犀的"主动关怀"。目标：后台定时扫描→生成反思→前端自动拉取/展示的完整自动化闭环。
>
> 核心步骤：
> 1. 激活内部时钟：setInterval 后台定时任务，2分钟测试间隔
> 2. 扫描逻辑：寻找高权重负面关联(mood:stressed)→生成REFLECTION碎片→is_proactive:true
> 3. 前端拉取接口：GET /api/v1/proactive-care?device_id=xxx → 查is_proactive=1 AND is_read=0 → 返回 → 标记is_read=1 → 204去重
> 4. 移动端模拟器：5-10秒自动轮询 + 💡紫光UI
>
> 验收标准：控制台打印 [Internal Clock] 正在扫描认知图... / 端到端: stressed→2-3min→自动弹出关怀 / LLM失败不崩溃 / 前端轮询失败静默

**执行结果**:

| 文件 | 改动 |
|------|------|
| `internal-clock.ts` | ProactiveScanCallback注入 + testMode(2min) + 双路调度 + 异常隔离 |
| `reflection-engine.ts` | ReflectOptions {force, isProactive}, is_proactive/is_read 列 |
| `server.ts` | GET /api/v1/proactive-care is_read追踪 (200→204去重) |
| `index.ts` | proactiveScan() 回调: mood<-0.3 → reflect({isProactive:true}) |
| `connection.ts` | Migration 33: is_proactive + is_read 列 + 索引 |
| `mobile-sim.html` | v2: 8秒轮询 + 💡紫光气泡 + 启停按钮 + 静默重试 |

**端到端测试日志**:
```
[时钟] 23:11 醒来 #1
[Internal Clock] 正在扫描认知图...
[Internal Clock] 灵络 dreaming 完成
[Internal Clock] 执行主动关怀扫描...
[Internal Clock] 检测到异常状态: mood=0.00 energy=0.00
[Internal Clock] 触发主动反思...
[反思] #2 → "情绪和精力双零，用户处于临界点。最需关注的是睡眠启动..."

GET /api/v1/proactive-care → 200 {messages:[...]}
GET /api/v1/proactive-care → 204 (去重)
[时钟] 23:13 醒来 #2 → 第二轮正常
```

- ✅ 全部验收标准通过
- ✅ Commit `9e2dfac` → `Alience92/lingxi-v5`

---

## 附录: 关键参数速查

| 参数 | 值 | 位置 |
|------|-----|------|
| COSINE_MERGE | 0.70 | dcgk-disambiguate.ts |
| COSINE_CREATE | 0.60 | dcgk-disambiguate.ts |
| PROPAGATION_STEPS | 3 | dcgk-engine.ts |
| DECAY | 0.5 | dcgk-engine.ts |
| ELIGIBILITY_DECAY | 0.6 | dcgk-engine.ts |
| ASYMMETRIC_NEG | 5.0 | dcgk-engine.ts |
| TAG_BOOST | 4.0 | dcgk-engine.ts |
| MAX_NEW_EDGES_PER_HOUR | 10 | dcgk-engine.ts |
| REFLECTION_COOLDOWN | 8h | reflection-engine.ts |
| TEST_INTERVAL | 2min | internal-clock.ts |
| PROD_INTERVAL | 30min | internal-clock.ts |
| POLLING_INTERVAL | 8s | mobile-sim.html |
| bgeScore weight | 0.7 | memory-recall.ts |
| charScore weight | 0.3 | memory-recall.ts |
| LLM model | deepseek-chat | chat-engine.ts |
| Embed model | bge-m3 | Ollama 127.0.0.1:11434 |
| Server port | 11438 | index.ts |
