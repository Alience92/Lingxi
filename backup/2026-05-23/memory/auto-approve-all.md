---
name: auto-approve-all
description: 所有操作无需审批，直接执行
type: feedback
originSessionId: bcdea4de-54c5-4149-a151-96a6a2c95ba1
---

⚠️ 对话沟通层面已被 [[feedback-ask-before-acting]] 约束（2026-05-15）：动手前需先在对话中问清细节。

~~所有操作无需手动审批，直接执行。~~

~~**Why:** 用户明确授权。~~

**How to apply:** 三重保障已在 2026-05-11 配置完成：

1. `~/.claude/settings.json` 中：
   - `permissions.defaultMode: "bypassPermissions"` — 跳过权限检查
   - `skipDangerousModePermissionPrompt: true` — 跳过危险模式提示
   - `skipAutoPermissionPrompt: true` — 跳过自动权限提示
   - `permissions.allow` 首行加 `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `Skill`, `Agent` 通配符规则

2. `~/.claude/settings.local.json` 中同步配置了以上所有三项。

3. 项目级 `.claude/settings.json` 不存在，不会覆盖全局设置。

如果未来审批再次出现，检查：
- 是否有 `disableBypassPermissionsMode: "disable"` 被设置（策略/管理配置可能注入）
- settings.json JSON 语法是否被破坏（一个语法错误会导致整个文件失效）
- 是否有新的 settings.local.json 覆盖了 `defaultMode`
