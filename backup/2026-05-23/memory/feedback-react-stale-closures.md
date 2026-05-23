---
name: feedback-react-stale-closures
description: React useState 在异步函数中的闭包陷阱——setState 不会立即更新变量
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bcdea4de-54c5-4149-a151-96a6a2c95ba1
---

async handler 内 `setXxx(val)` 不会立即更新 `xxx` 变量——那是一个 async 状态更新，当前闭包里的 `xxx` 仍然是旧值。如果在同一个 handler 后续代码中读取 `xxx`（例如写入报告元数据），读到的是 stale value（通常是初始值）。

**Why:** Phase 1/4 的 `_searchMeta.resultCount` 一直为 0，但 `searchWeb` 实际上搜到了 5 条结果。原因是 `handleSubmit` 开头调用 `setSearchCount(0)` 和 `setSearchCount(5)` 只是 React 状态调度，后续用 `searchCount`（stale 0）构建 `_searchMeta`，导致 Alert 显示"未使用网络搜索"，但 references 里有 AI 标注为 `web_search` 的条目。

**How to apply:** 在 async handler 中需要"异步获取的值在同一个 closure 内后续使用"时，用局部变量（`let foundCount = 0`）而非 React state variable。React state 只用于 UI 渲染（loading screen），局部变量用于需要在同一个 handler 后续使用的值（报告元数据）。

**Affected files (fixed):** `src/phases/Phase1/index.tsx`, `src/phases/Phase4/index.tsx`
