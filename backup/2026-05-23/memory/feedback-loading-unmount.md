---
name: feedback-loading-unmount
description: React 早期 return 导致输入组件卸载丢失表单状态 — loading 时用 display:none 代替 return 卸载
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bcdea4de-54c5-4149-a151-96a6a2c95ba1
---

**规则**：任何 loading 或 error 状态都不能使用早期 `if (loading) return (...)` 或 `if (error) return (...)` 模式来显示进度/错误画面。

**Why**：早期 return 会让 React 卸载所有未渲染的组件（包括输入表单），其内部 `useState` 状态随之销毁。当 loading 结束或用户点击"返回重试"后组件重新挂载，所有用户已填写的表单内容消失。这表现为「中断推理后对话框内容清空」、「分析失败后返回重试输入内容清空」。

**How to apply**：将 loading 和 error 从早期 return 改为条件渲染。保持输入/报告组件始终挂载，用 `display: none` 隐藏而非卸载。

```tsx
// ❌ 会导致表单状态丢失
if (loading) return <LoadingScreen />;
if (error) return <ErrorView onRetry={() => { setError(null); setStep('input'); }} />;
return <Input />;

// ✅ 表单状态保留
return (
  <>
    {error && <Alert type="error" message={error} />}
    <div style={{ display: (loading || error) ? 'none' : 'block' }}>
      <Input />
    </div>
    {loading && <LoadingScreen />}
    {error && <a onClick={() => { setError(null); setStep('input'); }}>返回重试</a>}
  </>
);
```

**相关记忆**：[[project-state]]

**首次引入**：2026-05-14 中断推理按键功能。Phase 1-7 全部从早期 return 改为条件渲染，TS 0 错误。
