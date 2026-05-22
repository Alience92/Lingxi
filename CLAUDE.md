# AgentMemory

Agent 记忆插件 — 跨平台、多通道碎片化记忆系统。

## 北极星三阶段

1. **Goal 1**: 项目完成前细节不会忘，项目完成后提取关键成长信息
2. **Goal 2**: Agent 越来越懂用户习惯，主动推荐
3. **Goal 3**: Agent 预测用户行为逻辑，直接击中内心的方案

## 核心文件

- Spec: `docs/superpowers/specs/2026-05-22-agent-memory-v3-design.md`
- 设计文档: `design-docs/agent-memory-v3-final-design.md`
- 讨论记录: `design-docs/2026-05-22-agent-memory-deep-dive.md`
- v2 原版: `design-docs/agent-memory-system-design.md`

## 技术方向

- 跨平台适配层（Claude Code Hook / Codex Hook / Generic MCP）
- 核心引擎纯逻辑，不依赖任何 Agent 平台
- 4 通道碎片化（WHAT/FEEL/WHO/WHERE）
- 双源信号锚点（行为信号 + 内容聚类）
- 4 层备份召回（L1 → archive → 转录 → 设计文件）
