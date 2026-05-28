"""
LoRA fine-tune qwen2.5:1.5b for 4-channel classification on GPU (8GB VRAM).
Downloads from ModelScope, trains LoRA on RTX 4060.
"""
import json
import random
import os

# Import data libraries BEFORE model libraries to avoid GPU memory fragmentation
from datasets import Dataset
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, Trainer, TrainingArguments, DataCollatorForSeq2Seq
from peft import LoraConfig, get_peft_model, TaskType
from modelscope import snapshot_download

# ── Config ──────────────────────────────────────────────────
MODEL_ID = "Qwen/Qwen2.5-1.5B"
MODEL_CACHE_DIR = "./tools/model-cache"
OUTPUT_DIR = "./tools/lora-output"

# ── Download model from ModelScope ───────────────────────────
print(f"Downloading {MODEL_ID} from ModelScope...")
model_dir = snapshot_download(MODEL_ID, cache_dir=MODEL_CACHE_DIR)
print(f"Model downloaded to: {model_dir}")
DATASET_PATH = "./tools/feel-training-dataset.jsonl"
MAX_LENGTH = 256
BATCH_SIZE = 1
GRADIENT_ACCUMULATION = 8
EPOCHS = 5
LEARNING_RATE = 2e-4

# ── Chat template ───────────────────────────────────────────
SYSTEM = "分类通道(只输出WHAT/FEEL/WHO/WHERE中的一个):\nWHAT=实质决策/方案/需求 FEEL=用户对AI的情绪反馈 WHO=涉及人物/角色 WHERE=文件/项目/工具"

def format_example(text, label):
    return f"<|im_start|>system\n{SYSTEM}<|im_end|>\n<|im_start|>user\n\"{text[:200]}\"\n通道:<|im_end|>\n<|im_start|>assistant\n{label}<|im_end|>"

# ── Load dataset ────────────────────────────────────────────
print("Loading dataset...")
with open(DATASET_PATH, "r", encoding="utf-8") as f:
    raw = [json.loads(line) for line in f if line.strip()]

random.seed(42)
random.shuffle(raw)

split = int(len(raw) * 0.85)
train_data = raw[:split]
eval_data = raw[split:]

print(f"Train: {len(train_data)}, Eval: {len(eval_data)}")
dist = {}
for x in raw:
    dist[x["label"]] = dist.get(x["label"], 0) + 1
print(f"Distribution: {dist}")

# ── Load tokenizer ──────────────────────────────────────────
print(f"\nLoading tokenizer from {model_dir}")
tokenizer = AutoTokenizer.from_pretrained(model_dir, trust_remote_code=True)
if tokenizer.pad_token is None:
    tokenizer.pad_token = tokenizer.eos_token

# ── Load model ──────────────────────────────────────────────
print(f"\nLoading model from {model_dir} (1.5B, ~3GB) onto GPU...")
model = AutoModelForCausalLM.from_pretrained(
    model_dir,
    torch_dtype=torch.float16,
    low_cpu_mem_usage=True,
    trust_remote_code=True,
    device_map="auto",
)

# ── Apply LoRA ──────────────────────────────────────────────
print("Applying LoRA...")
lora_config = LoraConfig(
    r=16,
    lora_alpha=32,
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    lora_dropout=0.05,
    bias="none",
    task_type=TaskType.CAUSAL_LM,
)

model = get_peft_model(model, lora_config)
model.print_trainable_parameters()

# ── Tokenize dataset ────────────────────────────────────────
print("\nTokenizing dataset...")

# Pre-compute the assistant marker tokens for label masking
ASSISTANT_MARKER = "<|im_start|>assistant\n"
END_MARKER = "<|im_end|>"
assistant_marker_ids = tokenizer.encode(ASSISTANT_MARKER, add_special_tokens=False)
end_marker_ids = tokenizer.encode(END_MARKER, add_special_tokens=False)

def tokenize_fn(examples):
    texts = [format_example(t, l) for t, l in zip(examples["text"], examples["label"])]
    tokens = tokenizer(texts, truncation=True, max_length=MAX_LENGTH, padding=False)

    # Mask labels: only compute loss on the assistant's response (the label)
    labels_list = []
    for ids in tokens["input_ids"]:
        labels = [-100] * len(ids)  # Default: ignore all

        # Find assistant marker position
        marker_len = len(assistant_marker_ids)
        found = False
        for j in range(len(ids) - marker_len + 1):
            if ids[j:j+marker_len] == assistant_marker_ids:
                # Label starts right after the marker, ends before <|im_end|>
                label_start = j + marker_len
                label_end = len(ids)
                # Find <|im_end|> after label_start
                end_len = len(end_marker_ids)
                for k in range(label_start, len(ids) - end_len + 1):
                    if ids[k:k+end_len] == end_marker_ids:
                        label_end = k
                        break
                for k in range(label_start, label_end):
                    labels[k] = ids[k]
                found = True
                break

        if not found:
            # Fallback: mask last few tokens as labels (the label + <|im_end|>)
            labels[-8:] = ids[-8:]

        labels_list.append(labels)

    tokens["labels"] = labels_list
    return tokens

train_ds = Dataset.from_list([{"text": x["text"], "label": x["label"]} for x in train_data])
eval_ds = Dataset.from_list([{"text": x["text"], "label": x["label"]} for x in eval_data])

train_ds = train_ds.map(tokenize_fn, batched=True, remove_columns=["text", "label"])
eval_ds = eval_ds.map(tokenize_fn, batched=True, remove_columns=["text", "label"])

# ── Train ───────────────────────────────────────────────────
print(f"\n{'='*60}")
print("Starting LoRA training on CPU...")
print(f"  Model: {MODEL_ID}")
print(f"  Samples: {len(train_data)} train / {len(eval_data)} eval")
print(f"  Epochs: {EPOCHS} | LR: {LEARNING_RATE} | Batch: {BATCH_SIZE}x{GRADIENT_ACCUMULATION}")
print(f"  Estimated time: ~15-30 min on RTX 4060 GPU")
print(f"{'='*60}\n")

training_args = TrainingArguments(
    output_dir=OUTPUT_DIR,
    per_device_train_batch_size=BATCH_SIZE,
    per_device_eval_batch_size=BATCH_SIZE,
    gradient_accumulation_steps=GRADIENT_ACCUMULATION,
    num_train_epochs=EPOCHS,
    learning_rate=LEARNING_RATE,
    warmup_steps=20,
    logging_steps=10,
    eval_strategy="epoch",
    save_strategy="epoch",
    save_total_limit=2,
    load_best_model_at_end=True,
    metric_for_best_model="eval_loss",
    greater_is_better=False,
    report_to="none",
    use_cpu=False,
    dataloader_num_workers=0,
    fp16=False,
    bf16=False,
)

trainer = Trainer(
    model=model,
    args=training_args,
    train_dataset=train_ds,
    eval_dataset=eval_ds,
    tokenizer=tokenizer,
    data_collator=DataCollatorForSeq2Seq(tokenizer, model, padding=True),
)

trainer.train()

# ── Save LoRA adapter ───────────────────────────────────────
adapter_path = os.path.join(OUTPUT_DIR, "final-adapter")
model.save_pretrained(adapter_path)
tokenizer.save_pretrained(adapter_path)
print(f"\nLoRA adapter saved to: {adapter_path}")

# ── Eval ────────────────────────────────────────────────────
print("\nFinal evaluation:")
metrics = trainer.evaluate()
print(f"  Eval loss: {metrics['eval_loss']:.4f}")

# Save metrics
with open(os.path.join(OUTPUT_DIR, "metrics.json"), "w") as f:
    json.dump(metrics, f, indent=2)

print("\nDone! Next steps:")
print("  1. Merge LoRA: python tools/merge-lora.py")
print("  2. Convert to GGUF")
print("  3. Use for local inference (legacy LoRA path — encoder ONNX is production)")
