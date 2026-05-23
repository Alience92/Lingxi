---
name: feedback-model-choice-design
description: DeepSeek模型做设计审美差，涉及视觉/字体/配色/空间比例时切Claude Opus或Sonnet
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bcdea4de-54c5-4149-a151-96a6a2c95ba1
---

**Why:** DeepSeek v4 在设计任务（字体审美、空间比例、色彩感知、装饰元素判断）上能力显著弱于 Claude 系列。此 session 八轮 UI mockup 都没达到用户原版设计的水平，部分原因是模型对视觉细节的判断力不足。

**How to apply:**
- 涉及 UI 设计、视觉审美、字体选择、配色方案时 → `/model opus`（最强设计审美）或 `/model sonnet`
- 纯代码逻辑、数据结构、API 对接等任务 → 当前模型就可以
- 如果 session 中频繁在设计和非设计任务间切换，先集中做设计（切 Opus），完成后切回做实现
