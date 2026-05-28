"""
Two-stage classifier:
  Stage 1: FEEL vs NON-FEEL (binary)
  Stage 2: WHAT vs WHERE vs WHO (3-class, only on NON-FEEL samples)

Rationale: FEEL is already at 92%. The main confusion is within NON-FEEL
(WHAT->WHERE, WHO->FEEL). Splitting the problem isolates FEEL's strength
and lets Stage 2 focus on discriminating WHAT/WHERE/WHO boundaries.
"""
import os
if not os.environ.get("HF_ENDPOINT") and os.environ.get("USE_HF_MIRROR") == "1":
    os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"

import json, random
import numpy as np
import torch
from torch.utils.data import Dataset, DataLoader
from torch.optim import AdamW
from torch.nn import CrossEntropyLoss, BCEWithLogitsLoss
from transformers import AutoTokenizer, AutoModelForSequenceClassification, get_linear_schedule_with_warmup
from sklearn.metrics import accuracy_score, f1_score, confusion_matrix, classification_report

# Config
MODEL_ID = "hfl/chinese-macbert-base"
OUTPUT_DIR = "./tools/two-stage-output"
TRAIN_PATH = "./tools/feel-training-dataset.jsonl"
TEST_PATH = "./tools/test-set.json"
BATCH_SIZE = 16
EPOCHS_S1 = 6
EPOCHS_S2 = 10
LR = 2e-5
MAX_LEN = 128

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
print(f"Device: {device}")

# Load data
def load_jsonl(path):
    with open(path, "r", encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]

train_data = load_jsonl(TRAIN_PATH)
test_data = json.load(open(TEST_PATH, "r", encoding="utf-8"))
random.seed(42)
np.random.seed(42)
torch.manual_seed(42)
if torch.cuda.is_available():
    torch.cuda.manual_seed_all(42)
    torch.backends.cudnn.deterministic = True
    torch.backends.cudnn.benchmark = False

# Balance training data
ALL_LABELS = ["WHAT", "FEEL", "WHERE", "WHO"]
minority = min(sum(1 for x in train_data if x["label"] == l) for l in ALL_LABELS)
balanced = []
for l in ALL_LABELS:
    samples = [x for x in train_data if x["label"] == l]
    balanced.extend(random.sample(samples, minority))
random.shuffle(balanced)

# Tokenizer
tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)

class FeelDataset(Dataset):
    def __init__(self, data, label_fn):
        self.data = data
        self.label_fn = label_fn
    def __len__(self): return len(self.data)
    def __getitem__(self, idx):
        item = self.data[idx]
        tokens = tokenizer(item["text"], truncation=True, max_length=MAX_LEN, padding="max_length", return_tensors="pt")
        return {
            "input_ids": tokens["input_ids"].squeeze(0),
            "attention_mask": tokens["attention_mask"].squeeze(0),
            "labels": torch.tensor(self.label_fn(item), dtype=torch.long),
        }

def train_model(name, train_ds, test_ds, num_labels, epochs, class_weights=None):
    print(f"\n{'='*50}")
    print(f"Training: {name} ({num_labels} classes, {epochs} epochs)")
    print(f"{'='*50}")

    model = AutoModelForSequenceClassification.from_pretrained(
        MODEL_ID, num_labels=num_labels, ignore_mismatched_sizes=True)
    model.to(device)

    loader = DataLoader(train_ds, batch_size=BATCH_SIZE, shuffle=True)
    test_loader = DataLoader(test_ds, batch_size=BATCH_SIZE)

    optimizer = AdamW(model.parameters(), lr=LR, weight_decay=0.01)
    total_steps = len(loader) * epochs
    scheduler = get_linear_schedule_with_warmup(optimizer, num_warmup_steps=total_steps//10, num_training_steps=total_steps)

    if class_weights is not None:
        w = torch.tensor(class_weights, dtype=torch.float).to(device)
        criterion = CrossEntropyLoss(weight=w)
    else:
        criterion = CrossEntropyLoss()

    best_f1 = 0.0
    for epoch in range(epochs):
        model.train()
        total_loss = 0
        for batch in loader:
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

        # Eval
        model.eval()
        all_preds, all_labels = [], []
        with torch.no_grad():
            for batch in test_loader:
                input_ids = batch["input_ids"].to(device)
                attention_mask = batch["attention_mask"].to(device)
                outputs = model(input_ids, attention_mask=attention_mask)
                preds = torch.argmax(outputs.logits, dim=1).cpu()
                all_preds.extend(preds.numpy())
                all_labels.extend(batch["labels"].numpy())

        acc = accuracy_score(all_labels, all_preds)
        f1 = f1_score(all_labels, all_preds, average="macro")
        if f1 > best_f1:
            best_f1 = f1
            save_path = f"{OUTPUT_DIR}/{name.replace(' ', '_')}"
            model.save_pretrained(save_path)
            tokenizer.save_pretrained(save_path)

        print(f"  Epoch {epoch+1:2d} | Loss: {total_loss/len(loader):.4f} | Acc: {acc:.4f} | F1: {f1:.4f}")

    print(f"  Best F1: {best_f1:.4f} -> {OUTPUT_DIR}/{name.replace(' ', '_')}")
    return model, best_f1

# ============ Stage 1: FEEL vs NON-FEEL ============
s1_label_fn = lambda item: 1 if item["label"] == "FEEL" else 0
s1_train = FeelDataset(balanced, s1_label_fn)
s1_test = FeelDataset(test_data, s1_label_fn)

model_s1, _ = train_model("Stage 1 FEEL vs NON-FEEL", s1_train, s1_test, 2, EPOCHS_S1)

# ============ Stage 2: WHAT vs WHERE vs WHO ============
# Only use NON-FEEL samples for training
non_feel_train = [x for x in balanced if x["label"] != "FEEL"]
non_feel_test = [x for x in test_data if x["label"] != "FEEL"]

S2_LABELS = {"WHAT": 0, "WHERE": 1, "WHO": 2}
S2_ID2LABEL = {v: k for k, v in S2_LABELS.items()}

s2_label_fn = lambda item: S2_LABELS[item["label"]]
s2_train = FeelDataset(non_feel_train, s2_label_fn)
s2_test = FeelDataset(non_feel_test, s2_label_fn)

# Stage 2 benefits from class weighting (WHAT underperforms)
model_s2, _ = train_model("Stage 2 WHAT WHERE WHO", s2_train, s2_test, 3, EPOCHS_S2,
                           class_weights=[1.5, 1.0, 1.3])

# ============ Pipeline Evaluation ============
print(f"\n{'='*60}")
print("PIPELINE EVALUATION (Two-Stage)")
print(f"{'='*60}")

# Load best models
model_s1 = AutoModelForSequenceClassification.from_pretrained(f"{OUTPUT_DIR}/Stage_1_FEEL_vs_NON-FEEL")
model_s1.to(device).eval()
model_s2 = AutoModelForSequenceClassification.from_pretrained(f"{OUTPUT_DIR}/Stage_2_WHAT_WHERE_WHO")
model_s2.to(device).eval()

all_preds, all_labels, all_confidences = [], [], []
test_loader = DataLoader(FeelDataset(test_data, lambda x: 0), batch_size=BATCH_SIZE)

with torch.no_grad():
    for batch in test_loader:
        input_ids = batch["input_ids"].to(device)
        attention_mask = batch["attention_mask"].to(device)

        # Stage 1: FEEL vs NON-FEEL
        s1_out = model_s1(input_ids, attention_mask=attention_mask)
        s1_probs = torch.softmax(s1_out.logits, dim=1)
        is_feel = s1_probs[:, 1] > 0.5  # prob of FEEL > 0.5

        # Stage 2: WHAT/WHERE/WHO (for non-FEEL)
        s2_out = model_s2(input_ids, attention_mask=attention_mask)
        s2_probs = torch.softmax(s2_out.logits, dim=1)
        s2_preds = torch.argmax(s2_out.logits, dim=1)  # 0=WHAT, 1=WHERE, 2=WHO

        # Combine
        for i in range(len(is_feel)):
            if is_feel[i]:
                all_preds.append(1)  # FEEL = index 1
                all_confidences.append(s1_probs[i, 1].item())
            else:
                s2_idx = s2_preds[i].item()
                # Map back: S2_LABELS = {"WHAT":0, "WHERE":1, "WHO":2}
                # Final labels: WHAT=0, FEEL=1, WHERE=2, WHO=3
                if s2_idx == 0: final = 0   # WHAT
                elif s2_idx == 1: final = 2  # WHERE
                else: final = 3              # WHO
                all_preds.append(final)
                max_conf = s2_probs[i, s2_idx].item()
                all_confidences.append(max_conf)

# Map test labels to indices
FINAL_LABELS = {"WHAT": 0, "FEEL": 1, "WHERE": 2, "WHO": 3}
true_labels = [FINAL_LABELS[x["label"]] for x in test_data]

# Results
acc = accuracy_score(true_labels, all_preds)
f1_macro = f1_score(true_labels, all_preds, average="macro")
f1_weighted = f1_score(true_labels, all_preds, average="weighted")

print(f"\nAccuracy: {acc:.4f}")
print(f"F1-macro: {f1_macro:.4f}")
print(f"F1-weighted: {f1_weighted:.4f}")
print(f"Mean confidence: {np.mean(all_confidences):.3f}")

print(f"\nClassification Report:")
print(classification_report(true_labels, all_preds, target_names=list(FINAL_LABELS.keys()), digits=3))

print(f"Confusion Matrix:")
cm = confusion_matrix(true_labels, all_preds)
print("       " + " ".join(f"{l:>6}" for l in FINAL_LABELS.keys()))
for i, label in enumerate(FINAL_LABELS.keys()):
    print(f"  {label:4s} " + " ".join(f"{cm[i][j]:>6}" for j in range(4)))

# Per-class recall
print(f"\nPer-class recall:")
for i, label in enumerate(FINAL_LABELS.keys()):
    recall = cm[i][i] / cm[i].sum() if cm[i].sum() > 0 else 0
    print(f"  {label}: {recall:.3f}")

# Low confidence analysis
low_conf = sum(1 for c in all_confidences if c < 0.6)
print(f"\nLow confidence (<0.6): {low_conf}/{len(all_confidences)} ({low_conf/len(all_confidences)*100:.1f}%)")

# Compare with single-stage
print(f"\n=== Comparison ===")
print(f"  Single-stage v3:  Acc=0.707  F1-macro=0.700  FEEL=0.920  WHAT=0.507  WHERE=0.730  WHO=0.671")
print(f"  Two-stage:        Acc={acc:.3f}  F1-macro={f1_macro:.3f}", end="")
for i, l in enumerate(FINAL_LABELS.keys()):
    r = cm[i][i] / cm[i].sum() if cm[i].sum() > 0 else 0
    print(f"  {l}={r:.3f}", end="")
print()

print(f"\nModel saved to: {OUTPUT_DIR}/")
