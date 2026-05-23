---
name: feedback-ai-type-safety
description: AI 返回字段类型不可信——字符串/数组/对象混用，所有数组方法调用前必须类型守卫
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bcdea4de-54c5-4149-a151-96a6a2c95ba1
---

AI 模型（包括 DeepSeek 和 Ollama）返回的 JSON 字段类型不稳定：`contentPreference`、`painPoints` 等字段有时是字符串（`"知识科普类"`）、有时是数组（`["知识科普类"]`）、有时是单元素对象。

**Why:** Phase 3 因 `(a.contentPreference || []).join is not a function` 导致未捕获 TypeError → `handleSubmit` 崩溃 → loading 永远卡住。AI 返回字符串时 `|| []` 不过滤（字符串 truthy），直接调 `.join()` 失败。

**How to apply:** 任何对 AI 返回数据进行 `.join()`、`.slice()`、`.map()`、`.filter()` 等数组操作前，先用类型守卫确保是数组：

```typescript
function safeArr(v: any): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.length > 0 ? [v] : [];
  return [];
}
```

已修复文件：Phase1/3/4/5 的 buildPrompt 函数。
