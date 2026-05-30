# 审查教训吸收机制：全局诊断与优化方案

> 版本：r2（2026-05-29）
> 状态：定稿，进入实施
> r2 更新：Opus 审查反馈——补充下游消费链路、教训过期、试用期降级、注入措辞、统一优先级体系

---

## 1. 问题起源

### 1.1 触发事件

Opus/GPT 多轮代码审查产生了 13 条有价值的教训（SQL 引号、FK 级联、stdio ignore 等），但现有蒸馏管道完全没有吸收这些教训。尝试新建一个平行的"审查教训系统"（`review_lessons` 表 + 关键词匹配 + prefetch 注入）——这违反了两个核心原则：动手前先讨论、执行规划中不横跳。回退后从全局视角重新审视。

### 1.2 核心问题

**审查产生的教训没有被吸收进系统。** 这不是一个新需求——这是现有系统承诺要做但没做到的事。

---

## 2. 全局诊断：为什么现有系统没吸收审查教训

### 2.1 现有链路

```
用户纠正 → lightweight_signals(correction) → 碎片化 → dreaming蒸馏 → L0规则 → 行为约束
```

这条链路理论上覆盖了。但每一步都有问题。

### 2.2 断点一：correction 信号权重过低

`lightweight_signals` 表捕获了 8 种信号类型：

| 信号类型 | 默认权重 | 实际含义 |
|----------|---------|---------|
| `correction` | 10 | 用户纠正了 Agent 的行为 |
| `decision` | 10 | 用户做出决策 |
| `topic` | 10 | 普通话题标识 |
| `frustration` | 10 | 用户表达挫败感 |
| `confirmation` | 10 | 用户确认 |
| `urgency` | 10 | 紧急信号 |
| `file_ref` | 10 | 文件引用 |
| `person_ref` | 10 | 人物引用 |

所有信号权重相同。**用户说"你犯错了"和用户说"这个文件在 X 目录"——在系统中是同等重量的事件。**

### 2.3 断点二：蒸馏引擎假设缺陷

`runDistillation()` 的核心逻辑：

```
1. 按 channel + label_prefix 聚类碎片
2. 同一簇需要 ≥ minMembers 个碎片（默认 5，novelty 下可降至 2）
3. 不同 session 数 ≥ minSessions（默认 2，novelty 下可降至 1）
4. FEEL 通道有额外的情感平均分门槛
```

隐含假设：**有价值的洞察一定会跨 session 重复出现。**

这个假设对用户习惯和偏好有效，但对审查教训无效：
- "SQL 引号嵌套"被指出了 1 次（但犯了 4 次）
- "阈值基于数据不是直觉"被指出了 1 次
- "后台进程 stderr 不能吞"被指出了 1 次

它们不会重复出现——因为它们被指出后，我就应该改进，错误不再犯。**一条教训如果被吸收，它就不会再出现。** 蒸馏引擎的"重复即价值"假设与此根本矛盾。

### 2.4 断点三：纠正反馈周期过长

```
纠正发生 → 等 compact → 等 dreaming 触发 → 蒸馏出规则 → 等下次 SessionStart 注入
```

每一步都是异步的，整个周期跨越多个 session。而实际需求是：**这次被纠正，下次类似场景就能想起来。** 不是 3 个 session 以后。

### 2.5 断点四：Challenge Events 未被蒸馏利用

`challenge_events` 表记录了规则冲突事件——规则应用到会话中时发生了什么、用户是否接受、是否产生冲突。这是一手的"教训原材料"，但 dreaming 管道没有读取它。这些事件被存储后从未被聚类或提炼为规则。

---

## 3. 解决方案

### 3.1 提高 correction 信号权重 + 打通下游消费

**改**：`lightweight-signals` 的 correction 类型默认权重从 10 提升到 40，decision 和 frustration 提升到 25。

**理由**：用户纠正 Agent 是一个高价值事件。它在系统中的权重应该反映其认知价值——纠正信号比普通话题标识重要得多。

**关键补充（Opus 发现）**：lightweight_signals.weight 在当前代码中**只被写入，不被下游消费**。`checkDreamingTrigger` 只读 COUNT，蒸馏只读 fragment_anchors.weight。提升权重但没有下游模块读取等于没改。

**下游消费链路**：

```
lightweight_signals.weight=40 (correction)
  ↓ 碎片化时：auto-fragment 读取 signals 表，高权重信号对应的
  │           文本片段在 fragment_anchors 中获得额外权重加成
  ↓ 蒸馏时：dreaming-worker 按 weight DESC 排序 signals，
  │         高权重信号优先进入单次高价值蒸馏路径 (Step 2b)
  ↓ 触发时：correction 信号权重直接用于 dreaming 触发阈值计算
```

具体改动点：
1. **lightweight-extractor.ts**：correction→40, decision→25, frustration→25
2. **dreaming-worker.ts**：查询 signals 时 `ORDER BY weight DESC, created_at ASC`
3. **auto-fragment.ts**（可选 P1）：碎片化时读取 signals 权重影响 anchor weight

### 3.2 蒸馏引擎加"单次高价值"路径

**在 dreaming 的 Step 2（蒸馏）之后，新增 Step 2b：单次高价值事件提升。**

```
输入：lightweight_signals 中 consumed=0 的 correction/decision/frustration 信号
      （按 weight DESC 排序，LIMIT 50）
筛选：信号对应的 session 已被碎片化（按 session_id 匹配 fragments）
      且片段内容不同于已蒸馏规则的 fingerprint
操作：
  1. 从关联 fragments 中提取核心内容（最长的 fragment_anchors.WHAT label）
  2. 嵌入文本，向量搜索现有 distilled_rules，cosine > 0.80 判定为重复
  3. 如果没有 → 创建 priority=25 的 L0 规则
  4. 如果有 → 追加 rule_source 并提升 weight ×1.1（上限 2.0）
  5. 标记 signal 为 consumed
```

**关键设计**：
- 不依赖跨 session 重复——correction 信号本身就是强度证据
- fingerprint 去重用向量 cosine > 0.80（**不用 LIKE**——中文场景 LIKE 区分度过低，且灵犀已有 embedding 基础设施）
- priority=25：介于宪法级（0）和普通规则（50）之间

**试用期降级**：priority=25 的规则 30 天内如果未被 prefetch 检索命中（没有在 correction 事件中被注入），自动降级为 priority=50。防止低价值的一次性纠正永久占用注入预算。

### 3.3 Correction 事件检索

**在 prefetch 中，当检测到用户消息包含 correction 信号时**（轻量信号提取结果中包含 correction），执行：

```
1. 搜索过去 30 天内的相似 correction 片段（向量搜索，限制同类 correction）
2. 匹配 top 1-2 条相关教训
3. 注入格式："相关历史：[教训内容]。当前场景类似，注意避免相同问题。"
```

**注入措辞**（Opus 建议）：不带评判色彩，只提供信息。"你之前也犯过类似错误"可能触发模型的 sycophancy 偏向（过度道歉），改为中性陈述句。

**时间衰减**：

| 教训年龄 | 行为 |
|----------|------|
| ≤30 天 | 正常注入 |
| 30-90 天 | 注入但标注"历史教训，可能已过时" |
| 90 天+ | 不注入（等待蒸馏或自然淘汰） |

**Token 分析**：
- correction 信号是低频事件（每天最多几次）
- 每次触发 ≤ 2 条教训，≤ 100 tokens
- 平时零开销
- 假设日均 3 次纠正 × 100 tokens = 300 tokens/天

**不需要每轮搜索**——这是自限的，因为纠正本身不频繁。

### 3.4 Challenge Events 接入蒸馏

**在 dreaming 中，Step 2b（单次高价值）之前**，扫描 `challenge_events` 表中未解析的 L2/L3 事件：
- 用户拒绝了某条规则的应用（`user_accepted = 0`）
- 规则引起了冲突（`caused_conflict = 1`）

将这些事件的内容摘要作为额外的输入加入蒸馏——它们是"不该做什么"的直接证据。

### 3.5 教训过期与质量控制

**过期**：未蒸馏的 correction 教训在 prefetch 检索时有时间窗口，超期不注入。防止 6 个月前的一次性上下文纠正（"这个项目端口不是 3000"）永久占用注入预算。

**质量控制——试用期降级**：单次事件路径创建的 priority=25 规则，30 天内如果未被 prefetch 再次命中（没在 correction 事件中被检索到），自动降级为 priority=50。这确保只有持续有用的教训留在高优先级层。

### 3.6 统一优先级体系

两份设计文档（本文 + `incidents/2026-05-29-L0-rule-violation.md`）的 priority 体系需保持一致：

| priority | 来源 | 注入区块 | 说明 |
|----------|------|---------|------|
| 0 | MEMORY.md 铁律 → 碎片化 → 蒸馏 | 铁律约束（不可覆盖） | 宪法级，不可被任何规则覆盖 |
| 25 | 单次高价值 correction | 教训规则 | 可被铁律覆盖，30 天试用期 |
| 50 | 跨 session 重复蒸馏（≥5 成员 + ≥2 session） | 行为建议 | 普通规则 |
| 100 | 建议级（待设计） | — | 最低优先级，仅参考 |

SessionStart 注入顺序：铁律 → 教训 → 行为建议。每个区块明确标注是否可被覆盖。

---

## 4. 为什么不新建系统

| 维度 | 新建审查教训系统 | 优化现有管道 |
|------|-----------------|-------------|
| 数据源 | 单一：外部审查 | 全部：用户纠正 + 审查 + 自检 + 冲突事件 |
| 触发机制 | 关键词匹配用户意图 | 纠正事件本身触发检索 |
| 与现有系统 | 平行，增加维护负担 | 补洞，不新加概念 |
| Token 成本 | 每轮都有（关键词匹配是常态） | 仅纠正发生时（低频） |
| 例子覆盖 | SQL、bash 等技术操作 | 技术操作 + 行为模式（确认→动手、分类→实施） |

新建系统把"审查教训"当作一种新的数据类型处理。但实际上，它和用户纠正、challenge_event、自检发现是**同一类东西**：都是"错误→纠正→学习"循环的不同输入源。优化现有管道让所有输入源都能被吸收，比新建一个只处理审查的系统更根本。

---

## 5. 优先级与工程量

| 改动 | 文件 | 行数 | 优先级 |
|------|------|------|--------|
| correction/decision/frustration 权重提升 | `lightweight-extractor.ts` | 5 | P0 |
| 下游消费：dreaming-worker 按 weight DESC 查询 signals | `dreaming-worker.ts` | 5 | P0 |
| 单次高价值蒸馏路径（向量去重 + 试用期降级） | `engine.ts` | ~60 | P0 |
| SessionStart 加 priority=25 "教训规则"注入区块 | `session-start.ts` | ~15 | P0 |
| correction 事件检索 + 时间衰减 | `prefetch.ts` | ~40 | P1 |
| challenge_events 接入蒸馏 | `dreaming-worker.ts` + `engine.ts` | ~30 | P2（前提：≥10 条有效数据） |

**P0 之和 ~85 行**。不新建表、不增加 MCP 工具。P0 完成后系统即可吸收审查教训，P1 提供加速通道，P2 扩展数据源。

---

## 6. 对 Token 约束的最终分析

用户核心关切：**长期积累审查教训，在应用层应用，是否会导致 token 爆炸？**

**不会。** 原因：

1. **触发频率自限**：correction 事件是低频的，正常情况下每天 ≤3 次。检索只在纠正发生时触发，不是每轮都做。

2. **注入量极小**：每次 ≤2 条教训 × ≤80 tokens = ≤160 tokens/次。日均 ≤500 tokens。

3. **不常驻上下文**：不像 L0 规则随 SessionStart 注入且持续占用上下文。教训只在相关纠正发生时临时出现，随后自然滚动出窗口。

4. **蒸馏后的 L0 规则不需要教训检索**：一旦某个教训被蒸馏为 L0 规则（priority=25），它就会出现在 SessionStart 注入中。prefetch 的 correction 检索只作为**蒸馏尚未完成的快速通道**——确保教训能在被蒸馏前应用。

这条链路的设计：**快速检索（当天生效）→ 蒸馏（跨 session 持久化）→ L0 规则注入（持续生效）**。随着系统成熟，快速检索的负担会越来越低，因为越来越多的教训已经进入了 L0 规则层。
