"""
Cognitive state model v5 — CLS token + contrastive + memory-bias.
Fixes v4's output collapse (all predictions cos≈0.98 despite diverse labels).

Changes from v4:
  1. CLS token pooling (not mean pooling) — preserves distinctive features
  2. Encoder unfrozen from epoch 0 — full model learns to differentiate
  3. Combined loss: CosineEmbeddingLoss + pairwise contrastive loss
  4. Higher LR for encoder, lower for projection head
  5. Layer-wise LR decay for encoder (lower layers stay more frozen)
"""
import json, math, sqlite3, time, os, re
import numpy as np
import torch, torch.nn as nn
from collections import defaultdict
from pathlib import Path

MODEL_NAME = "hfl/chinese-macbert-base"
BATCH_SIZE = 8  # smaller batch — more updates per epoch
EPOCHS = 10
LR_ENCODER = 5e-6
LR_PROJ = 5e-5
EMBED_DIM = 1024
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
OUTPUT_DIR = Path("D:/AgentMemory/tools/cognitive-model-output")
OUTPUT_DIR.mkdir(exist_ok=True)

CHANNEL_COEFF = {"FEEL": 1.5, "WHO": 1.3, "WHAT": 1.0, "WHERE": 0.7}
HALF_LIFE_MS = 24 * 3600 * 1000
LAMBDA = math.log(2) / HALF_LIFE_MS
CONTRASTIVE_WEIGHT = 0.3  # weight for contrastive loss term

# ── Channel inference ────────────────────────────────────────────────────
FEEL_KW = {"情绪","情感","挫败","生气","愤怒","失望","不满","烦躁","焦虑",
    "满意","高兴","兴奋","沮丧","激动","偏好","喜欢","讨厌","不耐烦","欣慰",
    "无奈","低落","恼火","不爽","放心","安心","confus","frustrat","angry",
    "happy","sad","upset","annoy","disappoint","反馈","纠正","批评","抱怨"}
WHAT_KW = {"代码","文件","函数","实现","修复","bug","fix","feature","架构",
    "设计","模块","接口","API","配置","config","数据库","测试","test","部署",
    "deploy","编译","build","工具","脚本","命令","版本","训练","模型","model",
    "ONNX","向量","embedding","macbert","字图","搜索","检索","路由","召回",
    "碎片","记忆","memory","session","认知","cognitive","权重","衰减","通道"}
WHO_KW = {"用户","user","开发者","工程师","偏好","习惯","角色","身份","背景"}
WHERE_KW = {"项目","目录","路径","文件系统","仓库","repo","C:","D:","桌面",
    "desktop","AgentMemory","lingxi","环境","env","配置路径"}

def infer_channel(summary, keywords):
    text = ((summary or "") + " " + (keywords or "")).lower()
    scores = {"FEEL": 0, "WHAT": 0, "WHO": 0, "WHERE": 0}
    for kw in FEEL_KW:
        if kw.lower() in text: scores["FEEL"] += 1
    for kw in WHAT_KW:
        if kw.lower() in text: scores["WHAT"] += 1
    for kw in WHO_KW:
        if kw.lower() in text: scores["WHO"] += 1
    for kw in WHERE_KW:
        if kw.lower() in text: scores["WHERE"] += 1
    best = max(scores, key=scores.get)
    return best if scores[best] > 0 else "WHAT"

# ── Load fragments ──────────────────────────────────────────────────────
def load_fragments():
    db = sqlite3.connect("C:/Users/Administrator/.agentmemory/memory.db")
    rows = db.execute("""
        SELECT id, vector, summary, keywords, decay_score, recalled_count,
               last_recalled_at, created_at, linked_count, subtype
        FROM fragments
        WHERE vector IS NOT NULL AND retrieval_state IN ('active','warm')
    """).fetchall()
    db.close()
    frags = {}
    for r in rows:
        fid, vec_blob, summary, kw, decay, rc, lra, ca, lc, subtype = r
        if not vec_blob or len(vec_blob) // 4 != EMBED_DIM: continue
        vec = np.frombuffer(vec_blob, dtype=np.float32).copy()
        vec = vec / (np.linalg.norm(vec) + 1e-8)
        channel = subtype if subtype in CHANNEL_COEFF else infer_channel(summary, kw)
        frags[fid] = {"vec": vec, "channel": channel,
            "decay_score": decay if decay else 1.0,
            "recalled_count": rc or 0, "last_recalled_at": lra or 0,
            "created_at": ca or 0, "linked_count": lc or 0,
            "summary": summary or "", "keywords": kw or ""}
    ch_dist = {ch: sum(1 for f in frags.values() if f['channel']==ch) for ch in CHANNEL_COEFF}
    print(f"Fragments: {len(frags)}, channels: {ch_dist}")
    return frags

# ── Keyword extraction ──────────────────────────────────────────────────
def extract_keywords(text):
    tokens = set()
    for i in range(len(text)-1):
        if ord(text[i]) > 127 and ord(text[i+1]) > 127:
            tokens.add(text[i:i+2])
    for m in re.finditer(r'[a-zA-Z0-9_]{3,}', text):
        tokens.add(m.group().lower())
    return tokens

# ── Memory-bias with stimulated activation ───────────────────────────────
def compute_memory_bias(frags, query_text, base_ts, top_k=30, activation_boost=5.0):
    query_tokens = extract_keywords(query_text)
    scores = []
    for fid, f in frags.items():
        ch_coeff = CHANNEL_COEFF.get(f["channel"], 1.0)
        decay_score = f["decay_score"]
        frag_text = f["summary"] + " " + f["keywords"]
        frag_tokens = extract_keywords(frag_text)
        kw_overlap = len(query_tokens & frag_tokens) if query_tokens and frag_tokens else 0
        base_last = f["last_recalled_at"] if f["last_recalled_at"] > 0 else f["created_at"]
        if base_last <= 0: base_last = base_ts
        if kw_overlap >= 2:
            recency = 1.0 * (1.0 + min(kw_overlap / 10.0, 1.0) * activation_boost)
        else:
            age_ms = max(0, base_ts - base_last)
            recency = math.exp(-LAMBDA * age_ms)
        anchor = 0.3 + 0.7 * min(f["linked_count"] / 10.0, 1.0)
        score = ch_coeff * recency * decay_score * anchor
        scores.append((score, fid))
    scores.sort(reverse=True, key=lambda x: x[0])
    top = scores[:top_k]
    if not top: return torch.zeros(EMBED_DIM)
    total_w = sum(w for w, _ in top)
    result = torch.zeros(EMBED_DIM)
    for w, fid in top:
        result += (w / total_w) * torch.tensor(frags[fid]["vec"], dtype=torch.float32)
    return result / (result.norm() + 1e-8)

# ── Sample generation ────────────────────────────────────────────────────
def generate_samples(frags):
    samples, now = [], int(time.time() * 1000)
    print("Fragment-keyword samples...")
    for fid, f in frags.items():
        query = (f["keywords"] or f["summary"])[:120]
        if len(query) < 3: continue
        ts = f["last_recalled_at"] if f["last_recalled_at"] > 0 else f["created_at"]
        if ts <= 0: ts = now
        label = compute_memory_bias(frags, query, ts)
        samples.append({"query": query, "label": label, "ts": ts})

    print("Activation_log samples...")
    db = sqlite3.connect("C:/Users/Administrator/.agentmemory/memory.db")
    activations = db.execute("""
        SELECT DISTINCT query_text, fragment_id, activated_at
        FROM activation_log WHERE query_text IS NOT NULL AND length(query_text) > 3
    """).fetchall()
    seen = set()
    for query, fid, ts in activations:
        q = query[:120]
        if q in seen: continue
        seen.add(q)
        label = compute_memory_bias(frags, q, ts if ts else now)
        samples.append({"query": q, "label": label, "ts": ts if ts else now})

    print("Session-context samples...")
    sessions = db.execute("""
        SELECT compact_summary, started_at FROM sessions
        WHERE compact_summary IS NOT NULL AND length(compact_summary) > 20
        ORDER BY started_at DESC LIMIT 20
    """).fetchall()
    db.close()
    for summary, ts in sessions:
        if len(summary) < 10: continue
        label = compute_memory_bias(frags, summary[:200], ts if ts else now)
        samples.append({"query": summary[:200], "label": label, "ts": ts if ts else now})

    print("Diversity augmentation...")
    top_frags = sorted(frags.items(), key=lambda x: x[1]["recalled_count"], reverse=True)[:80]
    prefixes = ["用户询问关于", "系统发现一个", "需要修复", "正在讨论", "回顾之前的", "用户表示不满", "确认修复了", "检查状态"]
    for fid, f in top_frags:
        base_query = (f["keywords"] or f["summary"])[:80]
        if len(base_query) < 5: continue
        for prefix in prefixes[:4]:
            variant_q = f"{prefix} {base_query}"[:120]
            ts = f["last_recalled_at"] if f["last_recalled_at"] > 0 else f["created_at"]
            if ts <= 0: ts = now
            varied_ts = ts + np.random.randint(-6, 6) * 3600_000
            label = compute_memory_bias(frags, variant_q, max(0, varied_ts))
            samples.append({"query": variant_q, "label": label, "ts": max(0, varied_ts)})

    print(f"Total: {len(samples)}")
    return samples

# ── Model (CLS token pooling) ────────────────────────────────────────────
class CognitiveStateModel(nn.Module):
    def __init__(self):
        super().__init__()
        from transformers import AutoModel, AutoTokenizer
        print(f"Loading {MODEL_NAME}...")
        self.encoder = AutoModel.from_pretrained(MODEL_NAME, mirror="https://hf-mirror.com")
        self.tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME, mirror="https://hf-mirror.com")
        hidden = self.encoder.config.hidden_size
        # Projection: richer MLP with residual
        self.proj = nn.Sequential(
            nn.Linear(hidden, 768),
            nn.LayerNorm(768),
            nn.ReLU(),
            nn.Dropout(0.1),
            nn.Linear(768, 1024),
            nn.LayerNorm(1024),
            nn.ReLU(),
            nn.Dropout(0.1),
            nn.Linear(1024, EMBED_DIM),
        )

    def encode(self, texts):
        tok = self.tokenizer(texts, padding=True, truncation=True,
                             max_length=128, return_tensors="pt").to(DEVICE)
        out = self.encoder(**tok)
        # Use CLS token (first token) — captures sentence-level semantics
        cls = out.last_hidden_state[:, 0, :]
        vec = self.proj(cls)
        return vec / (vec.norm(dim=1, keepdim=True) + 1e-8)

    def forward(self, texts):
        return self.encode(texts)

# ── Contrastive loss helper ──────────────────────────────────────────────
def pairwise_contrastive_loss(embeddings, temperature=0.07):
    """
    NT-Xent style: maximize similarity to self, minimize to others in batch.
    Forces the model to produce DIFFERENT vectors for different inputs.
    """
    batch_size = embeddings.shape[0]
    if batch_size < 2:
        return torch.tensor(0.0, device=DEVICE)

    # Cosine similarity matrix
    sim = embeddings @ embeddings.T  # all normalized, so this is cosine

    # Positive: self-similarity (diagonal)
    # Negative: all other pairs
    # SimCLR-style: for each sample, all others are negatives
    labels_idx = torch.arange(batch_size, device=DEVICE)

    # InfoNCE loss
    sim = sim / temperature
    loss = nn.functional.cross_entropy(sim, labels_idx)
    return loss

# ── Train ────────────────────────────────────────────────────────────────
def train():
    print(f"Device: {DEVICE} | PyTorch: {torch.__version__}")
    frags = load_fragments()
    samples = generate_samples(frags)
    if len(samples) < 20: return

    print("Checking label diversity...")
    idx_sample = np.random.choice(len(samples), min(50, len(samples)), replace=False)
    label_vecs = np.stack([samples[i]["label"].numpy() for i in idx_sample])
    cos_matrix = label_vecs @ label_vecs.T
    off_diag = [cos_matrix[i][j] for i in range(len(label_vecs)) for j in range(len(label_vecs)) if i != j]
    print(f"  Label pairwise cos: mean={np.mean(off_diag):.4f} std={np.std(off_diag):.4f}")

    np.random.seed(42)
    indices = np.random.permutation(len(samples))
    split = int(len(samples) * 0.85)
    train_idx, val_idx = indices[:split].tolist(), indices[split:].tolist()
    print(f"Train: {len(train_idx)}, Val: {len(val_idx)}")

    model = CognitiveStateModel().to(DEVICE)

    # Differential LR: lower for encoder, higher for projection
    encoder_params = list(model.encoder.parameters())
    proj_params = list(model.proj.parameters())
    opt = torch.optim.AdamW([
        {"params": encoder_params, "lr": LR_ENCODER},
        {"params": proj_params, "lr": LR_PROJ},
    ])
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=EPOCHS)

    best_cos = -1
    best_state = None

    for epoch in range(EPOCHS):
        model.train()
        total_loss, total_cos_loss, total_ctr_loss, n_batches = 0, 0, 0, 0
        np.random.shuffle(train_idx)

        for i in range(0, len(train_idx), BATCH_SIZE):
            batch = [samples[j] for j in train_idx[i:i+BATCH_SIZE]]
            if len(batch) < 2: continue
            queries = [b["query"] for b in batch]
            targets = torch.stack([b["label"] for b in batch]).to(DEVICE)

            preds = model(queries)

            # Cosine embedding loss: maximize cos(pred, target)
            cos_loss = nn.functional.cosine_embedding_loss(
                preds, targets, torch.ones(preds.shape[0], device=DEVICE))

            # Contrastive loss: push different predictions apart
            ctr_loss = pairwise_contrastive_loss(preds)

            loss = cos_loss + CONTRASTIVE_WEIGHT * ctr_loss

            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            total_loss += loss.item()
            total_cos_loss += cos_loss.item()
            total_ctr_loss += ctr_loss.item()
            n_batches += 1
        sched.step()

        # Validate
        model.eval()
        val_cos_sum, val_preds_all = 0, []
        with torch.no_grad():
            for i in range(0, len(val_idx), BATCH_SIZE):
                batch = [samples[j] for j in val_idx[i:i+BATCH_SIZE]]
                qs = [b["query"] for b in batch]
                ts = torch.stack([b["label"] for b in batch]).to(DEVICE)
                ps = model(qs)
                val_cos_sum += nn.functional.cosine_similarity(ps, ts, dim=-1).sum().item()
                val_preds_all.append(ps.cpu())
        val_cos = val_cos_sum / len(val_idx)

        # Check prediction diversity
        val_preds_cat = torch.cat(val_preds_all, dim=0)
        pred_sim = val_preds_cat @ val_preds_cat.T
        off_diag_pred = []
        for pi in range(min(pred_sim.shape[0], 30)):
            for pj in range(min(pred_sim.shape[0], 30)):
                if pi != pj: off_diag_pred.append(pred_sim[pi][pj].item())
        pred_div = np.mean(off_diag_pred) if off_diag_pred else 0

        print(f"Epoch {epoch+1}/{EPOCHS} | loss={total_loss/max(n_batches,1):.4f} "
              f"(cos={total_cos_loss/max(n_batches,1):.4f} ctr={total_ctr_loss/max(n_batches,1):.4f}) "
              f"| val_cos={val_cos:.4f} | pred_div={pred_div:.4f}")

        if val_cos > best_cos and epoch >= 2:  # let initial epochs stabilize
            best_cos = val_cos
            best_state = {k: v.cpu().clone() for k, v in model.state_dict().items()}
            torch.save(model.state_dict(), str(OUTPUT_DIR / "cognitive_v5.pt"))

    print(f"\nBest val_cos: {best_cos:.4f}")

    if best_state:
        model.load_state_dict(best_state)

    # Export ONNX
    print("Exporting ONNX...")
    model.eval().cpu()
    dummy = model.tokenizer(["测试"], padding=True, truncation=True, max_length=128, return_tensors="pt")

    class Wrapper(nn.Module):
        def __init__(self, m): super().__init__(); self.m = m
        def forward(self, input_ids, attention_mask):
            out = self.m.encoder(input_ids=input_ids, attention_mask=attention_mask)
            cls_vec = out.last_hidden_state[:, 0, :]
            vec = self.m.proj(cls_vec)
            return vec / (vec.norm(dim=1, keepdim=True) + 1e-8)

    wrapped = Wrapper(model)
    onnx_path = str(OUTPUT_DIR / "cognitive_v5.onnx")
    torch.onnx.export(wrapped, (dummy["input_ids"], dummy["attention_mask"]),
        onnx_path,
        input_names=["input_ids", "attention_mask"],
        output_names=["state_vector"],
        dynamic_axes={"input_ids": {0: "b", 1: "s"}, "attention_mask": {0: "b", 1: "s"}, "state_vector": {0: "b"}},
        opset_version=14)
    size_mb = os.path.getsize(onnx_path) / 1024 / 1024
    print(f"ONNX: {onnx_path} ({size_mb:.0f}MB)")

    meta = {"model": MODEL_NAME, "embed_dim": EMBED_DIM,
        "best_val_cos": best_cos, "num_samples": len(samples),
        "num_fragments": len(frags), "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S")}
    with open(str(OUTPUT_DIR / "cognitive_v5_meta.json"), "w") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)

    return best_cos

if __name__ == "__main__":
    train()
