#!/usr/bin/env python3
"""一次性脚本：把 cognitive_v5 模型动态量化为 int8（体积/内存约 1/4）。

用法：
    pip install onnxruntime
    python scripts/quantize-cognitive-model.py <输入.onnx 或 目录> [输出.onnx]

省略输出路径时，写到输入同目录的 cognitive_v5.int8.onnx。
resolveModelPath()（src/config.ts）会发现它，**但默认仍优先用 fp32**。

⚠️ 先看实测数据再决定是否启用（2026-09-11 实测）：

    体积      416.8 MB -> 105.0 MB  (25%)
    加载      808 ms   -> 410 ms
    向量自一致性  cos(fp32, int8) mean=0.916  min=0.829
    检索 top-1   一致
    检索 top-3   3/3
    检索 top-5   3/5   <- 尾部排序会变

本仓库多处使用**绝对分数阈值**（如 cognitiveVectorSearch 的 s > 0.45），
自一致性 0.92 意味着分数整体偏移，会改变召回结果。所以：

  * 默认：fp32 优先；int8 仅在 fp32 缺失时被使用，且 status 会给出告警。
  * 想用 int8 省内存：设 LINGXI_PREFER_INT8=1。
  * 想回退 fp32：删掉 cognitive_v5.int8.onnx、并取消 LINGXI_PREFER_INT8。

本脚本只读取输入、只写出新文件；不改动输入模型，也不改动任何配置。
"""

from __future__ import annotations

import os
import sys

try:
    from onnxruntime.quantization import QuantType, quantize_dynamic
except ImportError:  # pragma: no cover
    print("缺少依赖：onnxruntime。请先执行  pip install onnxruntime", file=sys.stderr)
    raise SystemExit(2)

# 目录输入时的候选文件名（与 src/config.ts 的 COGNITIVE_MODEL_FILES 对应）
CANDIDATES = ["cognitive_v5.onnx", "cognitive_v5.int8.onnx"]


def resolve_input(arg: str) -> str:
    """接受 .onnx 文件或目录。"""
    if os.path.isfile(arg):
        return arg
    if os.path.isdir(arg):
        for name in CANDIDATES:
            p = os.path.join(arg, name)
            if os.path.isfile(p):
                return p
        raise SystemExit(f"目录里没找到模型（尝试过 {', '.join(CANDIDATES)}）：{arg}")
    raise SystemExit(f"输入既不是文件也不是目录：{arg}")


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__.strip())
        return 2

    src = resolve_input(sys.argv[1])
    if len(sys.argv) > 2:
        dst = sys.argv[2]
    else:
        stem, _ = os.path.splitext(src)
        dst = stem + ".int8.onnx"

    if os.path.abspath(src) == os.path.abspath(dst):
        print("输入与输出相同，拒绝覆盖。", file=sys.stderr)
        return 1
    if os.path.exists(dst):
        print(f"输出已存在，将被覆盖：{dst}")

    src_mb = os.path.getsize(src) / 1e6
    print(f"输入: {src}  ({src_mb:.1f} MB)")
    print(f"输出: {dst}")
    print("量化中（大模型可能需要几分钟）...")

    quantize_dynamic(src, dst, weight_type=QuantType.QInt8)

    dst_mb = os.path.getsize(dst) / 1e6
    print(f"完成: {src_mb:.1f} MB -> {dst_mb:.1f} MB ({dst_mb / src_mb * 100:.0f}%)")
    print("提示: 默认仍优先加载 fp32；启用 int8 请设 LINGXI_PREFER_INT8=1（先读上方实测数据）。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
