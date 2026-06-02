#!/bin/bash
# 灵犀 灵眸 模型下载脚本
# 从 GitHub Releases 下载预训练 ONNX 模型，不重新训练
# 如果没有模型文件，通道分类自动走 LLM fallback，不影响正常使用

set -e

MODEL_DIR="$(dirname "$0")/two-stage-output"
RELEASE_URL="https://github.com/Alience92/Lingxi/releases/download"

# Latest release tag — update after each training run
# Current: v4.0.0-beta — models from 2026-05-28 training
TAG="${1:-lingmou-v1}"

echo "灵犀 灵眸 模型下载"
echo "目标: $MODEL_DIR"
echo "版本: $TAG"
echo ""

mkdir -p "$MODEL_DIR"

for FILE in stage1.onnx stage2.onnx; do
  if [ -f "$MODEL_DIR/$FILE" ]; then
    echo "✓ $FILE 已存在，跳过"
  else
    echo "↓ 下载 $FILE ..."
    curl -L --progress-bar -o "$MODEL_DIR/$FILE" "$RELEASE_URL/$TAG/$FILE"
    echo "✓ $FILE 下载完成"
  fi
done

echo ""
echo "灵眸模型就绪。运行 npx tsc 编译后即可使用。"
echo "提示: 当前版本是训练产物。如需自行训练，运行: python tools/train-two-stage.py"
