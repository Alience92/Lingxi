# AgentMemory (MEM-SYM)

跨平台 Agent 记忆插件 — 为 Claude Code / Codex / 通用 MCP Agent 提供持久化、碎片化、可衰减的跨会话记忆系统。

**核心理念**：记忆系统不是文件系统，是数据库。Agent 应该"越用越懂你，越用越轻"。

---

## 为什么需要 AgentMemory

当前 Agent 的记忆系统本质是"文件堆叠模式"：每次 session 写 `.md` 文件，下次打开加载 `MEMORY.md` 全文注入。三个月后 200+ 行索引，80% token 浪费在无关记忆上。

AgentMemory 采用**数据库模式**：用户意图 → embedding 语义搜索 → 只加载最相关的 3-5 条碎片。无关记忆永远不被加载。

### 架构差异化

| 能力 | AgentMemory | 其他方案 |
|------|------------|---------|
| 多通道碎片化 (4 通道) | WHAT / FEEL / WHO / WHERE 拆分 | 无通道，统一摘要 |
| 双源信号锚点 | 行为信号 + 内容聚类 | 仅时间/频率排序 |
| 关联预取 (P2) | 每轮静默注入 ≤150 tokens | LLM 手动搜索 |
| 4 层备份召回 | L1 活性 → archive → 转录 → 项目文件 | 单层检索 |
| 查错机制 | linked_count 差分 + 双向关联校验 | 无 |
| 沙漏衰减 | 7 天保护 → 30 天 0.7 → 60 天 0.3 → 归档 | 单一时间衰减 |
| L0 蒸馏 | ≥3 次同类反馈合并为一条规则 | 无蒸馏 |

---

## 快速开始

### 1. 安装

```bash
git clone https://github.com/Alience92/MEM-SYM.git agentmemory
cd agentmemory
npm install
npm run build
```

### 2. 配置

设置环境变量（至少需要一个 API key）：

```bash
# API key（用于 LLM 碎片化 + embedding）
export AGENTMEMORY_API_KEY="your-api-key"

# Embedding API 地址（可选，默认 DeepSeek）
export AGENTMEMORY_EMBEDDING_URL="https://api.deepseek.com"
```

支持的 Embedding 提供者：
- **OpenAI 兼容 API**：任意 `/v1/embeddings` 端点（默认 `text-embedding-3-small`）
- **MiniMax**：`https://api.minimax.chat/v1?GroupId=xxx`（模型 `embo-01`，1536 维）
- 无 API key 时自动降级为 n-gram hash fallback（1536 维，语义质量较低但不崩溃）

### 3. 运行 MCP Server

```bash
node dist/index.js
```

或在 Claude Code / Codex 的 MCP 配置中：

```json
{
  "mcpServers": {
    "agentmemory": {
      "command": "node",
      "args": ["/path/to/agentmemory/dist/index.js"],
      "env": {
        "AGENTMEMORY_API_KEY": "your-key",
        "AGENTMEMORY_EMBEDDING_URL": "https://api.deepseek.com"
      }
    }
  }
}
```

### 4. Claude Code Hook 集成（可选）

在 Claude Code 配置中添加 Hook，实现自动预取和记忆保存：

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "", "command": "node /path/to/agentmemory/dist/hooks/session-start.js" }
    ],
    "UserPromptSubmit": [
      { "matcher": "", "command": "node /path/to/agentmemory/dist/hooks/prefetch.js" }
    ]
  }
}
```

---

## MCP 工具

| 工具 | 用途 | 必填参数 |
|------|------|---------|
| `memory_recall` | 获取相关记忆（无 query 时返回最近 10 条） | `projectId`, `workspaceDir` |
| `memory_remember` | 保存对话片段，自动碎片化 | `transcript`, `sessionId`, `projectId` |
| `memory_search` | 显式语义搜索 | `query`, `projectId` |
| `memory_get` | 读取指定碎片及其关联 | `fragmentId` |
| `memory_store` | 存储预碎片化的数据（无 API key 时用） | `fragments`, `sessionId`, `projectId` |
| `memory_recall_deep` | 4 层深度召回（含 archive/转录/文件） | `query`, `projectId`, `workspaceDir` |
| `dreaming` | 手动触发衰减清理 + 蒸馏 | `projectId` |
| `memory_bootstrap` | 首次运行：扫描并导入已有记忆文件 | `workspaceDir`, `projectId` |

---

## 核心概念

### 四种记忆形态

```
L0 蒸馏规则  → 每次 session 必加载（~200 tokens 恒定）
L1 活性碎片  → 关联预取静默注入（≤150 tokens/轮）
L2 上下文窗口 → 当前 session 完整对话（不占额外 token）
L3 原始记录   → 纯归档，仅 fallback 时读取
```

### 多通道碎片化 (4 通道)

当调用 `memory_remember` 保存对话时，LLM 将内容拆分为 4 个通道的碎片：

| 通道 | 内容 | 适用场景 |
|------|------|---------|
| **WHAT** | 决策 / 动作 / 方案 | 所有项目 |
| **FEEL** | 双源信号（用户纠正、紧迫、挫败等） | 所有项目 |
| **WHO** | 互动角色 / 人物 | 所有项目 |
| **WHERE** | 项目 / 文件 / 技术栈 / 上下文 | 所有项目 |

### 双源信号通道

FEEL 通道的权重来自两个独立来源：

**源 1 — 行为信号**（正则匹配用户消息）：
- 纠正 → +80
- 挫败 → +90
- 紧迫 → +50
- 忽略建议 → +40
- 确认 → +30

**源 2 — 内容聚类**（embedding 相似度）：
- 同一话题 2 次出现 → +60
- 同一话题 3+ 次出现 → +90

最终 FEEL 权重 = max(行为信号, 聚类信号, 10)

### 沙漏衰减

| 时间 | 衰减分 | 状态 |
|------|--------|------|
| 0-7 天 | 1.0 | 新手保护 |
| 7-30 天 | 0.7 | 正常 |
| 30-60 天 | 0.3 | 衰退 |
| 60-180 天 | 0 | 归档 |
| 180 天+ | — | 删除 |

每次被召回 → 衰减重置为 1.0（用进废退）

### 4 层备份召回

```
L1 活性碎片（向量搜索）
  ↓ 无结果
L1_archive（FTS5 倒排索引，重新激活）
  ↓ 无结果
L3 原始转录（.jsonl 文件 substring 匹配）
  ↓ 无结果
L4 项目设计文件（按日期关联的 .md 文档）
  ↓ 无结果
→ 诚实回答"我不记得"
```

---

## 项目结构

```
agentmemory/
├── src/
│   ├── index.ts              # 入口：启动 MCP Server
│   ├── types.ts              # 类型定义
│   ├── core/
│   │   ├── engine.ts         # 主引擎：碎片化 / 衰减 / 蒸馏
│   │   ├── fragmenter.ts     # LLM 碎片化（OpenAI 兼容 API）
│   │   ├── retriever.ts      # 向量搜索 + 预取 + MMR 多样性
│   │   ├── embedder.ts       # Embedding（MiniMax / OpenAI / hash fallback）
│   │   ├── decay.ts          # 沙漏衰减算法
│   │   ├── signal-channel.ts # 行为信号 + 内容聚类
│   │   └── backup-recall.ts  # 4 层备份召回
│   ├── db/
│   │   ├── schema.ts         # SQLite 表结构 + FTS5
│   │   ├── connection.ts     # 数据库连接管理
│   │   └── repository.ts     # CRUD 操作（含事务 + FTS 同步）
│   ├── mcp/
│   │   ├── server.ts         # MCP Server（8 个工具）
│   │   ├── tools.ts          # 工具处理器
│   │   └── install.ts        # Bootstrap 扫描 / 导入 / AGENTS.md 注入
│   ├── hooks/
│   │   ├── session-start.ts  # SessionStart Hook（加载 L0 规则）
│   │   └── prefetch.ts       # UserPromptSubmit Hook（静默预取）
│   └── adapters/
│       ├── claude-code.ts    # Claude Code Hook 配置生成
│       └── generic.ts        # 通用 Adapter（心跳提醒 / 系统提示）
├── tests/
│   └── integration.test.ts   # 23 条集成测试
├── design-docs/              # 设计文档（从 v1 到 v3 的迭代）
├── docs/superpowers/         # 规范文档
├── import_bootstrap.mjs      # 批量导入脚本
├── scan_bootstrap.mjs        # 扫描预览脚本
├── package.json
└── tsconfig.json
```

---

## 测试

```bash
npm run test        # 运行全部集成测试（23 条）
npm run typecheck   # TypeScript 类型检查
npm run build       # 编译到 dist/
```

测试覆盖：
- Prompt 构建与碎片化解析
- 行为信号检测（纠正、挫败、紧迫等）
- 衰减算法（保护期、归档、删除）
- Embedding 余弦相似度
- 数据库 Schema + FTS5
- 引擎衰减 + 碎片化状态机
- Prefetch MMR 多样性
- 前向链接持久化
- Archive 召回 / Transcript 召回 / Design 文件召回
- L0 蒸馏合并（≥3 条）
- Generic Adapter 心跳 / 强化逻辑

---

## 设计文档

完整设计从 `design-docs/` 目录可追溯：

- [v1 整体设计](design-docs/agent-memory-system-design.md) — 问题根因、三种记忆形态、生命周期
- [v2 深度讨论](design-docs/2026-05-22-agent-memory-deep-dive.md) — 四家竞品对标、写入≠检索、关联预取
- [v3 最终设计](design-docs/agent-memory-v3-final-design.md) — 完整架构、落地路径、差异化分析

---

## 未实现 / 路线图

| 功能 | 状态 |
|------|------|
| Codex 适配器 | 未实现 |
| OpenClaw 适配器 | 未实现 |
| 关联双向验证 | 设计已定，代码未实现 |
| 矛盾检测（冲突记忆标记） | 设计已定，代码未实现 |
| 自动 cron 调度（Path C dreaming） | 未实现 |
| CI/CD | 未实现 |
| 真实 embedding 质量基准测试 | 未实现 |
| Token 成本实测工具 | 未实现 |

---

## 开发

```bash
npm install
npm run build        # 编译到 dist/
npm run test         # 运行测试
npm run typecheck    # 类型检查
```

数据库默认存储在 `~/.agentmemory/memory.db`，可通过 `AGENTMEMORY_HOME` 环境变量修改。

---

## License

ISC
