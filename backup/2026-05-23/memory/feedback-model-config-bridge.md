---
name: feedback-model-config-bridge
description: 浏览器 dev 模式下前端不读 SQLite，需后端端点桥接模型配置
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bcdea4de-54c5-4149-a151-96a6a2c95ba1
---

**规则：** 浏览器 dev 模式下前端 modelStore 初始化不读 SQLite，只读 localStorage。如果 localStorage 有过期配置会导致 API 调用失败。修复需添加后端端点从 SQLite 读取配置，前端 initConfigs() 调用此端点同步。

**Why:** 浏览器 dev 模式没有 `window.electronAPI`，无法调用 Electron IPC 读 SQLite。localStorage 里的旧配置会静默覆盖默认值。MiniMax 免费 API Key 仅支持 image-01 图片生成，不支持任何文本模型。

**How to apply:** 每次新增/修改模型配置时，确保后端 `/api/infer/config/models` 返回的配置是正确的最新值。前端 `modelStore.initConfigs()` 在 dev 模式下自动拉取并写回 localStorage。
