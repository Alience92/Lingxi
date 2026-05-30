# 灵犀 (Lingxi) v4

> 轻、智、化 —— 三层叙事：单文件零依赖 · 自有小模型推理 · 记忆到行为的完整闭环
>
> 无限上下文时代，**策展能力**比存储能力更重要。灵犀不做第二个 EverOS，做第一个让 AI 真正认识你的系统。

灵犀是一个跨平台 Agent 记忆插件。核心差异化：**不是帮 AI 存更多，是帮 AI 筛出真正重要的，并转化为行为改变。**

---

## 与 EverOS 的定位差异

| | EverOS | 灵犀 |
|------|------|------|
| 部署 | Python + Docker × 4 服务 | TypeScript + 单文件 SQLite |
| 推理 | 全依赖云端 LLM | **自有 macbert-2stage 本地编码器** |
| 核心理念 | 存得好、取得准 | **筛得精、用得上** |
| 记忆→行为 | Agent 自行决定如何使用 | **三层注入：铁律/教训/偏好 → 直接约束行为** |
| 基准 | 93% LoCoMo (自报) | 内置探针式评测仪表板 |

---

## 架构

```
用户消息 → prefetch(检索+scope过滤) → LLM对话
              ↓
         lightweight-extractor(信号提取+correction检索)
              ↓
    /compact → PostCompact → 自动碎片化(编码器通道分类)
              ↓
         dreaming worker(后台反思)
         ├── decay(衰减+宪法保护)
         ├── distillation(多因子+单次高价值)
         ├── conflict resolution(矛盾→解决链)
         ├── pattern insight(模式洞察)
         └── self-check(自检+关怀)
              ↓
         SessionStart → 铁律/教训/偏好(含溯源) + 任务接续
```

四通道碎片化：**WHAT**(事实) + **FEEL**(情感) + **WHERE**(位置) + **WHO**(身份)
记忆作用域：project / domain / global 三级过滤

---

## 当前状态

| 指标 | 数值 |
|------|------|
| 活跃碎片 | 2,670 |
| 蒸馏 L0 规则 | 16 条 (含 priority 三级体系) |
| 编码器准确率 | macbert-2stage 80% (累计 244 条对比) |
| 通道分布 | WHAT 61% / FEEL 18% / WHERE 13% / WHO 8% |
| 运行天数 | 8 (2025-05-22 至今) |
| 数据库 | SQLite 单文件, WAL 模式, 28 个 migration |

---

## 核心机制

### 三层策展：存 → 炼 → 用

| 层级 | 机制 | 说明 |
|------|------|------|
| **存** | 四通道碎片化 + 作用域过滤 | 不只是存内容，还标注适用范围 |
| **炼** | 多因子蒸馏 + 单次高价值蒸馏 | 重复模式 + 一次纠正都值得提炼 |
| **用** | SessionStart 三层注入 + correction 检索 | 记忆直接转化为行为依据 |

### noveltyFactor — 阶梯衰减的学习节奏

系统年龄决定学习强度——前 3 天最激进，30 天后进入稳态。

| 系统年龄 | 衰减窗口 | 蒸馏门槛 | 触发信号 |
|----------|---------|---------|---------|
| 1-3 天 | ~1 天 | 1 条 | 10 条 |
| 4-7 天 | ~4 天 | 3 条 | 30 条 |
| 30+ 天 | 7 天 | 5 条 | 50 条 |

### 多因子规则权重 + Priority 体系

蒸馏出的 L0 规则通过 6 因子评分，按 priority 分为三级注入：

| Priority | 来源 | 注入区块 | 说明 |
|----------|------|---------|------|
| 0 | MEMORY.md 铁律 | 铁律约束 — 不可覆盖 | 宪法级 |
| 25 | 单次高价值纠正 | 教训规则 | 30 天试用期，未触发自动降级 |
| 50 | 跨 session 重复蒸馏 | 行为建议 | 可被高 priority 规则覆盖 |

### 记忆生命周期

```
创建(scope标记) → 检索(scope过滤+MMR) → 蒸馏(多因子+单次) → 
衰减(noveltyFactor) → 遗忘(user_delete/supersede) → 溯源(日期+session标注)
```

---

## 工程索引

| 层级 | 核心模块 | 职责 |
|------|---------|------|
| 检索 | `retriever.ts` | FTS5 MATCH + LIKE CJK + 向量 MMR + scope 过滤 |
| 提取 | `lightweight-extractor.ts` | 每条消息正则提取 8 类信号 (correction/decision/frustration/...) |
| 碎片化 | `auto-fragment.ts` | 后台 worker，增量处理 + 编码器通道分类覆盖 |
| 编码器 | `smallmodel/encoder.ts` | **macbert-2stage 本地 ONNX 推理**，零 API 成本 |
| 衰减 | `decay.ts` | noveltyFactor 自适应窗口，宪法级保护 |
| 蒸馏 | `engine.ts` | 多因子聚类 + 单次高价值事件 → priority 分级规则 |
| 冲突 | `dreaming-worker.ts` | 矛盾检测 → superseded 链 → 自动解决 |
| 执行层 | `session-start.ts` | 铁律/教训/偏好 三层注入 + 溯源标注 |
| 检索增强 | `prefetch.ts` | 记忆片段 + L0 规则 + correction 事件检索 |
| 评测 | `tools/eval-dashboard.ts` | **探针式仪表板**：命中率/覆盖率/质量分 |

---

## 设计文档

- [标签宪法](docs/label-constitution.md) — 四通道标签规范
- [关系档案 Spec](docs/relationship-profile-spec.md) — friction/autonomy/trust 状态机
- [审查教训吸收机制](design-docs/2026-05-29-review-lesson-absorption.md) — 单次高价值蒸馏设计
- [L0 规则违反事件分析](design-docs/incidents/2026-05-29-L0-rule-violation.md) — 注入架构缺陷复盘
- 更多设计文档：[GitHub docs/](https://github.com/Alience92/Lingxi/tree/master/docs)

---

## 技术栈

TypeScript + SQLite (better-sqlite3) + FTS5 + 本地 ONNX 推理 (macbert-base)

**零外部依赖**：不需要 MongoDB、Elasticsearch、Milvus、Redis。单文件部署，跨平台运行。

---

## 快速开始

```bash
git clone https://github.com/Alience92/Lingxi.git
cd Lingxi
npm install
npx tsc

# 启动 MCP server
node dist/skill/mcp/server.js

# 运行评测仪表板
npx tsx tools/eval-dashboard.ts
```

---

## License

ISC
