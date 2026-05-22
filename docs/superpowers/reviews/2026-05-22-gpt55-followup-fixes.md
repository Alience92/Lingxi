# GPT-5.5 跟进修复记录

> 日期：2026-05-22 | 范围：第二轮审查后立即修复

## 本次修复

1. 修复 `prefetch()` 的 MMR 惩罚方向
2. 修复 `fragmentSession()` 在零碎片结果下未清理 `pending_fragmentation` 的问题
3. 补充回归测试，覆盖上述两项行为

## 代码变更

### 1. MMR 多样性惩罚修正

文件：`src/core/retriever.ts`

- 之前使用 `1 - cosineSimilarity(...)` 作为相似度
- 该实现会对低相似候选施加更高惩罚，导致预取结果偏向重复内容
- 现已改为直接使用 `cosineSimilarity(...)` 计算相似度

效果：高相似碎片会被正确降权，P2 预取更符合“保留相关性，同时保留多样性”的目标。

### 2. pending 状态清理修正

文件：`src/core/engine.ts`

- `compactSession()` 会将 `pending_fragmentation` 置为 `1`
- 之前 `fragmentSession()` 在碎片化结果为空时直接返回，session 会永久停留在 pending 状态
- 现已在零碎片返回路径中补充 `pending_fragmentation = 0`

效果：测试模式、空结果和异常边界下不会再产生 pending 僵尸 session。

## 新增测试

文件：`tests/integration.test.ts`

新增两条测试：

1. `fragmentSession` 在零碎片返回时会清理 pending 标志
2. `prefetch` 在重复候选和多样候选同时存在时，会保留多样结果并压制重复结果

## 建议后续继续跟进

1. 区分 `prefetch` 与 `explicit search` 的 recall 统计路径，避免静默预取污染召回日志
2. 为 `dreaming` 的 L0 蒸馏增加去重键，避免重复生成规则
3. 在 SessionStart 链路中真正消费 `distilled_rules`
