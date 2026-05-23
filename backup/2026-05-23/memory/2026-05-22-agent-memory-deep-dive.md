---
name: 2026-05-22-agent-memory-deep-dive
description: 2026-05-22 Agent记忆系统深度讨论：四家对标、自助餐模式批判、写入vs检索分离、关联预取+分级压缩方案
metadata: 
  node_type: memory
  type: project
  originSessionId: 3b14b975-b507-4801-906b-1da57b1fd1ba
---

## 背景

在 agent-memory-system-design.md 基础上深入讨论。用户有两套记忆设计经验：
1. OpenClaw 时代（D:\记忆系统\）：文件+纪律+流程，防丢失驱动
2. 当前设计：蒸馏引擎+引用验证+沙漏活性，面向"越用越轻"

讨论目标是理清"Agent记忆究竟应该是什么样"。

## 四家主流Agent记忆系统对标

| 维度 | Claude Code | Codex | OpenClaw | Hermes |
|------|-------------|-------|----------|--------|
| 存储 | Markdown文件 | SQLite | Markdown+SQLite索引 | Markdown+向量DB |
| 检索 | LLM判文件名 | 关键字搜索 | BM25+向量混合 | FTS5+向量混合 |
| 索引上限 | 200行硬截断 | 无硬限制 | 无硬限制 | 2,200/1,375字符 |
| 衰减 | Auto Dream(≥24h) | usage_count降权 | 六维评分门控 | Ebbinghaus曲线 |
| 反思 | Auto Dream | Consolidation | Dreaming三阶段 | Nudge Engine |

**共同短板：**
- 没有人做蒸馏合并（同类反馈→规则）
- 衰减都用时间，不用引用频率
- 没有"这条记忆真的帮到后续session了吗"的验证闭环
- 大厂没动力做好（省token=省收入）

## OpenClaw实际工作流水线

读源码确认的完整流程：

**Session启动** → MEMORY.md全文注入system prompt（非搜索、非向量匹配）→ warmSession建SQLite索引

**每轮对话** → system prompt含"遇到X情况要先search"指引 → LLM自己判断要不要调memory_search → hybrid search(vector+FTS5) → 返回结果给LLM → LLM自主决定要不要调memory_get读详情

**接近compaction** → token≥4000或transcript≥2MB → Memory Flush → LLM自主总结并写入memory/YYYY-MM-DD.md

**后台Dreaming** → Light Sleep(Jaccard去重) → REM(主题反射) → Deep(六维加权, score≥0.80晋升MEMORY.md)

## 自助餐模式批判

四个问题：
1. **菜单固定** — MEMORY.md全文注入，80%无关内容白烧token
2. **得自己走过去拿** — LLM中断思考调memory_search
3. **厨师在不在时做饭** — Flush/Dreaming异步延迟，今天的记忆今天的对话吃不到
4. **没人清理剩菜** — 200行硬截断，旧记忆静默消失不是主动遗忘

## 为什么没人做仿生记忆

不是失败，是Transformer架构数学特性决定的：
- 局部Hebbian学习 vs 全局反向传播 — 基底不同
- 灾难性遗忘：微调新数据会覆盖旧能力
- 无原生遗忘机制：要么全记要么全丢
- "Unable to Forget"论文：所有LLM在信息更新+干扰下准确率跌至0%

现有研究（Titan/TTT/Kairos/ADM）都在实验室，没进生产。

**哈佛实证：存所有经验比不用记忆更差。** 错误记忆形成传播循环。

用户设计（沙漏/引用/蒸馏）的本质：用外部规则模拟神经元本应自己做的事——不是替代，是代偿。

## 核心突破：写入≠检索

两个独立问题被混在一起讨论：

**写入端（已有设计）：**
- 蒸馏引擎 = 新皮质慢速巩固
- 引用验证 = 突触可塑性（用进废退）
- 沙漏衰减 = 预测性遗忘
- 作用：决定"记什么、忘什么"

**检索端（本次新增）：**
- 关联预取 = 扩散激活 — 记忆追着对话走，不靠LLM主动搜
- 分级压缩 = 要旨提取
  - L0 关键词触发词(5-10 tokens/条)始终在context
  - L1 压缩摘要(30-50 tokens/条)方向匹配时自动注入
  - L2 完整原文仅明确需要时读取

节省token的方式：不是优化搜索，是**消除搜索**——
让记忆像人脑一样被上下文自然唤醒，不中断、不额外消耗token。

## 关键文件

- [agent-memory-system-design.md](agent-memory-system-design.md) — 整体设计文档
- [2026-05-21-2.0-knowledge-architecture](2026-05-21-2.0-knowledge-architecture.md) — 2.0知识库架构
- D:\记忆系统\ — OpenClaw时代记忆系统设计
