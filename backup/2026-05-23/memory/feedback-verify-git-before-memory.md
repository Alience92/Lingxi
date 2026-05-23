---
name: feedback-verify-git-before-memory
description: 写项目状态记忆前必须 git log 验证，不能凭计划文件推断
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bcdea4de-54c5-4149-a151-96a6a2c95ba1
---

写 `project-state.md` 等记忆时，关于"某功能是否已实施"的判断，必须以 `git log` 为准，不能凭计划文件是否存在来推断。

**Why:** 2026-05-12 上轮 session 我写记忆时，看到 `staged-crafting-hopcroft.md` 计划文件存在，就写"持久化计划待执行"。实际上 git log 里早已有完整实现 commit。今天读到错误记忆后原样复述给用户，造成混乱。

**How to apply:** 写记忆前至少执行 `git log --oneline -10`。计划文件只是意图，git 是真相。如果计划文件和 git 状态矛盾，以 git 为准并从记忆中移除计划文件引用。
