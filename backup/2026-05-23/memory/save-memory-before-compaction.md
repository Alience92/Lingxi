---
name: save-memory-before-compaction
description: 每次上下文压缩前必须主动保存记忆
type: feedback
originSessionId: bcdea4de-54c5-4149-a151-96a6a2c95ba1
---
每完成一个功能改动或收到重要反馈后，立即更新记忆文件，不等压缩。

**Why:** 上下文压缩是系统自动触发的，无法预测时机。等压缩发生时才保存已经来不及。上次 P0+P1 合并改造在自动压缩前没保存，导致新 context 丢失进度。

**How to apply:**
1. 功能开发完成后立即更新 project-state.md 和 product-vision.md
2. 收到新用户偏好/反馈/决策后立即写入对应的 feedback 或 user memory
3. 不要等到"会话快结束了"或"压缩前"——这些节点不可预测
4. 提交代码的同时也提交记忆更新，把两者绑定为同一节奏
