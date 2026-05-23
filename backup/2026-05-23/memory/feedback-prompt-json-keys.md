---
name: feedback-prompt-json-keys
description: Prompt 输出的 JSON key 必须与报告组件读取的 key 对齐，否则数据静默丢失
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bcdea4de-54c5-4149-a151-96a6a2c95ba1
---

修改 System Prompt 中的 JSON 输出结构时，必须同步检查对应的报告组件（`PhaseNReport.tsx`）读取的 key 名称。

**Why:** Phase 5 的 4 个 Prompt 输出的 JSON key（`frameworks`、`hooks`、`ctas`、`fullScript`）与 Phase5Report 期望的 key（`scriptFrameworks`、`openingTemplates`、`ctaTemplates`、`scriptExamples`）不一致 → `data.scriptFrameworks || []` 总是命中 `|| []` → 报告显示空列表，推理链却正常（因为推理链 key 没变）。问题静默，无报错。

**How to apply:** 每次修改 Prompt 的 JSON 输出 schema 时：
1. 搜索对应 Phase 的 report 组件中 `data.XXX` 引用
2. 确保 Prompt key 与 report key 完全一致
3. 验证 `safe` 对象的字段映射（Phase5 的 `merged.scriptFrameworks` 等）

已修复文件：Phase5/prompts.ts（4 个 Prompt JSON key 对齐）。
