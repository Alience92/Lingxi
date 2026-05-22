# GPT-5.5 代码审查 — AgentMemory v3 MVP

> 日期：2026-05-22 | 审查范围：完整代码库 + 设计 Spec

## 整体评价

设计方向有强产品感，核心思路清晰。当前代码更像"验证几个局部想法的原型"。最值得优先修的是召回正确性和写入闭环。

## 高优先级（5项）

1. **FTS SQL UUID/rowid 混用** — `backup-recall.ts:29-34`，归档碎片很难命中
2. **memory_store 不写 FTS** — `tools.ts:69-84`，prompt模式写入不可搜
3. **Path A/B 未拆分** — `engine.ts:16-24`，token重复消耗
4. **linked_count 不反映真实命中** — `retriever.ts:71-83`，"丢了知道丢了"不可信
5. **dreaming 无蒸馏** — `tools.ts:108-116`，L0蒸馏规则无生产链路

## 中优先级（4项）

6. P2预取简化过度 — 无anchor权重、无碎片簇、无MMR、预算单位错误
7. Hook走explicitSearch而非prefetch — 两套逻辑难以统一调参
8. pending_fragmentation 僵尸字段 — 只写0，补偿执行未落地
9. L3/L4 只做子串匹配 — 缺少现场碎片化和日期关联

## 低优先级（4项）

10. runDecay删除缺少FTS同步
11. hash嵌入应标为baseline placeholder
12. 测试覆盖偏窄
13. token节省声称需补测量方法

## 建议修改顺序

1. 修存储闭环（统一持久化、FTS同步、archive SQL）
2. 修检索正确性（missingLinks、双向校验、hook统一）
3. 拆职责（摘要/碎片化/存储/适配层）
4. 补dreaming和L0（手动蒸馏、SessionStart规则加载）
