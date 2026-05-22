# Agent Memory System v3 — Design Spec

> 状态：设计定稿 | 2026-05-22
> 来源：agent-memory-system-design.md 迭代 + 全天深度讨论
> 落地形态：跨平台记忆插件（核心引擎 + 适配层）

---

## 北极星三阶段

```
Goal 1: 项目完成前，细节不会忘
  → 项目完成后，提取关键成长信息，Agent 随项目变多而成长

Goal 2: Agent 越来越懂用户习惯
  → 主动给出推荐性内容，让用户觉得 Agent 更适配自己

Goal 3: Agent 预测用户的行为逻辑、习惯、思考模式
  → 拿到需求后给出一套直接击中用户内心的实施方案
```

本 spec 覆盖 **Goal 1**（v3 记忆引擎）。Goal 2 依赖跨项目蒸馏 + 用户模型构建，Goal 3 依赖预测式 Agent 行为，放在后续 Phase。

**Goal 1→2 过渡触发条件（待 Phase 2 验证）：**
```
满足任一：
  - 跨项目 L0 蒸馏规则 ≥ 20 条
  - 用户完成 ≥ 3 个项目
  - 跨项目同类 L1 碎片 ≥ 50 条
→ 触发跨项目蒸馏 → 生成用户模型（Goal 2）
```

---

## 1. 问题定义

当前所有 Agent 的记忆系统本质是**文件堆叠模式**——写 .md 文件、加载 MEMORY.md 索引、关键词匹配。三个月后 80% token 浪费在无关记忆上。

更根本的问题：**记忆的写入和检索被混为一谈**。文件全文注入 = "把所有菜摆上桌"，LLM 自己走过去拿 = "中断思考调 memory_search"。这不是记忆，是自助餐。

### 设计目标

1. 不丢记忆（先于省 token）
2. 检索不中断 LLM 思考流（关联预取静默注入）
3. 能在现有 Agent 上落地（Hook + MCP，不需要造新 Agent）
4. 越用越懂用户（负反馈累积 → 蒸馏规则）
5. token 不增加（至少持平，理想省 40-50%）

---

## 2. 架构总览

```
┌─────────────────────────────────────────────────┐
│                   Session 启动                    │
│  L0 蒸馏规则 (~200 tokens) + 项目上下文文件       │
│  + 检查 pending 碎片化任务                        │
└─────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│                   每轮对话                        │
│  P1: 上下文窗口（零额外 token）                   │
│  P2: 关联预取（取近3轮 embedding → 匹配 L1       │
│       碎片 → ≤150 tokens 静默注入）               │
│  P3: 显式检索（仅 P2 不够时 LLM 主动调           │
│       memory_search，80% 需求已由 P2 覆盖）       │
└─────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│              Compaction 触发                     │
│  Path A（同步）: 摘要（下个 session）+ 备份原文   │
│  Path B（异步）: 原文 → 4通道碎片化 → 去重       │
│                  → 入 L1 索引                     │
│  Path C（≥24h+≥5sessions）: 同类碎片 → 蒸馏     │
│       合并为 L0 规则 + 沙漏衰减                   │
└─────────────────────────────────────────────────┘
```

---

## 3. 四种记忆形态

| 层级 | 内容 | 体积 | 加载方式 |
|------|------|------|---------|
| **L0 蒸馏规则** | 同类反馈 ≥3 次合并的一句规则 | ~200 tokens 恒定 | 每次 session 必加载 |
| **L1 活性碎片** | 4 通道拆分，每条 ≤50 tokens | 动态 | 关联预取静默注入 |
| **L2 上下文窗口** | 本轮对话完整内容 | 不额外占 token | compaction 前实时碎片化 |
| **L3 原始记录** | 完整对话转录 + 关联日期项目设计文件 | 纯归档 | 仅 fallback 时读取 |

---

## 4. 多通道拆分（4 通道）

通道数砍到 4 个以确保 LLM 分类准确率。

| 通道 | 拆什么 | 示例 |
|------|--------|------|
| **WHAT** | 做了什么决策/动作/方案 | "CUDA 报错 → 改用 CPU 推理" |
| **FEEL** | 双源信号通道（见 §5） | 纠正权重 +80，同类碎片聚类 +90 |
| **WHO** | 涉及什么角色/人员 | 用户=管理员，模型=DeepSeek V4 |
| **WHERE** | 项目/文件/模块/技术栈 | D:\video-analysis\, Whisper, CUDA |

Bug、技术栈、设计决策等作为 WHERE 的子标签，按项目类型自动激活。

**激活逻辑：** 读取项目根目录 CLAUDE.md / AGENTS.md → 判断项目类型 → 激活对应子标签。
**Fallback：** 无 CLAUDE.md 或无法判断类型时 → 只激活基础标签（项目名/文件路径）。首次 compaction 碎片化后，根据实际碎片内容自动补激活缺失的子标签。

---

## 5. 双源信号通道（锚点核心）

决定"什么碎片未来最可能被检索"的不是信息重要性，而是**未来检索概率**。

### 源 1 — 用户行为信号

| 信号 | 权重 | 触发条件 |
|------|------|---------|
| 纠正 | +80 | 用户覆盖 Agent 假设 |
| 挫败 | +90 | 同一话题被纠正 ≥2 次 |
| 紧迫 | +50 | 时间压力关键词 |
| 忽略 | +40 | 用户跳过 Agent 建议直接给结论 |
| 确认 | +30 | 明确说"对/就这样/完美" |

### 源 2 — 内容聚类信号（主通道）

- 同一模块/报错/文件被重复触及 → 自动检测
- 3 次以上碎片 embedding 距离 < 阈值 → 权重 +90
- **不依赖用户怎么说** — 熟练提示词工程用户不受影响
- 精简 prompt 反而是最干净的信号（无感叹词干扰）

---

## 6. 写入管线

### Path A — Compaction 触发（同步）

```
原始对话 → 摘要（下个 session 用）+ 备份原文
```

### Path B — 后台异步（compaction 后立即启动）

```
备份原文 → 4 通道碎片化 → 双向关联校验 → 去重 → 入 L1 索引

关联改为双向验证：
  A linked B → B 必须 linked A → 否则标记可疑 → dreaming 时修复

时机：compaction 完成后立即启动，必须在 5 分钟内完成。
      若 Compaction 时历史轮次 >20 轮，取最后 20 轮碎片化。
      完成前 SessionStart 检查 pending 状态 → 优先完成碎片化再开放检索。
```

### Path C — Dreaming 触发（≥24h + ≥5 sessions）

```
同类碎片检测（embedding 相似 + 关联重叠 >50%）
  → ≥3 条 → 合并为 L0 蒸馏规则 → 原始碎片归档
  → ≥2 条 → 提升关联权重
  
矛盾检测（同通道但内容冲突）
  → 标记冲突 → 等下次引用来验证

沙漏衰减：
  7 天新手保护 → decay = 1.0
  7-30 天未引用 → decay = 0.7
  30-60 天未引用 → decay = 0.3
  60 天+ → 归档（移出 L1 索引）
  180 天+ + 所有关联碎片已归档 → 永久删除
```

---

## 7. 检索管线

```
P1: 上下文窗口
  零额外 token。当前 session 内已有的一切。

P2: 关联预取（静默注入）
  每轮取最后 3 轮对话 embedding
    → 匹配 L1 碎片（锚点标签 + 关联网络）
      → 取关联密度最高的 2-3 条碎片簇
        → 拼接成 ≤150 tokens 上下文块
          → 静默注入下一轮 system prompt 尾部
  LLM 无感知，不中断思考流。

P3: 显式检索
  仅 P2 不够时 LLM 主动调 memory_search
  80% 需求已被 P2 覆盖
```

---

## 8. 查错机制

### 关联计数差分信号

```
写入：每条碎片记录 linked_count = N（同时产生的关联碎片数）
检索：命中 M 条关联碎片（M ≤ N）
差值 = N - M
  = 0 → 完整
  = 1-2 → 有少量遗漏，不阻塞
  ≥ 3 → 触发补充查询："重建不完整，缺失部分可能在 [时间通道标签]"
```

### 双向关联校验

```
碎片 A 声称关联了 B → B 必须关联回 A
不对齐 → 标记可疑 → dreaming 时重新验证
```

---

## 9. 4 层备份召回

```
L1 活性碎片 → 正常检索
  ↓ fail
L1_archive → 倒排索引 fallback → reactivate 碎片
  → "这个比较久了，翻了一下记录..."
  ↓ fail
L3 原始转录 → 关键词匹配 → 现场碎片化
  → "记得不是很清楚，但在 XX 年 X 月的对话里有提到..."
  ↓ fail
关联日期的项目设计文件
  → "我查了项目文档..."
  ↓ fail
→ 诚实说"我不记得这件事，可能没有记录。"
```

---

## 10. 落地路径

### 形态：跨平台记忆插件（核心引擎 + 适配层）

```
┌──────────────────────────────────┐
│         v3 记忆引擎核心           │
│  (碎片化 / 蒸馏 / 检索 / 衰减)    │
│  纯逻辑，不依赖任何 Agent 平台     │
└──────────────┬───────────────────┘
               │
       ┌───────┴───────┐
       │   适配层       │
       │  每平台一个     │
       └───────┬───────┘
               │
    ┌──────────┼──────────┐
    │          │          │
Claude Code  Codex CLI  Generic
(hook适配)  (hook适配)  (MCP+prompt)
```

核心引擎是纯函数——接收对话 transcript，产出碎片。不碰文件系统、不调 API、不依赖 Hook。适配层负责三件事：
1. **触发时机** — Claude Code/Codex = Hook，Generic = MCP tool call + 定时心跳
2. **结果注入** — Claude Code = system prompt 追加，Generic = MCP 返回
3. **文件路径** — Claude Code = `~/.claude/`，Codex = `~/.codex/`，Generic = 用户指定

### 首次安装：批量导入历史记忆

安装后第一件事不是等新对话——是主动把用户已有的记忆文件全部碎片化。

```
安装时（后台异步）：
  1. 扫描现有记忆资产：
     - MEMORY.md
     - memory/*.md
     - transcripts/*.jsonl（如有）
     - 项目 CLAUDE.md / AGENTS.md
  2. 计算总量：
     - 总文件数 + 总大小 + 估算 token 数
  3. 告知用户：
     "发现 X 个记忆文件，共 Y MB，预计消耗 Z tokens，耗时 T 分钟。
      是否导入？[Y/n]"
  4. 用户确认 → 批量碎片化 → 入 L1 索引
  5. 完成后反馈：
     "已导入 N 条历史记忆。从现在开始，Agent 可以直接回忆起之前的内容。"
```

**用户体验：装完不是空盒子。** 批量导入让 L1 索引从第一天就有内容，P2 预取立刻生效。第一次问"上次那个 bug 怎么修的"就有答案。

### 平台适配详情

#### Claude Code / OpenClaw（原生 Hook）

| Hook | 动作 |
|------|------|
| SessionStart | 注入 L0 规则（~200 tokens）+ 检查 pending 碎片化任务 |
| UserPromptSubmit | 触发 P2 关联预取（≤150 tokens 静默注入） |
| PreCompact | 触发 Path A（摘要 + 备份原文） |
| Stop/SessionEnd | 队列化 Path B（异步碎片化）+ Path C（dreaming） |

可靠性：100%（框架强制执行）

#### Codex CLI（原生 Hook）

Hook 事件映射同上（Codex 支持 SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/PreCompact/Stop）。

#### Generic / 其他 Agent（MCP + Prompt 适配）

无 Hook 平台通过以下机制弥补：

**MCP 工具：**
- `memory_recall` — 关联预取 + 显式检索（替代 UserPromptSubmit 自动触发）
- `memory_remember` — 手动触发碎片化（替代 PreCompact 自动触发）
- `memory_search` — 显式检索 fallback
- `memory_get` — 读指定碎片/文件详情

### 调用持续性保障（Generic 平台）

Generic 平台没有框架级 Hook，调用全靠 LLM 自觉。四层保障：

```
Layer 1 — 系统提示词注入（底线）
  安装时自动追加到项目 AGENTS.md / CLAUDE.md：
  "每次对话开始前调用 memory_recall 获取相关上下文。
   每次重要决策后调用 memory_remember 记录。"

Layer 2 — 定时心跳提醒（MCP 做不到 Hook 的替代）
  Cron 定时任务周期性通过 MCP 推送：
  "[Memory] 本轮尚未调用 memory_recall，如有需要请立即调用。"
  间隔：每 10 轮或每 30 分钟

Layer 3 — 首次使用引导
  安装脚本自动在项目根目录 AGENTS.md 追加：
  "## Memory
   Session 开始：调用 memory_recall() 了解项目状态和上次进展。
   重要决策后：调用 memory_remember(decision, context) 记录。
   Bug 修复后：调用 memory_remember(bug, fix, root_cause) 记录。"

Layer 4 — 正向强化闭环
  Agent 调用 memory_recall 获得有用信息后
  → 系统追踪调用频次和结果质量
  → 提示词动态强化："最近 5 次 memory_recall 平均帮你节省了 3 轮追问。"
  → LLM 通过正向反馈自己形成调用习惯
```

### 可靠性对比

| 平台 | 触发可靠性 | 原因 |
|------|-----------|------|
| Claude Code / OpenClaw | **100%** | Hook 框架强制执行 |
| Codex CLI | **100%** | Hook 框架强制执行 |
| Generic（纯 MCP） | **~90%** | Prompt 工程 + 心跳辅助，但仍依赖 LLM 自觉 |
| Generic（MCP + Cron 注入） | **~95%** | 定时心跳强制提醒，但仍可能被 LLM 忽略 |

**坦白说：Hook 和 Prompt 之间存在不可消除的可靠性差距。** Spec 不做虚假承诺——有 Hook 的平台是 100%，没有的是尽力而为。

---

## 11. Token 预算

### 碎片化成本实测

| 对话长度 | 原文 tokens | 碎片化输出 | 压缩比 |
|---------|-----------|----------|-------|
| 10 轮 | ~200 | ~150 | 75% |
| 30 轮 | ~600 | ~250 | 42% |
| 50 轮 | ~7,000 | ~300 | **4.3%** |

### 每 session 对比

| 方案 | 组件 | 估算 |
|------|------|------|
| **当前** | MEMORY.md 注入 + memory_search 往返 | ~2,800 tokens |
| **v3** | L0 规则 + P2 预取 + 碎片化分摊 | ~1,380 tokens |
| **节省** | | **~50%** |

### 优化建议

用 Flash/Haiku 做碎片化（不需深度推理），成本可再降 80%+。

---

## 15. 与竞品差异

全套架构的 80% 零件已被独立验证（Hook 系统/混合检索/遗忘曲线/事后 consolidation），以下三点为原创：

1. **linked_count 差分信号 + 双向关联校验** — 丢了知道丢了，没有任何系统做
2. **双源信号通道（行为 + 聚类）作为首要锚点** — 所有人用时间/相关性排序，没人把"未来检索概率"作为权重核心
3. **4 层备份召回（含关联日期设计文件）** — 其他系统丢了就是丢了

---

## 13. MVP 范围

### v1.0 包含

| 模块 | 内容 |
|------|------|
| 核心引擎 | 4 通道碎片化 + 双向关联 + 去重 |
| 写入管线 | Path A（compaction 同步摘要）+ Path B（异步碎片化） |
| 检索管线 | P1（上下文）+ P2（关联预取）+ P3（显式检索） |
| 查错 | linked_count 差分信号 |
| 备份召回 | 4 层（L1 → archive → 转录 → 设计文件） |
| 适配层 | Claude Code/OpenClaw Hook + Generic MCP |
| 首次安装 | 批量导入历史记忆 + Token/时间预估 |
| 手动蒸馏 | `/dreaming` 命令触发 Path C |

### v1.1 加入

| 模块 | 内容 |
|------|------|
| Path C 自动蒸馏 | embedding 聚类 + 矛盾检测 + 自动合并 L0 规则 |
| 双向关联自动修复 | Dreaming 时自动修复不对齐的关联 |
| 正向强化闭环 | 追踪 P2 命中率 → 动态优化预取阈值 |

### 砍掉理由

Path C 自动蒸馏是写入管线里最复杂的模块（embedding 聚类、矛盾检测、合并策略）。Goal 1（不丢细节）完全由 Path A + B 覆盖。用户在完成 2-3 个项目前积累不到"同类反馈 3 次"的门槛。手动 `/dreaming` 在 v1.0 够用。

---

## 14. 已知风险与缓解

| 风险 | 等级 | 缓解 |
|------|------|------|
| 碎片化 LLM 分类不准 | 中 | 通道砍到 4 个；可切换小模型专项优化 |
| P2 关联预取质量不足 | **高** | 直接影响核心体验。需要 minScore + MMR 去重 + 实测调参 |
| 关联预取噪声（注入无关碎片） | 中 | 初始 minScore 设 0.5，根据命中反馈动态调整 |
| WHERE 通道 fallback 准确性 | 低 | 首次碎片化后自动补激活缺失子标签 |
| 首次批量导入成本超预期 | 中 | 事先预估告知用户，用户可选择跳过 |
| 异步碎片化延迟窗口 | 低 | SessionStart 检查 pending + 5 分钟超时 |
| 跨项目蒸馏引擎复杂度 | 高 | 先做单项目，跨项目放 Phase 2 |
| Generic 平台 P2 不可用（无 Hook） | 中 | 降级为 prompt 提醒 LLM 手动调 memory_recall |

---

## 16. 相关文档

- [agent-memory-system-design.md](C:\Users\Administrator\.claude\projects\C--Users-Administrator\memory\agent-memory-system-design.md) — v2 原始设计
- [agent-memory-v3-final-design.md](C:\Users\Administrator\.claude\projects\C--Users-Administrator\memory\agent-memory-v3-final-design.md) — v3 最终设计
- [2026-05-22-agent-memory-deep-dive.md](C:\Users\Administrator\.claude\projects\C--Users-Administrator\memory\2026-05-22-agent-memory-deep-dive.md) — 讨论全记录
