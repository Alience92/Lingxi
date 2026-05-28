# 灵犀辅助开发机 — 环境搭建 + P0 任务

## 环境准备

```bash
# 1. Clone
git clone <repo-url> && cd Lingxi-v4 && git checkout feat/v4-refactor

# 2. 安装依赖
npm install

# 3. 解压开发 DB
gzip -d tools/dev-snapshot/memory.db.gz
mkdir -p ~/.agentmemory/
cp tools/dev-snapshot/memory.db ~/.agentmemory/memory.db

# 4. 验证
npx tsc --noEmit
node -e "require('better-sqlite3')('./.agentmemory/memory.db', {readonly:true}).prepare('SELECT count(*) FROM fragments').get()"
# 预期: 1855

# 5. Python 训练环境（如需重训 encoder）
pip install torch numpy transformers scikit-learn modelscope onnx onnxruntime
```

---

## P0 任务（两周窗口）

### 1. retrieval_state / asset_state 分层

**文件**: `src/db/schema.ts`, `src/core/retriever.ts`, `src/core/decay.ts`

新增两个字段到 fragments 表：
```
retrieval_state: active | warm | archived | cold  （系统管理，自动流转）
asset_state: retained | exportable | user_deleted  （用户管理，用户主动操作）
```

规则：
- 系统只改 retrieval_state，用户操作才改 asset_state
- decay → retrieval_state 流转（active→warm→archived→cold）
- 用户删除 → asset_state = user_deleted，被标记但不物理删除
- 检索时：跳过 cold（除非显式查询 archived）+ 跳过 user_deleted
- 解决「系统自己删用户记忆」的心智冲突

### 2. 低置信度 fallback

**文件**: `src/smallmodel/encoder.ts` + 新增文件

- encoder classify() 返回 confidence < 0.6 时，不直接采纳结果
- 路由到 LLM few-shot（用 5 条边界样本做 prompt）做二次判断
- LLM 返回结果覆盖 encoder 结果
- 记录 disagreement case 到 shadow_comparisons（model="macbert-2stage+fallback"）
- 目标：18% 低置信样本中至少挽回一半

### 3. 记忆修复闭环 v1

**文件**: `src/core/engine.ts`, `src/core/retriever.ts`, `src/db/schema.ts`

触发条件：
- 查询 zero-hit（result_count=0）
- 别名纠正（用户说「不对，那个叫 X」）
- 同一决策被重复纠正 ≥3 次

修复动作：
- 自动创建 alias（相似碎片间的大差异 bigram）
- 低命中碎片降权
- 标记 memory_repair_job 记录

aliases 表（schema 新增）：
```sql
CREATE TABLE IF NOT EXISTS aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  canonical TEXT NOT NULL,
  alias TEXT NOT NULL,
  source TEXT DEFAULT 'user',
  confidence REAL DEFAULT 0.8,
  created_at INTEGER DEFAULT (unixepoch()*1000)
);
```

查询扩展（retriever.ts）：embedding 之前用 aliases 表展开 query，双向（搜 canonical 也搜 alias）。

### 4. dreaming worker auto-alias

**文件**: `src/skill/hooks/auto-fragment.ts` (dreaming 部分)

在 dreaming 蒸馏步骤之后插入：
1. 查 abandoned 碎片（recalled_count < 2, created_at > 30 天前, 有 persisted vector, LIMIT 20）
2. 查 recent 碎片（created_at < 7 天内, 有 persisted vector, LIMIT 50）
3. 余弦相似度 > 0.85 的 abandoned↔recent 对 → 提取差异 bigram → 自动创建 alias（confidence=0.7, source="auto"）
4. 每次 dreaming 最多 5 个 auto alias

---

## 验证方式

每完成一个 P0 任务：
1. `npx tsc` 零错误
2. 在开发 DB 上跑对应操作确认
3. 推分支，在 PR 里标注验证结果

## 注意事项

- ONNX 模型不提交 git（已 ignore）——两台机各自用 `train-two-stage.py` 导出
- 开发 DB 是主力机 2026-05-28 快照，包含真实记忆，仅用于开发验证
- 不要在这台机上跑 `dreaming` 或 `decay` 的自动调度——保持 DB 静态便于对照测试
