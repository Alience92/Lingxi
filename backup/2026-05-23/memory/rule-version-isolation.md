---
name: rule-version-isolation
description: 1.0/2.0 严格版本隔离规则，禁止跨分支复制文件
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bcdea4de-54c5-4149-a151-96a6a2c95ba1
---

## 核心规则

**禁止跨分支复制整个文件。** 每个版本各改各的，只用精确的 Edit 修改。

## 错误示例

```
❌ cp worktree-a/src/App.tsx worktree-b/src/App.tsx  → 覆写了 2.0 的 App，Phase 0 消失
❌ cp worktree-a/src/services/api.ts worktree-b/...   → 2.0 API 被 1.0 覆盖
❌ git stash apply — 混合了 2.0 的改动到 1.0
```

## 正确做法

```
✅ 在 worktree-a 里用 Edit 工具精确改某几行
✅ 在 worktree-b 里独立修改，不依赖文件复制
✅ 共享代码（如 search_service.py）在各自 worktree 里独立实施
```

## 分支对应

- `.worktrees/mvp-phase0-1` → `feat/mvp-1.0` ← 1.0 工作树
- `.worktrees/mvp-2.0` → `feat/mvp-2.0` ← 2.0 工作树

**Why:** 2026-05-18 因跨分支复制文件导致 2.0 App.tsx/Sidebar 被 1.0 覆盖，Phase 0 路由消失、Sidebar 无限循环、设置页丢失。修复耗时约 2 小时。
**How to apply:** 永远不在两个 worktree 之间 cp 文件。每次改动前确认当前 worktree 属于哪个分支。
