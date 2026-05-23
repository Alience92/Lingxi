---
name: feedback-write-design-doc-immediately
description: "讨论结果第一时间写入设计文档，不等到\"修的时候再写\""
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bcdea4de-54c5-4149-a151-96a6a2c95ba1
---

所有项目功能讨论完毕后，必须在第一时间将讨论结论写入项目 `docs/design/` 下的设计文档。

**Why:** 2026-05-20 讨论 cheat-on-content 集成时，用户提醒应该讨论完就写设计文档，而不是等所有讨论结束再批量处理。口头结论过几天就模糊了，设计文档是唯一可靠的信息载体。

**How to apply:** 每个议题讨论完毕获得用户确认后，立即写入 `docs/design/YYYY-MM-DD-<topic>.md`，然后再推进下一个议题。不要攒着"等全讨论完一起写"。
