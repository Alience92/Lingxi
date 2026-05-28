"""Export clean-base-v1 two-stage models to ONNX."""
import os
os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"

import torch
from transformers import AutoTokenizer, AutoModelForSequenceClassification

MODEL_DIR = "./tools/clean-model-output"
OUTPUT_DIR = "./tools/clean-model-output/onnx"

# Stage 1
print("Exporting Stage 1...")
model_s1 = AutoModelForSequenceClassification.from_pretrained(
    f"{MODEL_DIR}/Stage_1_FEEL_vs_NON-FEEL_(clean)")
model_s1.eval()

dummy_input = (torch.ones(1, 128, dtype=torch.long), torch.ones(1, 128, dtype=torch.long))
torch.onnx.export(
    model_s1, dummy_input,
    f"{OUTPUT_DIR}/stage1.onnx",
    input_names=["input_ids", "attention_mask"],
    output_names=["logits"],
    dynamic_axes={"input_ids": {0: "batch"}, "attention_mask": {0: "batch"}},
    opset_version=14,
)
print("  -> stage1.onnx")

# Stage 2
print("Exporting Stage 2...")
model_s2 = AutoModelForSequenceClassification.from_pretrained(
    f"{MODEL_DIR}/Stage_2_WHAT_WHERE_WHO_(clean)")
model_s2.eval()

torch.onnx.export(
    model_s2, dummy_input,
    f"{OUTPUT_DIR}/stage2.onnx",
    input_names=["input_ids", "attention_mask"],
    output_names=["logits"],
    dynamic_axes={"input_ids": {0: "batch"}, "attention_mask": {0: "batch"}},
    opset_version=14,
)
print("  -> stage2.onnx")

# Tokenizer
print("Exporting tokenizer...")
tokenizer = AutoTokenizer.from_pretrained(f"{MODEL_DIR}/Stage_1_FEEL_vs_NON-FEEL_(clean)")
tokenizer.save_pretrained(f"{OUTPUT_DIR}/tokenizer")
print("  -> tokenizer/")

print(f"\nDone. Models in {OUTPUT_DIR}/")
