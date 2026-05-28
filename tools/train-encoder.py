"""
Encoder classifier for 4-channel classification (macbert-base).
Discriminative classification — no generative LM, no label collapse.
"""
import os
os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"

import json, random
import numpy as np
import torch
from torch.utils.data import Dataset, DataLoader
from torch.optim import AdamW
from torch.nn import CrossEntropyLoss
from transformers import AutoTokenizer, AutoModelForSequenceClassification, get_linear_schedule_with_warmup
from sklearn.metrics import accuracy_score, f1_score, confusion_matrix, classification_report

# Config
MODEL_ID = "hfl/chinese-macbert-base"
OUTPUT_DIR = "./tools/encoder-output"
TRAIN_PATH = "./tools/feel-training-dataset.jsonl"
TEST_PATH = "./tools/test-set.json"
BATCH_SIZE = 16
EPOCHS = 12
LR = 2e-5
MAX_LEN = 128
NUM_LABELS = 4
LABEL_MAP = {"WHAT": 0, "FEEL": 1, "WHERE": 2, "WHO": 3}
ID2LABEL = {v: k for k, v in LABEL_MAP.items()}

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
print(f"Device: {device}")

# Load data
def load_jsonl(path):
    with open(path, "r", encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]

train_data = load_jsonl(TRAIN_PATH)
test_data = json.load(open(TEST_PATH, "r", encoding="utf-8"))

# Balance: downsample majority classes to minority class size
random.seed(42)
minority = min(sum(1 for x in train_data if x["label"] == l) for l in LABEL_MAP)
balanced = []
for l in LABEL_MAP:
    samples = [x for x in train_data if x["label"] == l]
    balanced.extend(random.sample(samples, minority))
random.shuffle(balanced)
print(f"Train: {len(balanced)} balanced (from {len(train_data)}), Test: {len(test_data)}")

# Show distribution
train_dist = {}
for x in balanced: train_dist[x["label"]] = train_dist.get(x["label"], 0) + 1
test_dist = {}
for x in test_data: test_dist[x["label"]] = test_dist.get(x["label"], 0) + 1
print(f"  Train dist: {train_dist}")
print(f"  Test dist: {test_dist}")

# Tokenizer
tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)

class FeelDataset(Dataset):
    def __init__(self, data):
        self.data = data
    def __len__(self):
        return len(self.data)
    def __getitem__(self, idx):
        item = self.data[idx]
        tokens = tokenizer(item["text"], truncation=True, max_length=MAX_LEN, padding="max_length", return_tensors="pt")
        return {
            "input_ids": tokens["input_ids"].squeeze(0),
            "attention_mask": tokens["attention_mask"].squeeze(0),
            "labels": torch.tensor(LABEL_MAP[item["label"]], dtype=torch.long),
        }

train_ds = FeelDataset(balanced)
test_ds = FeelDataset(test_data)
train_loader = DataLoader(train_ds, batch_size=BATCH_SIZE, shuffle=True)
test_loader = DataLoader(test_ds, batch_size=BATCH_SIZE)

# Model
print(f"\nLoading {MODEL_ID}...")
model = AutoModelForSequenceClassification.from_pretrained(
    MODEL_ID, num_labels=NUM_LABELS, ignore_mismatched_sizes=True)
model.to(device)
print(f"Model params: {sum(p.numel() for p in model.parameters())/1e6:.1f}M")

# Training setup
optimizer = AdamW(model.parameters(), lr=LR, weight_decay=0.01)
total_steps = len(train_loader) * EPOCHS
scheduler = get_linear_schedule_with_warmup(optimizer, num_warmup_steps=total_steps//10, num_training_steps=total_steps)

# Class weights: boost WHAT (currently 43% recall) and WHO (confused with FEEL)
# WHAT=0, FEEL=1, WHERE=2, WHO=3
class_weights = torch.tensor([1.8, 0.7, 1.0, 2.0], dtype=torch.float).to(device)
criterion = CrossEntropyLoss(weight=class_weights)

# Train
print(f"\n{'='*60}")
print(f"Training: {EPOCHS} epochs, {len(train_loader)} batches/epoch, {total_steps} total steps")
print(f"Model: {MODEL_ID} ({sum(p.numel() for p in model.parameters())/1e6:.1f}M params)")
print(f"Device: {device}, Batch: {BATCH_SIZE}")
print(f"{'='*60}\n")

best_f1 = 0.0
for epoch in range(EPOCHS):
    model.train()
    total_loss = 0
    for batch_idx, batch in enumerate(train_loader):
        input_ids = batch["input_ids"].to(device)
        attention_mask = batch["attention_mask"].to(device)
        labels = batch["labels"].to(device)

        optimizer.zero_grad()
        outputs = model(input_ids, attention_mask=attention_mask)
        loss = criterion(outputs.logits, labels)
        loss.backward()
        optimizer.step()
        scheduler.step()
        total_loss += loss.item()

        if (batch_idx + 1) % 20 == 0:
            print(f"  Epoch {epoch+1} | Batch {batch_idx+1}/{len(train_loader)} | Loss: {loss.item():.4f}")

    avg_loss = total_loss / len(train_loader)

    # Eval
    model.eval()
    all_preds, all_labels = [], []
    with torch.no_grad():
        for batch in test_loader:
            input_ids = batch["input_ids"].to(device)
            attention_mask = batch["attention_mask"].to(device)
            labels = batch["labels"]
            outputs = model(input_ids, attention_mask=attention_mask)
            preds = torch.argmax(outputs.logits, dim=1).cpu()
            all_preds.extend(preds.numpy())
            all_labels.extend(labels.numpy())

    acc = accuracy_score(all_labels, all_preds)
    f1_macro = f1_score(all_labels, all_preds, average="macro")
    f1_weighted = f1_score(all_labels, all_preds, average="weighted")

    print(f"  Epoch {epoch+1} done | Loss: {avg_loss:.4f} | Acc: {acc:.3f} | F1-macro: {f1_macro:.3f} | F1-weighted: {f1_weighted:.3f}")

    if f1_macro > best_f1:
        best_f1 = f1_macro
        model.save_pretrained(OUTPUT_DIR)
        tokenizer.save_pretrained(OUTPUT_DIR)
        print(f"  -> Best model saved (F1-macro: {f1_macro:.3f})")

# Final evaluation
print(f"\n{'='*60}")
print("FINAL EVALUATION")
print(f"{'='*60}")

model = AutoModelForSequenceClassification.from_pretrained(OUTPUT_DIR)
model.to(device)
model.eval()

all_preds, all_labels = [], []
with torch.no_grad():
    for batch in test_loader:
        input_ids = batch["input_ids"].to(device)
        attention_mask = batch["attention_mask"].to(device)
        labels = batch["labels"]
        outputs = model(input_ids, attention_mask=attention_mask)
        preds = torch.argmax(outputs.logits, dim=1).cpu()
        all_preds.extend(preds.numpy())
        all_labels.extend(labels.numpy())

print(f"\nAccuracy: {accuracy_score(all_labels, all_preds):.4f}")
print(f"F1-macro: {f1_score(all_labels, all_preds, average='macro'):.4f}")
print(f"F1-weighted: {f1_score(all_labels, all_preds, average='weighted'):.4f}")
print(f"\nClassification Report:")
print(classification_report(all_labels, all_preds, target_names=list(LABEL_MAP.keys()), digits=3))
print(f"Confusion Matrix:")
cm = confusion_matrix(all_labels, all_preds)
print("       " + " ".join(f"{l:>6}" for l in LABEL_MAP.keys()))
for i, label in enumerate(LABEL_MAP.keys()):
    print(f"  {label:4s} " + " ".join(f"{cm[i][j]:>6}" for j in range(NUM_LABELS)))

# Per-class recall
for i, label in enumerate(LABEL_MAP.keys()):
    recall = cm[i][i] / cm[i].sum() if cm[i].sum() > 0 else 0
    print(f"  {label} recall: {recall:.3f}")

print(f"\nModel saved to: {OUTPUT_DIR}")
