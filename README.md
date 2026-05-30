# 灵犀 (Lingxi) v4

> Agent 记忆系统 —— 不是工具，是认识你的人。

灵犀是一个跨平台 Agent 记忆插件，让 AI 能够在多次对话中持续认识用户、积累认知、并根据关系改变行为。核心思想：**AI 的价值不在效率，在认识用户的深度。**

---

## 架构

```
用户消息 → prefetch(检索) → LLM对话
              ↓
         lightweight-extractor(轻量信号)
              ↓
    /compact → PostCompact → 自动碎片化
              ↓
         dreaming worker(后台反思)
         ├── decay(衰减)
         ├── distillation(蒸馏→L0规则)
         ├── pattern insight(模式洞察)
         ├── contradiction detection(矛盾检测)
         └── proactive care(主动关怀)
              ↓
         SessionStart → 行为约束 + 用户画像 + 任务接续
```

四通道碎片化：**WHAT**(事实) + **FEEL**(情感) + **WHERE**(位置) + **WHO**(身份)

---

## 当前状态

| 指标 | 数值 |
|------|------|
| 活跃碎片 | 2,663 |
| 温碎片（半衰减） | 453 |
| 蒸馏 L0 规则 | 16 条 |
| 已记录会话 | 122 |
| 运行天数 | 8（2025-05-22 至今） |

---

## 核心机制

### noveltyFactor — 阶梯衰减的学习节奏

系统年龄决定学习强度——前 3 天最激进（用户最敏感），30 天后进入稳态。

| 系统年龄 | 衰减窗口 | 蒸馏门槛 | 触发信号 |
|----------|---------|---------|---------|
| 1-3 天 | ~1 天 | 1 条 | 10 条 |
| 4-7 天 | ~4 天 | 3 条 | 30 条 |
| 30+ 天 | 7 天 | 5 条 | 50 条 |

### 多因子规则权重

蒸馏出的 L0 规则通过 6 因子评分，区分战略洞察和日志噪音：

- **Session 扩散**：跨 session 越多越通用
- **组大小**：更多共识证据
- **通道多样性**：跨 WHAT/FEEL/WHERE/WHO 的规则更丰富
- **WHO 身份加成**：身份认知天然高价值
- **宪法级加成**：FEEL 锚点权重 ≥80 的规则受保护不被衰减
- **FEEL 强度**：情感显著性

### 行为层

蒸馏知识不再只是数据库里的记录，通过 SessionStart 注入为实际行为指令：

- **行为约束**（≤6 条）：必须遵守的执行规则
- **用户画像**：价值观、性格、沟通风格
- **产品方向**：长期目标和架构决策

信任等级 L3 → 常规操作直接执行，仅不可逆操作前确认。

---

## 工程索引

| 层级 | 核心模块 | 职责 |
|------|---------|------|
| 检索 | `retriever.ts` | FTS5 MATCH (alpha) + LIKE (CJK) + 向量 MMR |
| 提取 | `lightweight-extractor.ts` | 每条消息正则提取 FEEL/决策/纠正/紧急信号 |
| 碎片化 | `auto-fragment.ts` | 后台 worker，增量处理已碎片化 session |
| 衰减 | `decay.ts` | novelty-adjusted 时间窗口，宪法级保护 |
| 蒸馏 | `engine.ts:runDistillation` | 标签聚类 → 多因子评分 → L0 规则 |
| 触发 | `dreaming-trigger.ts` | 三条件：信号量 / 时间 / 碎片数 |
| 反思 | `dreaming-worker.ts` | 衰减→蒸馏→别名→判据→矛盾→模式→自检→关怀 |
| 执行层 | `session-start.ts` | 信任级别 + WHO 身份 → 行为约束 + 沟通风格 |
| 检索增强 | `prefetch.ts` | 每次消息注入 L0 规则 + 相关碎片 |
| 编码器 | `smallmodel/encoder.ts` | macbert-2stage 通道分类器，影子模式运行中 |

---

## 设计文档

- [标签宪法](docs/label-constitution.md) — 四通道标签规范
- [关系档案 Spec](docs/relationship-profile-spec.md) — friction/autonomy/trust 状态机
- 更多设计文档见：[设计文档区](https://github.com/Alience92/Lingxi/tree/master/docs)

---

## 技术栈

TypeScript + SQLite (better-sqlite3) + FTS5 + 本地 ONNX 推理 (macbert-base)

跨平台：作为 Claude Code Skill/MCP Server 运行，不绑定特定 Agent 平台。

---

## 快速开始

```bash
git clone https://github.com/Alience92/Lingxi.git
cd Lingxi
npm install
npx tsc

# 启动 MCP server（连接 Claude Code 或其他 Agent）
node dist/skill/mcp/server.js
```

配置：在 Claude Code 的 `settings.json` 中注册为 MCP server，hooks 自动激活。

---

## License

ISC
