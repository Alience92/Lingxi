# Changelog

## 2026-06-06 (v1.1.1) — Opus 审查修复

### 严重修复
- **BUG-1**: `EngineConfig.model` 拆为 `embeddingModel` + `fragmentationModel`，消除嵌入模型与碎片化 LLM 模型字段冲突
- **BUG-3**: `fragments` 表加 `vector_model TEXT` 列，写入时记录嵌入模型名，防不同维度向量混存
- **BUG-5**: `embedBatch()` 加 `_fallbackWarned` 单次告警，不再静默吞错

### 健壮性
- **BUG-2**: dim 判别 `=== "bge-m3"` → `.includes("bge-m3")`，覆盖 `bge-m3:latest` 等 Ollama tag 别名
- **BUG-6**: singleton 替换告警仅在配置不同时触发，相同配置静默替换
- 删除 MiniMax 嵌入死代码（`isMiniMax`、`embedMiniMax`、`groupId`、batch MiniMax 分支）——约 50 行
- 碎片化 LLM 默认值移除 MiniMax M2.7，统一为 DeepSeek

### 迁移脚本改进
- **BUG-4**: 默认 projectId 从硬编码改为读 `AGENTMEMORY_PROJECT` 环境变量，缺则报错
- 批失败自动降级到逐条重试（指数回退 1s/2s/4s）
- 本地 Ollama 跳过请求间 sleep
- 已标记 `vector_model = "bge-m3"` 的 fragment 自动跳过
- 所有脚本支持 `--dry-run`

---

## 2026-06-06 (v1.1) — bge-m3 嵌入引擎可插拔化 + 全量迁移 + Hook 层演进

### bge-m3 嵌入引擎可插拔化

- **模型可配置**：`embedder.ts` 不再硬编码 `text-embedding-3-small`，改读 `AGENTMEMORY_EMBEDDING_MODEL` 环境变量
- **维度自适应**：bge-m3 → 1024-dim，MiniMax embo-01 → 1536-dim，hash fallback 跟随目标维度
- **Engine 透传**：`MemoryEngine` 构造函数将 `config.model` 传递给 `Embedder`

### bge-m3 全量迁移

- **3323 碎片全部重嵌入**：2946 个 hash 向量 + 330 个 MiniMax embo-01 → 1024-dim bge-m3
- **搜索命中率质变**：自然语言查询命中率 35% → 100%，零命中率 60% → 0%，平均得分 0.40 → 0.68
- **Windows 兼容修复**：Ollama endpoint `localhost` → `127.0.0.1`（Win11 下 Node.js undici 的 DNS 解析 bug）
- **配套脚本**：`scripts/reembed-bge-m3.mjs`（批量）、`scripts/retry-failed-reembed.mjs`（逐个重试）、`scripts/fix-remaining.mjs`（残留清理）

### 小模型认知实验（5/27-5/28）

- **Shadow 影子对比系统**：`shadow_comparisons` 表，472 条基线，macbert-2stage 匹配率 82%
- **SLM 通道分类器**：macbert-base (400MB) 替代 LLM 做四通道分类，FEEL recall 92%，整体 70.7%，推理 <10ms
- **两阶段分类架构**：`src/smallmodel/classifier.ts` — ONNX encoder → LLM few-shot fallback（仅低置信度 18%）
- **边界样本工程**：203 条 hard negatives——不加之前 FEEL recall = 0%，加入后拉到 92%
- **FEEL 微调全历程**（6 轮）：3B GPU OOM → 1.5B LoRA (FEEL 0%) → 7B few-shot (19%) → macbert 判别式 (92%)。结论：任务范式 > 模型大小
- **activation_log 基础设施**：实时检索追踪 DB 层
- **memory-bias embedding**：自适应 alpha 权重（实验特性，已从生产分支 revert）

### SessionStart 演进

- **规则优先级分层**：铁律 (priority=0) → 教训规则 (1-49) → 行为建议 (50+)
- **行为约束转化**：主动将用户偏好转化为可执行的行为指令（自主执行、直接反馈、设计约束、安全优先）
- **用户画像分类**：编程/非编程背景自适应沟通风格
- **信任等级驱动**：L3 自主执行 > L2 选择 > L1 确认
- **Dreaming 多信号触发**：不再仅依赖 compact，增加信号计数、时间、碎片数量条件
- **死锁恢复 + 机会补触发**：回收超时 session + 每轮处理一个 pending session

### 基础设施

- **蒸馏规则增强**：support 计数、跨 session 来源、时间范围、优先级排序
- **关怀提醒**：active_context 支持 proactive care 消息（7天过期）
- **行为知识存储 → 行为指令**：偏好不再只是 FYI，SessionStart 自动转化为可执行操作约束

---

## 2026-06-02/03 — Phase 0A 实验基础设施

- AI self-reflection signal extraction (Phase 1 observe-only)
- Phase 0A extended baseline — 4 new eval metrics
- explicit knowledge edge augmentation in retriever
- activation_log infrastructure for real-time retrieval tracking
- memory-bias embedding with adaptive alpha (experimental, reverted from production)
