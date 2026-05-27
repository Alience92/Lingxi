# 灵犀 FEEL 通道分类微调 — 完整训练报告

**日期**: 2026-05-27

---

## 1. 硬件环境

| 组件 | 规格 |
|------|------|
| CPU | 12th Gen Intel i7-12650H (16核) |
| RAM | 16.9 GB |
| GPU | NVIDIA RTX 4060 Laptop (8 GB VRAM) |
| CUDA | 12.1 |
| PyTorch | 2.2.2+cu121 |
| Transformers | 4.46.0 |
| PEFT | 0.19.1 |
| OS | Windows 11 |

## 2. 数据集

- **总样本**: 1227
- **训练/验证**: 1042 (85%) / 185 (15%)
- **分布**: FEEL 500 / WHAT 500 / WHERE 142 / WHO 85
- **来源**: 220 合成 + 320 DB真实FEEL + 500 DB WHAT + 142 DB WHERE + 85 DB WHO
- **文件**: `D:/Lingxi-v4/tools/feel-training-dataset.jsonl`

## 3. 训练历程

| 次序 | 方案 | 结果 | 原因 |
|------|------|------|------|
| 1 | 3B CPU | 失败 | huggingface.co 连接超时 |
| 2 | 3B CPU (hf-mirror) | 失败 | 下载超时，0.22GB/6GB |
| 3 | 3B CPU (ModelScope) | 放弃 | 每步 5-15 分钟，5 epoch 需 >30h |
| 4 | 3B GPU (fp16) | OOM | 模型 7.15GB，训练需 7.2GB，超出 8GB 约 58MB |
| 5 | 1.5B GPU v1 | 完成 | 47min, train_loss=1.21, 但损失函数未遮蔽非标签token |
| 6 | 1.5B GPU v2 | 完成 | 47min, train_loss=0.29, 已修复标签遮蔽 |

**环境问题记录**:
- pytorch.org 下载慢 → 国内镜像缺少 Windows CUDA wheel → 手动 curl 下载
- torch 2.3.1/2.4.1 缺 `shm.dll` → torch 2.2.2+cu121 可用
- torch 2.2.2 与 numpy 2.x 冲突 → 降级 numpy 到 1.26.4
- datasets 在模型加载后导入触发 segfault → 改为先导入 datasets
- GPU 初次未检测到 → `nvidia-smi` 确认为 RTX 4060 8GB

## 4. 微调参数

| 参数 | 值 |
|------|-----|
| 基座模型 | Qwen2.5-1.5B |
| 微调方法 | LoRA |
| LoRA rank (r) | 16 |
| LoRA alpha | 32 |
| LoRA dropout | 0.05 |
| 目标模块 | q_proj, k_proj, v_proj, o_proj, gate_proj, up_proj, down_proj |
| 可训练参数 | 29,933,568 / 3,115,872,256 (0.96%) |
| 学习率 | 2e-4 |
| Warmup | 20 步 |
| Batch size | 1 × 8 梯度累积 = 有效 batch 8 |
| Epochs | 5 |
| 优化器 | AdamW (默认) |
| 精度 | fp16 |
| 训练时间 | ~47 分钟/轮 |

## 5. Benchmark 结果

**测试集**: 从验证集随机抽取 60 条 (FEEL 15 / WHAT 15 / WHERE 15 / WHO 15)

| 方法 | 整体准确率 | FEEL | WHAT | WHERE | WHO |
|------|-----------|------|------|-------|-----|
| Zero-shot 7B | 47.5% | 0% | 81% | 100% | 100% |
| Few-shot 7B | **65.0%** | 19% | 95% | 100% | 100% |
| FT 1.5B LoRA v1 | 25.0% | 0% | 100% | 0% | 0% |
| FT 1.5B LoRA v2 | 23.3% | 0% | 93% | 0% | 0% |

**注**:
- v1: 损失函数计算全序列（包括系统提示和用户输入）
- v2: 修复为仅计算标签 token 的损失
- 微调模型在少数类（WHERE/WHO）上完全退化，统一输出 "WHAT"

## 6. 关键发现

1. **FEEL 是四个通道中最难分类的** — 零样本/少样本/微调三种方法均未突破 20%
2. **1.5B 微调模型学会了标签多样性** — 调试显示它能输出 FEEL/WHERE/WHO，但在验证集上回退到 WHAT（少数类欠拟合 + 验证集样本太少）
3. **7B few-shot (65%) 显著优于 1.5B 微调 (23%)** — 参数量对语用推理的影响大于微调本身
4. **3B fp16 训练刚好超出 8GB 显存** — 差 58MB，需要 QLoRA (bitsandbytes) 解决
5. **数据集不平衡** — WHAT/FEEL 各 500，WHERE 仅 142，WHO 仅 85，导致模型偏向多数类
6. **torch CUDA 在 Windows 上安装困难** — 需手动下载 wheel、降级 numpy、调整依赖版本

## 7. 下一步建议

| 优先级 | 方案 | 预期效果 | 耗时 |
|--------|------|----------|------|
| P0 | 使用 7B few-shot 作为生产方案 | 整体 65%, FEEL 19% | 已完成 |
| P1 | 解决 bitsandbytes → 7B QLoRA 微调 | 预期 FEEL 50-70% | 1-2 天 |
| P2 | 平衡数据集（每类 300+ 样本） | 解决少数类欠拟合 | 0.5 天 |
| P3 | 14B QLoRA 微调（云 GPU 或硬件升级） | 预期 FEEL 80%+ | 1-2 天 |

## 8. 产出物

| 文件 | 路径 |
|------|------|
| LoRA 适配器 | `D:/Lingxi-v4/tools/lora-output/final-adapter/` |
| 训练数据集 | `D:/Lingxi-v4/tools/feel-training-dataset.jsonl` |
| 合成 FEEL 样本 | `D:/Lingxi-v4/tools/synthetic-feel-samples.jsonl` |
| 真实 FEEL 参考 | `D:/Lingxi-v4/tools/feel-real-samples.jsonl` |
| 训练脚本 | `D:/Lingxi-v4/tools/train-lora.py` |
| 评估脚本 | `D:/Lingxi-v4/tools/benchmark-finetuned.py` |
| 模型缓存 | `D:/Lingxi-v4/tools/model-cache/` |
