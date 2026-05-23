---
name: feedback-persistence-pitfalls
description: Electron 持久化相关的两个已知陷阱和修复经验
type: feedback
originSessionId: bcdea4de-54c5-4149-a151-96a6a2c95ba1
---
## 规则 1：修改 electron/main.ts 后必须重编译

修改 `electron/main.ts`（Schema 迁移、IPC handler 等）后，必须运行 `npx tsc -p tsconfig.node.json` 重新生成 `dist-electron/electron/main.js`，否则 Electron 运行时仍使用旧的编译产物。

**Why:** `dist-electron/` 在 .gitignore 中，不会随源码一起提交。且 `npm run dev`（纯 Vite）不触发 electron 编译，容易遗忘。

**How to apply:** 对 `electron/` 目录的任何修改完成后，立即运行 `npx tsc -p tsconfig.node.json`。

## 规则 2：localStorage 替换数组元素时要写回数组

Zustand store 的 browser fallback 路径中，常见 bug 是创建了 `updated` 对象但忘记放回数组：

```typescript
// BUG: updated 对象创建了但没写回 projects
const updated = { ...projects[idx], ...newFields };
localStorage.setItem('key', JSON.stringify(projects)); // 保存的是旧数组

// FIX: 直接修改数组元素
projects[idx] = { ...projects[idx], ...newFields };
localStorage.setItem('key', JSON.stringify(projects));
```

**Why:** `localStorage.setItem` 不会自动合并 —— 你序列化什么它就存什么。

**How to apply:** 任何通过 `loadProjects()` → 修改 → `setItem('db_projects', ...)` 的路径，确认修改后的对象确实在数组中。
