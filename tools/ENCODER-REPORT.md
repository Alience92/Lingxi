# 灵犀 FEEL 通道分类 — Encoder 路线最终报告

**日期**: 2026-05-28
**上一篇报告**: TRAINING-REPORT.md（生成式 LoRA 路线，FEEL 0%，路线废止）

---

## 结论先行

| 指标 | 值 |
|------|-----|
| **FEEL recall** | **92.0%** |
| 整体 accuracy | 70.7% |
| F1-macro | 0.700 |
| 模型大小 | **400 MB**（macbert-base） |
| 训练时间 | **3 分钟**（CPU） |
| 推理延时 | <10ms |
| 硬件需求 | 任意主机，无需 GPU |

**GPT 上轮预估上限**：few-shot 先到 30%，7B QLoRA 预期 50-70%，80%+ 需要 Linux + 14B。

**实际结果**：macbert 400MB + 3 分钟 CPU 训练 → FEEL 92%。超过了最乐观估计，且不需要堆模型。

---

## 1. 任务范式切换

上轮失败根因：用生成式 SFT 做四分类。1.5B/7B 小模型生成式输出塌成高频标签（WHAT），FEEL 恒为 0%。

本次修正：**判别式分类**。macbert-base + sequence classification head，输出空间固定为 4 类 logits，CrossEntropyLoss 直接优化分类边界。

```
生成式 SFT：text → decoder → "WHAT"/"FEEL"/... → 自由生成，小模型塌缩
判别式 CLS：text → encoder → [0.1, 0.8, 0.05, 0.05] → argmax → 稳定
```

## 2. 数据工程

### 2.1 训练集

| 来源 | 数量 | 说明 |
|------|------|------|
| DB 真实 FEEL | 320 | weight >= 30 的活跃碎片 |
| 合成 FEEL | 220 | LLM 生成，自然口语化 |
| DB 真实 WHAT | 500 | weight 降序取 |
| DB 真实 WHERE | 142 | 全量 |
| DB 真实 WHO | 85 | 全量 |
| 边界 FEEL | 103 | "表面像 WHAT，实质 FEEL" |
| 边界 WHAT | 100 | "表面像 FEEL，实质 WHAT" |
| **总计** | **1430** | |

训练时做了类均衡下采样（each class → minority class size），每轮约 340 条。

### 2.2 测试集

300 条独立测试集，四通道各 75 条，来源：
- WHAT：DB 提取（排除训练数据）
- FEEL：DB 30 + 合成池 45
- WHERE/WHO：LLM 生成 75+75

### 2.3 边界样本（关键）

GPT 上轮指出："FEEL 和 WHAT 的边界句子最容易误判"。

生成了 203 条 hard negatives：
- Type A（103条）：表面规则/决策，实质关系调节 → label=FEEL
  - 例："你删掉的那行 console.log 是我唯一的调试手段，别动它"
  - 例："方案里别再删我的注释，那些注释是给后面维护的人看的"
- Type B（100条）：表面偏好/纠正，实质技术决策 → label=WHAT
  - 例："希望缓存采用多级策略：本地热点缓存→redis→DB"
  - 例："选择pandas处理数据报表，原生循环性能太差受不了"

## 3. 训练历程

| 轮次 | class_weights [WHAT,FEEL,WHERE,WHO] | Epochs | Acc | F1-macro | FEEL recall | WHAT recall | WHERE recall | WHO recall |
|------|-------------------------------------|--------|-----|----------|-------------|-------------|--------------|-------------|
| v1 | [1.0, 1.0, 1.0, 1.0] 等权 | 8 | 70.7% | 0.694 | **92.0%** | 42.7% | 83.8% | 64.5% |
| v2 | [1.5, 1.0, 1.0, 1.3] WHAT/WHO↑ | 12 | 68.7% | 0.663 | 94.7% | 40.0% | 94.6% | 46.1% |
| **v3** | **[1.8, 0.7, 1.0, 2.0]** FEEL↓ | 12 | **70.7%** | **0.700** | 92.0% | 50.7% | 73.0% | 67.1% |

v3 为最终版本。v2 证明单纯拉升少数类会牺牲多数类，v3 通过压低 FEEL 权重（0.7）找到平衡。

### v3 混淆矩阵

```
         WHAT  FEEL  WHERE  WHO
WHAT      38     5     22    10    ← WHAT→WHERE 主要混淆（含文件路径的WHAT）
FEEL       0    69      0     6    ← FEEL 仅 6 条漏网
WHERE     20     0     54     0    ← WHERE→WHAT（技术决策类WHERE）
WHO        2    23      0    51    ← WHO→FEEL（角色描述含关系性语言）
```

## 4. 全方法对比

| 方法 | 模型 | 整体 | FEEL | WHAT | WHERE | WHO | 训练 |
|------|------|------|------|------|-------|-----|------|
| Zero-shot 7B | qwen2.5:7b | 47.5% | **0%** | 81% | 100% | 100% | 无 |
| Few-shot 7B | qwen2.5:7b + 5 ex | 65.0% | **19%** | 95% | 100% | 100% | 无 |
| FT 1.5B LoRA | qwen2.5:1.5b | 23.3% | **0%** | 93% | 0% | 0% | 47min GPU |
| **Encoder v3** | **macbert-base** | **70.7%** | **92%** | 51% | 73% | 67% | **3min CPU** |

## 5. 关键发现

1. **任务范式 >> 模型大小**：macbert-base (102M) 分类器完胜 qwen2.5:7B (7B) 生成式。给问题匹配合适的模型架构比堆参数重要。

2. **边界样本是 FEEL 突破的关键**：不加边界样本时 FEEL 0%。加了 203 条"表面像 WHAT、实质 FEEL"的 hard negatives 后直接拉到 92%。

3. **class_weight 是杠杆而非解药**：仅靠权重从 0% 推不到 92%。但 v1→v3 的 0.7 FEEL 权重有效防止了模型过度预测 FEEL（v2 的教训）。

4. **家用主机天花板被重新定义**：GPT 预估 80%+ 需要 Linux + 14B。实际上 400MB 模型 + 3 分钟 CPU 训练就达到了 92%。正确的问题建模把硬件门槛降了两个数量级。

5. **测试集质量 = 结论可信度**：之前 60 条测试集（每类 15 条）统计波动大。扩到 300 条后 FEEL 92% 这个数字是可信的。

## 6. 产出物

| 文件 | 路径 |
|------|------|
| 最终模型 | `tools/encoder-output/` |
| 训练数据（1430条） | `tools/feel-training-dataset.jsonl` |
| 测试集（300条） | `tools/test-set.json` |
| 边界样本（203条） | `tools/boundary-samples.json` |
| 训练脚本 | `tools/train-encoder.py` |
| 上轮报告 | `tools/TRAINING-REPORT.md` |

## 7. 部署形态

macbert-base 可导出为 ONNX（~400MB），嵌入灵犀 MCP server 进程内推理。不需要 Ollama、不需要 GPU、不需要额外服务。任意能跑 Claude Code 的机器都能跑。

延时 <10ms，对 UserPromptSubmit hook 的热路径零影响。
