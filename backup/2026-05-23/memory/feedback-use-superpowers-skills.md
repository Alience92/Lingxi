---
name: feedback-use-superpowers-skills
description: 重大工作必须走 superpowers 流程：brainstorming → writing-plans → subagent-driven-development
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bcdea4de-54c5-4149-a151-96a6a2c95ba1
---

所有重大工作（新功能、系统重构、跨文件改动）必须按 superpowers 流程执行。

**Why:** 多次出现"讨论→直接写代码→直接提交"的随意流程。没有计划、没有拆解、没有 review。用 superpowers 技能可以：brainstorm 确认设计 → writing-plans 拆成 bite-size 任务 → subagent-driven-development 逐项执行+review。

**How to apply:**
- 新功能讨论 → 用 `superpowers:brainstorming`
- 确认设计后写实施计划 → 用 `superpowers:writing-plans`
- 执行计划 → 用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans`
- 简单单文件修复可以跳过，但任何涉及 3+ 文件的改动必须走完整流程
