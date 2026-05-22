# GPT-5.5 跟进修复记录

> 日期：2026-05-22 | 范围：第二轮审查后立即修复

## 本次修复

1. 修复 `prefetch()` 的 MMR 惩罚方向
2. 修复 `fragmentSession()` 在零碎片结果下未清理 `pending_fragmentation` 的问题
3. 补充回归测试，覆盖上述两项行为
4. 修复 `prefetch` 污染 `recall_log` 的问题
5. 修复 `dreaming` 重复生成 L0 规则的问题

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
3. `prefetch` 不写 `recall_log`，显式搜索才写 `recall_log`

## 追加修复

### 3. 区分 prefetch 与 explicit search 的 recall 统计路径

文件：`src/core/retriever.ts`

- 为底层检索增加 `recallMode`
- `prefetch` 走静默路径，不写 `recall_log`，也不提升 `recalled_count`
- `explicitSearch` 才会记录召回日志并提升活跃度

效果：静默预取和用户主动搜索的统计口径分离，衰减与召回分析更可信。

### 4. 为 L0 蒸馏规则引入稳定去重键

文件：`src/db/schema.ts`、`src/mcp/tools.ts`

- 为 `distilled_rules` 新增 `fingerprint` 唯一键
- `dreaming` 生成规则前先查重，已有规则只补充 `rule_sources`
- 蒸馏输入按 `fragment_id` 去重，避免多 anchor 导致一条碎片被重复计数

效果：重复执行 `dreaming` 不会持续膨胀规则库，L0 更稳定。

## 建议后续继续跟进

1. 在 SessionStart 链路中真正消费 `distilled_rules`
2. 为已有数据库增加 schema migration，确保旧库自动补齐 `fingerprint` 字段
3. 为 `dreaming` 增加“规则更新”策略，而不是仅做首次插入
