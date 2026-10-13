# 灵犀人格建模系统 — 双 Profile 架构设计文档

> 日期: 2026-06-17
> 状态: 设计定稿
> 关联文档: [灵犀陪伴者技术规格书](./lingxi-soul-companion-spec.md)

---

## 一、核心洞察

灵犀一直在做一件事：对用户建模，让 AI 理解用户是谁。

**明星建模和用户建模，是同一条 Pipeline 的不同数据源。**

| | 用户建模（已有） | 明星建模（新增） |
|---|---|---|
| 数据源 | Claude Code 对话 JSONL | 歌词/访谈/演唱会/社交媒体文本 |
| 采集方式 | shadow-collector 增量 | 批量导入脚本 |
| 建模引擎 | DCGK + preference-graph | **同款** DCGK + preference-graph |
| 风格推断 | persona-carrier | **同款** persona-carrier |
| 实时状态 | life-state-model 动态追踪 | ❌ 不需要（角色状态是固定的） |
| 主动关怀 | reflection-engine + proactive-care | ❌ 不需要 |
| 输出 | System Prompt 约束 + 回复风格 | **同款** System Prompt 约束 + 回复风格 |

---

## 二、人格维度框架（16 维，四层）

### 2.1 内核层 — "他为什么这样想"

| 维度 | 捕捉什么 | 来源示例 |
|------|---------|---------|
| **价值观体系** | 反复强调的信条、拒绝妥协的底线 | 歌词宣言、争议回应长文 |
| **自我认知** | 他怎么看自己（自嘲、定位、不安全感） | 访谈自述、演唱会 talking |
| **内在张力** | 身上的矛盾点（悲观写励志歌、怕数字做 CEO） | **需要 LLM 跨源对比分析** |
| **创伤与脆弱** | 承认的失败、遗憾、害怕的事 | 个人故事（奶奶过世、鸭川） |

### 2.2 认知层 — "他怎么想问题"

| 维度 | 捕捉什么 | 来源示例 |
|------|---------|---------|
| **推理链路** | "观察到A→得出B→选择C" | 商业决策专访、创作理念访谈 |
| **隐喻系统** | 反复使用的比喻库（航行=人生、蝉=夏天） | 歌词 + 微博散文 + talking |
| **关注焦点** | 同一事件先注意哪个面向 | 访谈中主动开启的话题方向 |
| **时间取向** | 面向过去/现在/未来 | 歌词时间主题分布 |

### 2.3 表达层 — "他怎么说"

| 维度 | 捕捉什么 | 来源示例 |
|------|---------|---------|
| **句式结构** | 长短句比例、排比习惯、疑问/陈述偏好 | 微博散文 vs 歌词文本对比 |
| **语气光谱** | 温暖/热血/郑重/自嘲的切换条件 | 不同场景的原始发言 |
| **节奏特征** | 停顿习惯、省略号频率、转折方式 | 演唱会 talking 逐字稿 |
| **书面/口语倾向** | 不同场景切不同模式 | 微博（散文）vs 歌词（诗）vs talking（口语） |

### 2.4 关系层 — "他面对谁怎么说"

| 维度 | 捕捉什么 | 来源示例 |
|------|---------|---------|
| **权力距离** | 对长辈/权威 vs 对朋友/晚辈的不同态度 | 对李宗盛 vs 对歌迷的语言差异 |
| **冲突模式** | 直接回应/含蓄婉转/幽默化解 | 假唱回应、商业化争议回应 |
| **亲密距离** | "自己人"（团员、歌迷）vs "外界"的语言标记 | "你们"vs"他们"的使用场景 |
| **演变轨迹** | 25 年中什么变了什么没变 | 早期专辑 vs 近期发言 |

### 2.5 当前收集覆盖评估

基于 D:\AshinMaterials 12 个文件、220 段文本的分类结果：

| 维度 | 状态 | 数量 | 缺口原因 |
|------|------|------|---------|
| 隐喻系统 | ✅ | 86条 | — |
| 亲密距离 | ✅ | 99条 | — |
| 书面口语 | ✅ | 65条 | — |
| 时间取向 | ✅ | 45条 | — |
| 推理链路 | ✅ | 39条 | — |
| 关注焦点 | ✅ | 33条 | — |
| 演变轨迹 | ✅ | 30条 | — |
| 价值体系 | ✅ | 20条 | — |
| 自我认知 | ✅ | 19条 | — |
| 权力距离 | ✅ | 15条 | — |
| 节奏特征 | ✅ | 35条 | — |
| 创伤脆弱 | ⚠️ | 13条 | 缺深度分析，多是故事片段 |
| 冲突模式 | ⚠️ | 11条 | 缺更多争议案例 |
| 语气光谱 | ⚠️ | 8条 | "郑重解释"等非典型语气少 |
| **内在张力** | ❌ | 0条 | 关键词无法匹配矛盾——必须 LLM 分析 |
| 句式结构 | ❌ | 3条 | 无人做过语言学分析 |

**结论**：14/16 维度有基础覆盖。两个零分维度（内在张力、句式结构）加上三个偏少维度（创伤脆弱、冲突模式、语气光谱）——全部可以通过对已有素材跑一遍 LLM 深层提取来补充，不需要重新搜索。

---

## 三、架构：三层各司其职

### 3.1 DCGK 的真实能力边界

DCGK 做且仅做一件事：**统计共现关系，用 Hebbian 强化高频路径，用扩散激活找相关节点。**

| DCGK 能做 | DCGK 不能做 |
|----------|-----------|
| 存节点+边+权重 | 理解文本含义 |
| 统计共现（A和B一起出现过几次） | 区分真心话和场面话 |
| Hebbian 强化（经常一起激活→边加强） | 发现新的维度标签 |
| 扩散激活（从A找到相关的B/C/D） | 判断这个 trait 在当下该不该用 |
| 冲突检测（A和B同时高激活） | 生成回复、分析语气、理解隐喻 |

DCGK 是一个**高维关联索引**，负责存和查。理解是 LLM 的事。

### 3.2 三层架构

```
Layer 1: LLM 理解层 (新增)
  ┌─────────────────────────────────────────┐
  │ 输入: 原始文本（歌词/访谈/talking/微博）  │
  │ 输出: 结构化 trait 提取                  │
  │   {维度, 标签, 原文佐证, 强度0-1, 场景}  │
  │                                         │
  │ 额外输出:                               │
  │   矛盾对 [{trait_A, trait_B, 为什么矛盾}] │
  │   避讳列表 [{禁止表达}]                   │
  │   隐喻映射 [{本体 → 喻体}]                │
  └──────────────┬──────────────────────────┘
                 │
                 ▼
Layer 2: DCGK 关联层 (保留，降级)
  ┌─────────────────────────────────────────┐
  │ 存储:                                   │
  │   trait 节点 → cooccurs 边（共现统计）    │
  │   trait 节点 → contrasts 边（矛盾检测）   │
  │   trait 节点 → evidence 边（→指向源文本） │
  │                                         │
  │ 运行时:                                 │
  │   输入场景 → 激活相关 trait → 输出列表    │
  │   Hebbian 加强高频共现，衰减低频噪声      │
  └──────────────┬──────────────────────────┘
                 │
                 ▼
Layer 3: Persona Profile (新增)
  ┌─────────────────────────────────────────┐
  │ DCGK 图 → 导出风格参数                    │
  │                                         │
  │ 冲突模式: 直接回应(w:0.8)                 │
  │ 死亡观:   轮回(0.85), 遗憾(0.60)         │
  │ 句式偏好: 排比(0.7), 反问(0.3)           │
  │ 避讳词:   ["你应该", "放弃", "别想了"]     │
  │                                         │
  │ 输出到 chat-engine 构造 System Prompt     │
  └─────────────────────────────────────────┘
```

### 3.3 DCGK 不是被"替换"，是被"拿走不该做的，加回该做的"

| 环节 | 原来（过度使用 DCGK） | 修正后 |
|------|---------------------|--------|
| 分析文本含义 | DCGK 直接消化文本 | **LLM 提取 trait**，DCGK 只存结果 |
| 理解隐喻 | 靠边权重体现"蝉→童年" | **LLM 分析隐喻含义**，DCGK 存映射 |
| 发现内在矛盾 | 依赖 Hebbian 偶然形成冲突边 | **LLM 主动标注矛盾对**，DCGK 存 contrasts 边 |
| 推理时决策 | dcgk-inject 拼约束块 | **Persona Profile 翻译为 System Prompt** |
| 生成回复 | 约束注入后靠 LLM | 同，不变 |

---

### 3.4 DCGK 节点命名规范与证据链保留

**问题**: LLM 提取 trait 写入 DCGK 后，Layer 3 (Persona Profile) 导出时必须有完整溯源——"他喜欢用航行隐喻" 这句话的证据是什么？来自哪首歌的哪段歌词？

**规范**:

```
节点命名空间化:
  trait:metaphor:sailing     — 隐喻:航行
  trait:value:stubborn       — 价值观:倔强（不妥协）
  trait:self:cannot_sing     — 自我认知:不会唱歌
  trait:tension:pessimist_motivator — 内在张力:悲观者写励志歌
  contradiction:{trait_A}_vs_{trait_B} — 矛盾对（专用节点类型）

边类型:
  cooccurs    — A和B在同一场景中共现（统计关联）
  contrasts   — A和B是同一维度的相反表达（逻辑矛盾）
  evidence    — trait → fragment（保留溯源） ⬅️ 新增，关键

evidence 边的价值:
  导出 trait "隐喻:航行" 时，可附带原文佐证:
  "就像他在《诺亚方舟》里写的：'终于会有一天，我们都变成昨天'"
  → System Prompt 不会是干巴巴的标签，而是带着真实语感的约束
```

### 3.5 双 Profile 的底层隔离机制

**问题**: 在内存中 load/unload 整个图 = 性能抖动 + 状态污染。两个 Profile 需要共存。

**方案**: DB 层引入 `profile_id`，不改内存结构。

```
SQL 层改动:
  fragments 表:     + profile_id TEXT DEFAULT 'user_default'
  dcgk_nodes 表:    + profile_id TEXT DEFAULT 'user_default'
  dcgk_edges 表:    + profile_id TEXT DEFAULT 'user_default'

  profile_id 取值:
    'user_default'  — 当前用户的个人 Profile
    'ashin'         — 阿信
    'jay'           — 未来可能的周杰伦
    ...

运行时热切换:
  // 当前激活的 profile_id
  personaCarrier.setActiveProfile('ashin');

  // DCGK 所有操作自动带上过滤
  loadFullGraph(profileId)       → SELECT ... WHERE profile_id = ?
  propagate(anchors, delta)      → 仅影响当前 profile 的图
  collectActivatedNodes(threshold) → WHERE profile_id = 'ashin'

  无需重启服务，无需清空内存。
```

### 3.6 训练数据冷启动噪声控制

**问题**: Phase 3 从 DCGK Profile 反向生成场景构建训练对。如果 Layer 1 或 Layer 2 有噪声（如将玩笑误识别为核心价值观），训练对会污染小模型。

**方案**: Cross-Validation 闭环过滤。

```
生成场景 → 标注风格参数 (S_expected)
    │
    ▼
用场景作为输入 → 过 DCGK → 激活 trait 列表 (T_actual)
    │
    ▼
比较: T_actual 是否命中场景声称的源 trait?
    │
    ├── 命中 + 高置信度 (>0.7) → ✅ 保留
    ├── 命中 + 低置信度 (0.3-0.7) → ⚠️ 标记，人工抽检
    └── 未命中 → ❌ 丢弃（噪声）
```

这条规则保证：**每个训练对都能回到 DCGK 中的真实 trait 节点。无法闭环的数据直接丢弃。** 不做这一步的代价是——小模型学到的是 LLM 提取时的偏差，不是明星的真实人格。

### 3.7 攻克"内在张力"：Contradiction Detection Prompt

**问题**: "内在张力"是 16 维中唯一零覆盖的维度。常规提取 Prompt 只能处理单段文本，无法发现"他说 A 但做 B"。

**方案**: 专用 Contradiction Detection Prompt，跨源对比。

```
Prompt 设计:
  输入: 同一主题下的多个表述集合
    主题: "商业"
      来源A (2024 Threads回应): "商业不是想商业就能赚大钱，另类不是要另类就会没共鸣。"
      来源B (2012 Cheers专访): "去接受管理，去了解我最害怕的数字和报表，就是一种承担。"
      来源C (早期歌词): "我们就是烂烂的" / "我不愿做人奸巧钻缝"

  输出要求:
  {
    theme: "商业与真实",
    surface: "他接受商业是中性工具，资源无罪",
    behavior: "他同时反复强调'烂烂的'、'不奸巧'——拒绝被商业驯化",
    tension: "一边做CEO看报表管200人，一边反复确认自己还是'烂烂的五月天'",
    intensity: 0.85,
    evidence_sources: ["2024商业化回应", "2012-Cheers专访", "憨人歌词"]
  }
```

此 Prompt 对每个主题（商业、创作、成功、年龄）只运行一次，输入是跨所有来源的表述聚合。输出直接写入 DCGK 的 `contradiction:` 节点。

---

## 四、双 Profile 并行架构

```
灵犀 BYOC Server
    │
    ├─── Profile: "用户"
    │    ├── 数据源: Claude Code JSONL
    │    ├── 采集: shadow-collector 增量
    │    ├── 引擎: 全套灵犀（34模块）
    │    │    ├── fragmenter → DCGK → preference-graph
    │    │    ├── persona-carrier → chat-engine
    │    │    ├── life-state-model（实时追踪）
    │    │    └── reflection + proactive-care（主动关怀）
    │    └── 状态: 持续更新，实时
    │
    └─── Profile: "阿信"
         ├── 数据源: D:\AshinMaterials\*.txt
         ├── 采集: 批量导入脚本（一次性）
         ├── 引擎: 灵犀子集
         │    ├── fragmenter → DCGK → preference-graph
         │    ├── persona-carrier → chat-engine
         │    └── ✗ life-state-model（不需要实时追踪）
         │    └── ✗ proactive-care（不需要主动关怀）
         └── 状态: 离线预处理，加载后为只读 Profile
                  后续可增量添加新素材
```

### Profile 是灵犀各模块的配置层

```typescript
// 切换人格 = 切换模块配置
personaCarrier.loadProfile("ashin");
affinitySystem.setBaseline({ fan: 0.8, stranger: 0.3 });
contentSafety.addBoundaries(["不评判他人梦想"]);
lifeStateModel.setBaseline({
  midnight: "philosophical",   // 深夜偏哲学
  stage: "energetic",         // 舞台上热血
  criticism: "calm"           // 面对批评偏冷静
});
sandglassDecay.setDecayMap({
  earlyLyrics: 0.3,  // 早期歌词权重低
  recentInterview: 1.0  // 近期采访权重高
});
```

---

## 五、小模型策略

### 5.1 小模型 = 被蒸馏的明星

```
小模型不是语言生成器，是人格区分器。

它的职责：检查 LLM 的输出像不像这个明星
它的输入：上下文 + LLM生成的候选回复 + 当前激活的人格trait
它的输出：风格纠偏建议（"更像他一点：加上排比、去掉'你应该'"）
```

### 5.2 模型规格

| 参数 | 值 |
|------|-----|
| 类型 | 人格区分器（Persona Classifier） |
| 参数量 | ~66M（DistilBERT / ModernBERT） |
| 输入 | mood + energy + 对话上下文 + 当前激活的16维trait子集 |
| 输出 | PersonaStyle {warmth, verbosity, humor, formality} + 避讳词列表 |
| 替代模块 | persona-carrier.ts（当前规则版，6条规则） |
| 训练数据 | 从 DCGK Profile 反向生成：每个 trait → 多个场景 → 标注风格参数 |

### 5.3 训练数据来源

```
DCGK 图（加载了阿信 Profile）
    │
    │  导出: trait列表 + 冲突对 + 避讳词
    │
    ▼
场景生成器
    │
    │  为每个 trait 组合生成 N 个对话场景
    │  例: trait{时间取向:回忆，隐喻系统:航行，语气:温柔}
    │        → 场景: 深夜对话 + 哲学话题
    │        → 输出标注: {warmth:0.8, verbosity:0.6, humor:0.1, formality:0.4}
    │
    ▼
训练集: {输入特征, 目标风格参数} 对
```

### 5.4 为什么不是语言生成模型

| | 语言生成模型（1-3B） | 人格区分器（~66M） |
|---|---|---|
| 部署成本 | GPU/高内存，本地难 | CPU 可跑，<100MB |
| 训练数据 | 需要海量文本 | 需要高质量标注对 |
| 上线路径 | 替代 DeepSeek（风险高） | 辅助 DeepSeek（风险低） |
| 和灵犀架构关系 | 需要独立部署 | 直接挂在 persona-carrier 下 |
| 实际价值 | 灵犀本来就要调 LLM | 提升 LLM 回复的个性化质量 |

---

## 六、实现计划

### Phase 1: 数据导入 + trait 提取（本周）

1. 创建 `import-persona.ts` — 将 D:\AshinMaterials 批量导入灵犀
2. 设计 LLM trait 提取 Prompt（输入原文 → 输出16维 trait JSON）
3. 跑提取：已有文本 → trait 列表 → 写入 DCGK
4. 重点攻缺口：内在张力、句式结构

### Phase 2: Persona Profile 模块（下周）

1. 创建 `persona-profile.ts`
   - `loadProfile(name)` — 从 DCGK 加载指定角色的 Profile
   - `exportProfile(name)` — 导出风格参数 JSON
   - `compareTrait(profile1, profile2, trait)` — 对比两个角色的同一维度
2. 接入 persona-carrier.ts
   - 新增 `loadProfile()` 调用
   - Profile 参数覆盖规则推断的默认值

### Phase 3: 训练数据生成（两周后）

1. 从 DCGK Profile → 场景生成 → 训练对
2. 质量过滤：去除和任何维度都不相关的场景
3. 输出训练集 JSONL

### Phase 4: 小模型训练（三周后）

1. DistilBERT/ModernBERT 微调
2. 评估：用 trait 列表逐条验证
3. 接入 persona-carrier，对比规则版效果

---

## 七、关键设计决策

| 决策 | 结论 | 理由 |
|------|------|------|
| DCGK 在人格建模中的角色 | 关联存储，不是理解引擎 | DCGK 只做共现统计和理解 |
| LLM 的角色 | 提取 trait + 分析矛盾 + 场景生成 | LLM 做所有需要"理解"的事 |
| 小模型的角色 | 人格区分器，不是语言生成器 | 语言生成交给 DeepSeek |
| 明星 vs 用户 | 同一套 Pipeline，不同数据源 | 复用度 >90% |
| Profile 颗粒度 | 每个明星一个 DCGK 子图 | 图之间独立，降低耦合 |
| 内在张力 | 必须单独提取 | 这是人格深度最重要的一维 |

---

## 八、工程风险与防范

### 8.1 LLM 提取噪声放大效应

**风险**：Phase 1 的 Trait 提取 Prompt 不够严谨 → 将玩笑话误提取为核心价值观 → DCGK 忠实地将其作为高频节点 Hebbian 强化 → 噪声在图里滚雪球。

**防范**：

```yaml
Trait 提取强制性约束:
  1. 置信度阈值:
     - 强度 < 0.5 的 trait     → 不创建节点（丢弃）
     - 强度 0.5-0.7 的 trait   → 创建节点但标记 C=0.3, P=0.7（低置信，高可塑性）
     - 强度 > 0.7 的 trait     → 正常创建 C=0.7, P=0.3（高置信，低可塑性）

  2. 必须提供 evidence:
     LLM 输出的每条 trait 必须包含原文证据字段:
     { label:"不妥协", evidence:"当我和世界不一样，那就让我不一样", source:"倔强" }
     无 evidence 的 trait → 直接丢弃，不进入 DCGK

  3. 跨源交叉验证（对 "价值体系" 类 trait 强制）:
     一个核心价值观 trait 必须在 ≥2 个独立来源中得到支撑，
     否则降级为 "潜在倾向"（C=0.2, P=0.9，等待更多证据）
```

这样在管道最前端就过滤了噪声——DCGK 不接触未经证据支撑的 trait。

### 8.2 跨 Profile 状态污染

**风险**：引入 `profile_id` 后，dcgk-engine.ts 中的 Hebbian 更新、扩散激活、沙漏衰减有任何一处遗漏了 `profile_id` 过滤 → "阿信的偏好影响了默认用户"的串味现象。

**防范**：

```typescript
// dcgk-engine.ts 改造点——所有图操作必须携带 profile_id

// 原来（无隔离）:
const { nodes: dbNodes, edges: dbEdges } = loadFullGraph();

// 改后（profile 隔离）:
const activeProfile = getActiveProfile(); // 'user_default' | 'ashin'
const { nodes: dbNodes, edges: dbEdges } = loadFullGraph(activeProfile);

// 需要改的函数（逐一确认）:
//   loadFullGraph(profileId)     — ✅ 加上 WHERE profile_id = ?
//   persistIfChanged(edge)       — ✅ edge 写 DB 时带 profile_id
//   hebbianUpdate(delta)         — ⚠️ 操作内存中的 edges[]，需确认只加载了当前 profile
//   propagate(anchors, delta)    — ⚠️ 操作内存中的 nodes[]，确认同上
//   synapticPrune()              — ✅ 加上 profile_id 过滤
//   seedBootstrapNodes()         — ✅ 创建种子节点时写入 profile_id
//   addMemoryNode(id, label)     — ✅ 创建节点时写入 profile_id

// 单测覆盖:
//   test("Hebbian 更新只影响当前 profile")  → 写
//   test("扩散激活不跨 profile 泄漏")        → 写
//   test("沙漏衰减不删错 profile 的节点")    → 写
```

**关键约束**：内存中一次只加载一个 profile 的图。切换 profile 时，先 `flushEdgePersistence()` 确保写完，然后 `initGraph(activeProfile)` 重载。避免在同一个内存图里混合两个 profile 的数据。

### 8.3 反向生成训练集的过拟合

**风险**：Phase 3 从 DCGK 反向训练数据时，场景生成器过于刻板 → 每个 trait 总是映射到固定的几个场景模板 → 66M 模型变成规则匹配器（"看到商业关键词就输出 0.3 warmth"），而非真正的风格区分器。

**防范**：

```typescript
// 场景生成器中加入三层多样性机制

// 1. 参数高斯噪声
function addNoise(baseStyle: PersonaStyle, sigma: number = 0.08): PersonaStyle {
  return {
    warmth:    clamp(baseStyle.warmth    + gaussian(0, sigma), 0, 1),
    verbosity: clamp(baseStyle.verbosity + gaussian(0, sigma), 0, 1),
    humor:     clamp(baseStyle.humor     + gaussian(0, sigma), 0, 1),
    formality: clamp(baseStyle.formality + gaussian(0, sigma), 0, 1),
  };
}

// 2. Edge Case 采样（每轮必须包含）
const EDGE_CASES = [
  "激烈批评",      // 冲突模式压力测试
  "深夜独白",      // 时间取向切深夜模式
  "陌生人搭话",    // 亲密距离为陌生
  "无意义输入",    // 非对话场景
  "快速连续追问",  // 节奏特征压力测试
];

// 3. 负样本混入（每批 15%）
// 生时同时生成 "这不是阿信会说的回复" 作为负样本
// → 模型学习区分 "像阿信" vs "不像阿信"
```

这三层叠加后的训练集：同一 trait 会出现在不同噪声水平、不同边缘场景下，且混入明确的负样本。模型学到的是"区分边界"而非"匹配规则"。

### 8.4 风险与防范汇总

| 风险 | 后果 | 防范 | 防线位置 |
|------|------|------|---------|
| LLM 噪声放大 | 玩笑当真理，DCGK 强化错误信号 | 置信度阈值 + 强制 evidence + 跨源验证 | Phase 1 提取 Prompt |
| Profile 串味 | 不同角色人格互相污染 | profile_id 全局过滤 + 内存单 Profile + 单测 | dcgk-engine 全部操作 |
| 训练集过拟合 | 66M 模型变规则匹配器 | 高斯噪声 + Edge Case + 负样本混入 | Phase 3 场景生成器 |

| 维度 | 覆盖 | 来源 |
|------|------|------|
| 价值体系 | 20段 | 《倔强》《成名在望》商业化回应 |
| 自我认知 | 19段 | 开讲啦、数学5分、不会唱歌 |
| 内在张力 | 0段 | ⚠️ 需LLM分析 |
| 创伤脆弱 | 13段 | 奶奶过世、鸭川故事、被退学 |
| 推理链路 | 39段 | 商业访谈、STAYREAL 专访 |
| 隐喻系统 | 86段 | 航行、五月、蝉、彩虹、天空 |
| 关注焦点 | 33段 | 品牌经营、设计理念 |
| 时间取向 | 45段 | 青春/长大/老了/回忆 |
| 句式结构 | 3段 | ⚠️ 需语言学分析 |
| 语气光谱 | 8段 | ⚠️ 需更多场景标注 |
| 节奏特征 | 35段 | 省略号、停顿、talking 节奏 |
| 书面口语 | 65段 | 微博/歌词/talking 三模 |
| 权力距离 | 15段 | 李宗盛、老师、周杰伦 |
| 冲突模式 | 11段 | 假唱回应、商业化回应 |
| 亲密距离 | 99段 | 团员、歌迷 |
| 演变轨迹 | 30段 | 无名高地→鸟巢55场 |

**总素材: 12 文件 / 220 段 / 约 2.5 万纯中文字**
