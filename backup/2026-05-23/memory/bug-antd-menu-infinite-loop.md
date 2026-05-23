---
name: bug-antd-menu-infinite-loop
description: Ant Design Menu items prop+useMemo 在 React 19+Zustand 5 下触发无限重渲染的已知 bug
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bcdea4de-54c5-4149-a151-96a6a2c95ba1
---

**症状**：页面白屏，控制台报 `Maximum update depth exceeded`。

**根因**：Ant Design `Menu` 组件的 `items` prop 配合 `useMemo` 可能在 React 19 + Zustand 5 环境下触发无限循环。即使 `useMemo` 返回稳定引用，Menu 内部的 state 更新也会触发父组件 re-render，形成调用链。

**排查过程**：
1. 移除 Zustand 订阅 → 仍循环
2. 移除 useMemo → 仍循环
3. 移除 Ant Design Menu（换纯 div）→ 解决
4. 确认根因在最简 Menu 组件本身

**修复方案**：用纯 div + onClick 替代 Ant Design Menu。功能完全等价，无动画但稳定。

**影响版本**：React 19 + Ant Design 5.29 + Zustand 5 + Vite 6。

**Why:** 2026-05-18 修复 1.0 白屏时定位，耗时约 30 轮调试。
**How to apply:** 遇到白屏+无限循环时，先注释掉 Ant Design Menu 排查。
