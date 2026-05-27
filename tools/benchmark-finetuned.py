"""Benchmark fine-tuned 1.5B LoRA model vs zero-shot 7B vs few-shot 7B."""
import json, torch, random
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel

adapter_path = "./tools/lora-output/final-adapter"
base_model = "./tools/model-cache/Qwen/Qwen2___5-1___5B"

print("Loading fine-tuned model...")
tokenizer = AutoTokenizer.from_pretrained(adapter_path, trust_remote_code=True)
model = AutoModelForCausalLM.from_pretrained(
    base_model, torch_dtype=torch.float16, device_map="auto", trust_remote_code=True)
model = PeftModel.from_pretrained(model, adapter_path)
model.eval()
print(f"VRAM: {torch.cuda.memory_allocated()/1e9:.1f} GB")

# Load test fragments from JSONL
print("Loading test data...")
with open("./tools/feel-training-dataset.jsonl", encoding="utf-8") as f:
    all_data = [json.loads(l) for l in f if l.strip()]

# Use holdout set (last 15%), not training data
random.seed(42)
random.shuffle(all_data)
split = int(len(all_data) * 0.85)
eval_set = all_data[split:]

# Take a diverse test set from eval: all available per channel
random.seed(123)
test_set = []
for ch in ["FEEL", "WHAT", "WHERE", "WHO"]:
    ch_samples = [x for x in eval_set if x["label"] == ch]
    n = min(15, len(ch_samples))
    if n > 0:
        test_set.extend(random.sample(ch_samples, n))

print(f"Test set: {len(test_set)} samples ({sum(1 for x in test_set if x['label']=='FEEL')} FEEL)")

SYSTEM = "分类通道(只输出WHAT/FEEL/WHO/WHERE中的一个):\nWHAT=实质决策/方案/需求 FEEL=用户对AI的情绪反馈 WHO=涉及人物/角色 WHERE=文件/项目/工具"

matches = 0
per_channel = {}
mismatches = []

for i, item in enumerate(test_set):
    text, label = item["text"], item["label"]
    prompt = f"<|im_start|>system\n{SYSTEM}<|im_end|>\n<|im_start|>user\n\"{text[:200]}\"\n通道:<|im_end|>\n<|im_start|>assistant\n"
    inputs = tokenizer(prompt, return_tensors="pt").to(model.device)

    with torch.no_grad():
        outputs = model.generate(**inputs, max_new_tokens=8, do_sample=False,
                                 pad_token_id=tokenizer.eos_token_id, temperature=None)
    response = tokenizer.decode(outputs[0][inputs.input_ids.shape[1]:], skip_special_tokens=True).strip().upper()
    VALID = {"WHAT","FEEL","WHO","WHERE"}
    # Take first valid channel token
    words = response.replace(":"," ").replace(","," ").split()
    pred = "WHAT"
    for w in words:
        if w in VALID:
            pred = w
            break
    match = pred == label
    if match: matches += 1

    ch = label
    if ch not in per_channel: per_channel[ch] = {"correct": 0, "total": 0}
    per_channel[ch]["total"] += 1
    if match: per_channel[ch]["correct"] += 1

    if not match: mismatches.append({"text": text[:80], "label": label, "pred": pred})
    print(f"  {i+1:2d} | Label: {label} -> FT: {pred} | {'OK' if match else 'XX'}", flush=True)

print(f"\n=== Fine-tuned 1.5B LoRA (5 epochs, GPU) ===")
print(f"Total: {len(test_set)} | Accuracy: {matches/len(test_set)*100:.1f}%")
for ch, d in sorted(per_channel.items()):
    acc = d["correct"]/d["total"]*100 if d["total"] > 0 else 0
    print(f"  {ch}: {d['correct']}/{d['total']} ({acc:.0f}%)")

if mismatches:
    print(f"\nMismatches ({len(mismatches)}):")
    for m in mismatches[:15]:
        print(f"  [{m['label']}->{m['pred']}] {m['text']}")

# Comparison table
print("\n=== Methods Comparison ===")
print("  Zero-shot 7B:  47.5% overall, 0% FEEL")
print("  Few-shot 7B:   65.0% overall, 19% FEEL")
print(f"  FT 1.5B LoRA:  {matches/len(test_set)*100:.1f}% overall")
