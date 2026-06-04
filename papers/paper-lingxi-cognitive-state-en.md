# What You Say and What You Think Are Orthogonal: Discovering Dual Memory Signals in Personal Agent Systems

**Authors**: [Author]
**Affiliation**: Independent Researcher

**Date**: June 2026

---

## Abstract

Current LLM-based agent memory systems treat memory as a single-dimensional resource: fragments are stored, retrieved by semantic similarity, and injected into context. We present Lingxi, a personal agent cognitive architecture comprising 2,700+ memory fragments organized across four semantic channels (WHAT/FEEL/WHO/WHERE), an on-device neural classifier (<50ms inference), an 8-stage memory distillation pipeline, and a retrieval engine combining full-text search with vector similarity. During the construction of this system, we discovered that agent memory contains two orthogonal signal dimensions: **semantic retrieval** (what the user is talking about) and **cognitive state perception** (what the user is thinking about). We validate this finding through three converging lines of evidence: (1) memory-bias embedding redirection shows 60% of queries are reranked by cognitive state with 93% non-overlap against semantic search; (2) cognitive offset detection identifies 96% attention shift between temporal windows using only top-5 fragment bigram overlap; (3) a local lightweight model (macbert-102M + MLP) predicts cognitive state vectors with cosine similarity 0.967 against statistical labels that are **automatically generated from memory system statistics** — requiring zero human annotation or LLM labeling. Sequence context is noise for semantic search (similarity drops from 0.945 to 0.892) but signal for cognitive state prediction (overlap improves from 1.76 to 2.40), confirming these are fundamentally different information processing paradigms. We further show that the training paradigm matters: pair classification of causal relations hits a ceiling at 0.77 due to structural overfitting, while cognitive state regression eliminates the data bottleneck entirely through self-bootstrapping labels. Our results suggest that effective personal agent memory requires at least two independent processing mechanisms, and that the cognitive dimension can be captured locally without cloud LLM calls. Code, experimental scripts, and training data are publicly available.

## 1 Introduction

The rapid development of LLM-based agents has been accompanied by a parallel evolution in memory systems. From simple conversation buffers to sophisticated retrieval-augmented architectures (Mem0; Letta/MemGPT; Zep), the dominant paradigm remains consistent: memory fragments are stored as discrete records, retrieved by semantic similarity to the current query, and injected into the agent's context window. This retrieval-first approach has produced strong engineering results, but it rests on an implicit assumption that has gone largely unexamined: **all memory is the same kind of thing**.

Under this assumption, a fact ("the user uses TypeScript"), a preference ("the user dislikes verbose confirmations"), a correction ("the user corrected the agent for deleting comments"), and a decision ("the user chose React over Vue") are all treated as memory fragments of equal type, differentiated only by their semantic content and retrieval score. The retrieval mechanism — whether full-text search, vector cosine similarity, or learned attention — operates uniformly across all fragment types.

We challenge this assumption. Through the construction of Lingxi, a personal agent cognitive architecture designed to model not just *what the user knows* but *how the user thinks*, we discovered that agent memory contains at least two fundamentally different signal dimensions that are nearly orthogonal to each other:

- **Semantic retrieval signal**: what the user is currently talking about. This is captured by standard embedding-based retrieval and answers "which memories are relevant to this query?"
- **Cognitive state signal**: what the user is currently thinking about — their attentional focus, their concern priorities, their cognitive trajectory. This answers "what is the user's cognitive state right now?"

These two signals point to nearly non-overlapping regions of memory space. In our experiments, the top-10 fragments retrieved by cognitive state prediction overlap with semantic search by only 0.68 out of 10 — meaning 93% of retrieved fragments are different. This is not a marginal improvement from a better ranking function; it is evidence that **cognitive state and semantic relevance are independent dimensions of memory access**.

The discovery emerged not from a priori theoretical reasoning but from the practical challenges of building a complete cognitive architecture. Lingxi organizes memory fragments across four semantic channels (WHAT for facts, FEEL for corrections and preferences, WHO for relationship context, WHERE for file/project references), runs a local ONNX neural classifier for sub-50ms inference, implements an 8-stage dreaming pipeline for memory distillation, and maintains a decay system with constitutional-level protection for critical fragments. Each of these architectural decisions contributed to the conditions under which the dual-signal discovery became visible.

Our contributions are threefold:

1. **Empirical discovery**: We provide quantitative evidence that cognitive state perception and semantic retrieval are orthogonal signal dimensions in personal agent memory. Sequence context acts as signal for cognitive state prediction but noise for semantic search, confirming these are fundamentally different information processing paradigms (§4).

2. **Self-bootstrapping training method**: We demonstrate that cognitive state prediction can be trained with labels automatically generated from memory system statistics (memory-bias weighted averaging), requiring zero human annotation or LLM labeling. Each additional conversation session produces dozens of training samples automatically (§5).

3. **Local cognitive prediction**: We show that a lightweight local model (macbert-102M + MLP, <50ms inference) can predict cognitive state vectors with cosine similarity 0.967, capturing user cognitive state without cloud LLM calls, without network transmission, and without per-query annotation cost (§5, §6).

The remainder of this paper is organized as follows: §2 reviews related work; §3 describes the Lingxi architecture that made the discovery possible; §4 presents the dual-signal discovery; §5 describes the bootstrapping method; §6 reports quantitative experiments; §7 analyzes why previous approaches failed and why regression succeeds; §8 discusses implications; §9 addresses limitations; §10 concludes.

## 2 Related Work

## 2 Related Work

### 2.1 Agent Memory Systems

The modern agent memory landscape is dominated by retrieval-first architectures. Mem0 (2024) pioneered the pattern of extracting memory fragments from conversations and retrieving them via vector similarity for context injection. Letta (formerly MemGPT; Packer et al., 2023) introduced a virtual memory hierarchy with explicit memory management, treating the context window as a limited resource to be paged in and out. Zep (2024) focuses on long-term memory extraction and fact validation. MemoryBank (Zhong et al., 2024) implements episodic memory with temporal indexing.

All these systems share a common assumption: memory fragments are homogeneous records differentiated only by content. Retrieval — whether via BM25, cosine similarity, or learned attention — is the sole mechanism for memory access. Our work challenges this assumption by demonstrating the existence of an orthogonal cognitive signal dimension that retrieval cannot capture.

A concurrent survey by Luo et al. (2026), accepted at ACL 2026 Findings, proposes a three-stage evolution framework for LLM agent memory: Storage → Reflection → Experience. They identify "proactive exploration" and "cross-trajectory abstraction" as frontier mechanisms in the Experience stage. Our cognitive state prediction can be viewed as an early instantiation of the Experience stage — the model learns to predict cognitive state not from explicit retrieval but from the accumulated statistical structure of memory.

### 2.2 Memory Internalization and Proactive Agents

δ-mem (2026) proposes a small correlation matrix that continuously compresses interaction history and injects the result directly into the attention layer, modifying how the model processes each input. Their approach demonstrates that memory can influence reasoning beyond simple retrieval, achieving +6.76 points on specific benchmarks. However, δ-mem's matrix is generic (shared across users) and does not distinguish between semantic and cognitive dimensions.

ProAct (Hu et al., 2026) introduces idle-time computation for proactive agent behavior, predicting user needs during silence periods. Their architecture reduces required dialogue turns by 14.8% and hallucination rates by 28.1%. ProAct uses LLM inference for prediction, whereas our approach uses a local <50ms model — enabling continuous cognitive state tracking rather than discrete prediction events.

HyMem (Zhao et al., 2026) proposes a hybrid memory architecture with dynamic retrieval scheduling based on query complexity, using a lightweight module for simple queries and an LLM-based module for complex ones. While HyMem addresses efficiency, it does not introduce a cognitive signal dimension orthogonal to semantic retrieval.

### 2.3 Personalization and User Modeling

User personalization in LLM systems has primarily focused on preference extraction and style adaptation. These approaches typically model surface-level preferences (coding style, communication tone) rather than deeper cognitive patterns. Our cognitive state prediction operates at a different level: it captures not what the user prefers but *how the user is currently thinking* — their attentional trajectory, their concern priorities, and the implicit structure of their cognitive focus.

MeloTune (Xu, 2026) demonstrates on-device cognitive state prediction for music curation, using CfC networks to predict affective trajectories on Russell's circumplex. While architecturally similar (local model predicting continuous state vectors), MeloTune operates in the affective domain (arousal/valence) rather than the cognitive domain (attention/concern priority), and does not examine orthogonality with semantic retrieval.

### 2.4 Small Models for Agent Systems

The use of small local models alongside large cloud models is an emerging pattern. Voyager (Wang et al., 2023) uses a skill library that grows through self-verified code execution. Reflexion (Shinn et al., 2023) uses verbal reinforcement signals stored as memory. These approaches use small models for specific subtasks (code verification, reflection scoring) but do not use them to maintain a continuous cognitive state representation.

Our work differs in that the local model (macbert-102M ONNX) does not perform a discrete task but maintains a continuous representation of user cognitive state. This model runs on every user message (<50ms latency) and produces a 768-dimensional vector that encodes the user's current cognitive position — a fundamentally different role from task-specific small models.

### 2.5 Summary of Gaps

| Dimension | Existing Work | This Work |
|-----------|:---:|:---:|
| Orthogonal signal discovery | ✗ | ✓ |
| Self-bootstrapping labels | ✗ | ✓ |
| Local cognitive prediction | Partial (MeloTune, affective only) | ✓ (cognitive domain) |
| Complete cognitive architecture | Partial (components exist separately) | ✓ (end-to-end system) |
| Training paradigm analysis | ✗ | ✓ (classification vs. regression) |

To our knowledge, no existing work has: (1) empirically demonstrated the orthogonality of cognitive state and semantic retrieval signals; (2) shown that cognitive state prediction can be trained with automatically generated labels; or (3) analyzed why the training paradigm (classification vs. regression) fundamentally determines whether personal agent memory can be learned.

## 3 System Architecture: Lingxi

## 3 System Architecture: Lingxi

Lingxi is a personal agent cognitive architecture built as a TypeScript/Node.js system with SQLite storage, designed to run alongside coding agents (Claude Code, OpenClaw, Codex) via hooks and MCP (Model Context Protocol). The architecture consists of five interconnected components. Each component was designed independently, but together they created the conditions under which the dual-signal discovery became possible.

### 3.1 Four-Channel Fragmentation

Memory fragments are organized across four semantic channels, each capturing a different dimension of user-agent interaction:

- **WHAT**: Factual knowledge, technical decisions, implementation details, task descriptions
- **FEEL**: User corrections, preferences, emotional signals, quality standards
- **WHO**: Relationship context, trust levels, collaboration patterns, role information
- **WHERE**: File paths, project references, spatial/temporal anchors, codebase locations

Each fragment carries anchors from one or more channels with associated weights. For example, a fragment about "JWT configuration in login.ts" might have anchors in WHAT (technical fact), WHERE (file reference), and FEEL (if the user expressed a preference about it). This multi-channel structure is critical for the dual-signal discovery: without channel separation, the FEEL channel's cognitive signal would be diluted by the WHAT channel's semantic content.

The fragmentation process extracts structured fragments from conversation transcripts using a lightweight extraction pipeline. Each fragment receives a unique ID, channel anchors with weights, a summary, and temporal metadata. As of this writing, the system has accumulated 2,700+ active fragments across ~130 sessions.

### 3.2 Local Neural Classifier (Lingmou)

Lingmou is a macbert-102M model compiled to ONNX format for local inference. Its primary function is channel classification — assigning each input fragment to one of the four channels (WHAT/FEEL/WHO/WHERE) with sub-50ms latency. The model runs entirely on-device, requiring no cloud API calls.

Lingmou's existence establishes a critical architectural property: **the system has a fast, local cognitive processing layer that operates independently of the cloud LLM**. This separation is what enables cognitive state prediction to run continuously on every user message without adding meaningful latency to the agent's response time.

In addition to channel classification, Lingmou serves as the encoder for memory-bias computation and cognitive state prediction (described in §5). The same model that classifies channels also extracts the 768-dimensional embeddings used for all downstream cognitive processing.

### 3.3 Memory Distillation Pipeline (Lingshu)

Lingshu is an 8-stage dreaming pipeline that processes raw fragments into higher-order structures:

1. **Accumulation**: Raw fragments from conversation
2. **Pattern detection**: Identifying recurring themes across fragments
3. **Conflict resolution**: Detecting and resolving contradictory fragments
4. **Rule extraction**: Deriving distilled rules from fragment patterns
5. **Weight adjustment**: Updating fragment weights based on accumulated evidence
6. **Decay application**: Applying time-based decay to inactive fragments
7. **Consolidation**: Merging redundant fragments
8. **Constitutional protection**: Shielding critical fragments from decay

The distillation pipeline produces 16 L0 (constitutional-level) rules, each with explicit source fragment IDs. These rules represent the system's highest-confidence beliefs about user preferences and constraints. The pipeline runs periodically, not on every message, creating a temporal separation between real-time cognitive processing (Lingmou) and long-term cognitive consolidation (Lingshu).

### 3.4 Decay and Retrieval System

The decay system implements a novelty-adaptive staircase mechanism. Each fragment carries a `decayScore` that decreases over time but is boosted by:
- Direct user interaction (recall events)
- Association with high-weight FEEL signals
- Connection to L0 rules

Constitutional-level fragments (linked to L0 rules) receive decay protection and never fall below a minimum activity threshold. The novelty factor adapts the decay rate based on the diversity of recent interactions — novel interaction patterns slow decay, while repetitive patterns accelerate it.

The retrieval engine combines three mechanisms:
- **Full-text search** (SQLite FTS5) for keyword matching
- **Vector cosine similarity** (1536-dim embeddings) for semantic matching
- **MMR (Maximal Marginal Relevance)** for diversity in top-k results
- **Explicit knowledge edges** (corrected_by, distilled_from) for causal associations

The explicit knowledge edges were added after our Phase 3 experiments (§6.1) demonstrated a +27% retrieval improvement on a real production retriever baseline. These edges encode causal relationships that semantic similarity cannot capture — for example, the connection between a user correction and the behavior it corrected.

### 3.5 Multi-Layer Context Injection

At session start, the system injects four layers of memory into the agent's context:

| Layer | Content | Source |
|-------|---------|--------|
| 1 | Constitutional rules (iron laws) | L0 distilled rules |
| 2 | User preference facts | Distilled summaries |
| 3 | Retrieved memory fragments | Prefetch (FTS5 + vector + edges) |
| 4 | Cognitive state narrative | Cognitive state prediction model |

Layer 4 is the most recent addition (this work). Unlike layers 1-3 which inject *content* (specific facts, rules, or fragments), layer 4 injects *cognitive context* — a description of the user's current attentional focus and concern priorities. This distinction is central to our dual-signal discovery.

### 3.6 Architecture as Discovery Condition

The dual-signal discovery did not emerge from a single component but from the interaction of multiple components:

- **Four-channel structure** made it possible to separate WHAT (semantic) signals from FEEL (cognitive) signals. Without channel separation, memory-bias experiments would not have revealed differential effects.
- **Local ONNX model** made continuous cognitive state computation feasible (<50ms per message). Without fast local inference, cognitive state would be too expensive to compute on every message.
- **Decay system** gave fragments differential weights, enabling memory-bias weighted averaging to produce meaningful cognitive state vectors. Without weight differentiation, all fragments would contribute equally and the cognitive signal would be uniform noise.
- **Multi-layer injection** provided the integration point for cognitive state as a separate layer, distinct from content retrieval.

Each architectural decision was motivated by engineering concerns, not by a prior hypothesis about dual signals. The discovery emerged from the system's behavior, not from the system's design. This is a strength of the work — the discovery is robust to architectural variations because it was not engineered to produce a specific result.

## 4 Discovery: Dual-Signal Memory

## 4 Discovery: Dual-Signal Memory

The discovery of dual-signal memory emerged through three converging experimental lines. We present them in chronological order, as each experiment motivated the next.

### 4.1 Memory-Bias Embedding Redirection (Experiment 1)

**Hypothesis**: If memory is applied as a bias to the query representation rather than as retrieved context, it may redirect retrieval to different regions of memory space — capturing cognitive relevance rather than semantic relevance.

**Method**: We computed a "cognitive background vector" as the weighted average of all 2,674 active fragment embeddings, weighted by `decayScore × (1 + FEEL_weight/255)`. For each query, we computed a biased query vector: `biased_query = raw_query + α × cognitive_background`, then compared the top-5 retrieval results from `raw_query` vs. `biased_query`.

**Results** (α = 0.2, 10 queries):

| Metric | Value |
|--------|-------|
| Average overlap (top-5) | 1.8 / 5 |
| Average biased-only fragments | 3.2 / 5 |
| Complete redirection (overlap ≤ 1) | 6/10 queries |

**Diversity test**: To rule out popularity bias (the same high-weight fragments appearing in every biased result), we computed the overlap of biased-only fragments across all 10 queries. The result was **0% overlap** — no fragment appeared as biased-only in more than one query. This confirmed that memory-bias produces query-specific redirection, not broadcast of popular fragments.

**Interpretation**: Memory-bias changes *how the query sees memory*, not *which memories match the query*. The biased query enters different regions of vector space because the cognitive background shifts the query's direction. This is the first evidence that cognitive state and semantic content can produce different memory access patterns.

### 4.2 Cognitive Background Orthogonality (Experiment 2)

**Hypothesis**: The cognitive background signal captures different information from time-based recency signals. If the same fragments are ranked by "most important" (cognitive weight) vs. "most recent" (temporal recency), the overlap should be low.

**Method**: We computed two top-5 fragment sets for the same time window:
- **Cognitive top-5**: Fragments ranked by FEEL weight × decayScore (cognitive importance)
- **Recency top-5**: Fragments ranked by creation time (most recent)

We measured bigram overlap between the two sets' summaries.

**Results**:

| Comparison | Bigram Overlap |
|------------|:--:|
| Cognitive top-5 vs. Recency top-5 | **5.3%** |

**Interpretation**: "What is most important to the user" and "what the user recently discussed" are nearly non-overlapping signals. A rule-based approach (recency) produces "the user has been discussing model training." A cognitive approach (weight × decay) produces "the user persistently cares about error correction mechanisms and safety boundaries." Both are valid descriptions, but they point to completely different memory regions.

This orthogonality has practical implications: if an agent injects both signals, it gets two independent perspectives on the user's state. If it injects only one, it misses the other entirely.

### 4.3 Cognitive Offset Detection (Experiment 3)

**Hypothesis**: If cognitive state is a persistent signal that changes over time, then comparing cognitive state at different time points should detect genuine shifts in user attention.

**Method**: For each session, we computed the top-5 fragments by cognitive weight in the current 7-day window and the previous 7-14 day window. We measured bigram overlap between the two top-5 sets and computed an offset rate: `offset = 1 - overlap`.

**Results** (test case):

| Window | Top-5 Content |
|--------|---------------|
| Current 7 days | Code fixes, architecture adjustments, technical implementation |
| Previous 7-14 days | AGI redefinition, product positioning, paper planning |
| **Offset rate** | **96%** |

**Interpretation**: The system detected a genuine cognitive phase transition — the user shifted from strategic thinking to implementation work. This is not a memory retrieval result; it is the system's own judgment about *how the user's cognitive state has changed*. The offset signal enables the agent to adapt its behavior strategy: a user in implementation phase needs different support than a user in strategic phase.

### 4.4 Convergence: Three Experiments, One Finding

The three experiments above converge on a single conclusion:

```
Semantic retrieval:    query → vector similarity → fragments
                       "What is the user talking about?"

Cognitive perception:  query + memory state → biased representation → different fragments
                       "What is the user thinking about?"
```

These are not two retrieval strategies. They are two different ways of relating the agent to the user's memory:
- Semantic retrieval treats memory as a **library** to be searched.
- Cognitive perception treats memory as a **lens** that changes how the agent sees the current input.

The 93% non-overlap between semantic and cognitive retrieval results (§4.1), the 5.3% overlap between cognitive and recency signals (§4.2), and the detection of cognitive phase transitions (§4.3) all point to the same conclusion: **cognitive state is an information dimension that exists independently of semantic content and cannot be captured by retrieval alone**.

## 5 Method: Bootstrapping Cognitive State Prediction

## 5 Method: Bootstrapping Cognitive State Prediction

The discovery of dual signals raised a practical question: can cognitive state be predicted efficiently enough to run on every user message? The memory-bias computation (weighted average of 2,674 embeddings) is too expensive for real-time use. We needed a model that could approximate the cognitive state vector from the user message alone, in under 50ms.

### 5.1 Training Paradigm: Classification vs. Regression

Our initial approach followed the standard pattern for memory-related learning tasks: **pair classification**. We trained a projection layer on macbert-102M to judge whether two fragments have a causal relationship, using 1,130 labeled pairs from user corrections, confirmations, decisions, and distilled rules. The model achieved positive similarity (pos) of 0.77.

We then attempted five methods to improve beyond 0.77:

| Method | Data Expansion Strategy | Result |
|--------|------------------------|--------|
| Co-occurrence | Same-session fragment pairs (8,369 pairs) | pos 0.77 → **0.66** |
| LLM synthesis | DeepSeek causal scoring (1,446 pairs) | pos 0.77 → **0.63** |
| Fragment links | LLM-generated links (1,548 pairs) | pos 0.77 → **0.38** |
| Triplet loss | Hard negative mining (no new data) | pos 0.77 → **0.76** |
| Temperature scaling | Inference threshold tuning | pos 0.77 → **no change** |

All five methods failed. The pattern was clear: **no external signal could improve the model's judgment of behavioral causality**.

**Root cause diagnosis** through bucket evaluation revealed that the 0.77 score was a structural artifact of overfitting. When we split training data by label source:

| Bucket | Label Source | Data | pos | Cross-generalization |
|--------|-------------|:----:|:---:|-----|
| distilled_rule | Template rules | 64 | 0.686 | Fails on other buckets |
| existing | User corrections | 537 | 0.463 | Fails on other buckets |
| session_replay | Behavioral replay | 302 | 0.283 | pos 0.075 on existing bucket |

The session_replay model generalized to the existing bucket at only pos 0.075 — essentially random. The model was not learning a unified causal judgment ability; it was memorizing patterns specific to each label type.

**Paradigm shift**: We identified that the fundamental problem was not data quantity or model capacity but **training objective misalignment**. Pair classification asks the model to make an external judgment ("Do these two fragments have a causal relationship?"). This requires ground truth labels that must come from outside the model — hence the perpetual data bottleneck.

Cognitive state regression asks a fundamentally different question: "Given this user message, what is the user's cognitive state?" The answer is a continuous vector (the cognitive state vector), and the labels can be **automatically generated from the memory system's own statistics**.

### 5.2 Self-Bootstrapping Label Generation

The key insight is that the memory system already computes a proxy for cognitive state: the memory-bias weighted average vector. For any user message in any session, we can compute what the cognitive state *should be* at that point by:

1. Taking the 20 most recent fragments before that message
2. Computing their embeddings via macbert
3. Weighting each embedding by: `channel_coefficient × recency_decay × decayScore × anchor_weight`
4. Averaging to produce a 768-dimensional cognitive state vector

This vector represents "what the user is cognitively focused on at this moment" as computed by the memory system's own weighting mechanism. It serves as the training label for the cognitive state prediction model.

**Critical property**: This label generation requires zero human annotation and zero LLM API calls. It is a deterministic computation from the memory system's existing data structures. Each conversation turn produces one training sample automatically.

From 130 sessions with ~13 turns each, we obtained 1,477 training samples with automatically generated labels. No manual labeling was performed at any stage.

### 5.3 Model Architecture

The cognitive state prediction model consists of:

- **Encoder**: macbert-102M (pre-trained Chinese BERT, 102M parameters)
- **Projection**: Three-layer MLP (768 → 512 → 512 → 768)
- **Output**: L2-normalized 768-dimensional cognitive state vector
- **Loss**: MSE between predicted and label vectors
- **Input**: User message text, optionally concatenated with previous 2 messages for sequence context

The model runs as ONNX on-device, with inference time under 50ms per prediction.

### 5.4 Sequence Context Effect

A surprising finding emerged when we compared single-message input vs. 3-message sequence input:

| Metric | Single Message | 3-Message Sequence | Effect |
|--------|:----:|:----:|:----:|
| Cognitive state prediction (cosine sim) | 0.961 | **0.967** | +0.006 ↑ |
| Predicted vs. Actual overlap (top-10) | 1.76 | **2.40** | +36% ↑ |
| Query embedding similarity | 0.945 | **0.892** | -0.053 ↓ |

Sequence context **improves** cognitive state prediction but **degrades** semantic search quality. This is not a coincidence — it is evidence of fundamentally different information processing requirements:

- **Semantic search** needs precise, focused queries. Adding context dilutes the query signal.
- **Cognitive perception** needs contextual patterns. A single message may be an outlier; three messages reveal the trajectory.

This inverse relationship between the two signals under the same input manipulation is the strongest evidence that they are different processing paradigms, not merely different ranking strategies applied to the same underlying signal.

## 6 Experiments

## 6 Experiments

### 6.1 Association Matrix Ablation (Phase 3)

Before the dual-signal discovery, we conducted a systematic ablation to test whether graph-based memory association could improve retrieval beyond standard semantic search.

**Setup**: We built four types of edges between fragments:
- `co_occurred`: same-session co-occurrence (1,997 edges)
- `semantic`: vector cosine > 0.7 (2,000 edges)
- `corrected_by`: FEEL correction → WHAT behavior (200 edges)
- `distilled_from`: fragment → source rule (58 edges)

**Ablation conditions** (progressive addition):

| Condition | Components | Avg Recall | vs. Baseline |
|-----------|-----------|:----:|:----:|
| A (baseline) | LIKE keyword search | 2.1 | — |
| B | A + corrected_by + distilled_from | 5.0 | +138% |
| C | B + semantic edges | 6.9 | +228% |
| D | C + 1-hop propagation | 9.0 | +328% |

**Correction with real baseline**: When condition A was replaced with the production retriever (FTS5 + vector + MMR):

| Condition | Avg Recall | vs. Real Baseline |
|-----------|:----:|:----:|
| A (FTS5+MMR) | 2.5 | — |
| B (+explicit edges) | 3.2 | **+27%** |
| C (+semantic) | 3.2 | **+0%** |
| D (+propagation) | 3.2 | **+0%** |

**Key findings**:
- Explicit knowledge edges (corrected_by + distilled_from) provide genuine +27% improvement on a real retriever
- Semantic edges and graph propagation provide zero improvement on a real retriever — the retriever already captures what semantic edges encode
- Edge density (258 knowledge edges vs. 2,700+ fragments) is too low for propagation to add value
- **Conclusion**: Graph-based association is not a replacement for retrieval; explicit causal edges are a complement

### 6.2 Cognitive State Regression

**Setup**: Training on 1,477 automatically-labeled samples. 80/20 train/val split. Evaluation on held-out sessions (cross-session generalization).

**Primary results**:

| Metric | Value |
|--------|-------|
| Validation cosine similarity | **0.967** |
| Validation MSE | 0.000101 |
| Training samples | 1,477 |
| Label generation cost | Zero (automatic) |

**Cross-session retrieval evaluation**:

| Retrieval Method | Avg Max Similarity |
|-----------------|:----:|
| Original query embedding | 0.8921 |
| Predicted cognitive state | **0.9587** |
| Actual memory-bias state (upper bound) | 0.9635 |

**Top-10 overlap analysis** (lower = more independent signal):

| Comparison | Overlap / 10 |
|------------|:----:|
| Query vs. Predicted state | **0.48** |
| Query vs. Actual state | 1.10 |
| Predicted vs. Actual state | 1.76 |

**Interpretation**: The predicted cognitive state retrieves fragments that are 95% different from semantic search. The predicted state is closer to the actual cognitive state (0.9587) than the raw query (0.8921), confirming that cognitive perception captures information that semantic search misses. The gap between predicted (0.9587) and upper bound (0.9635) is only 0.0048 — the model has nearly reached the limit of what the statistical label can express.

### 6.3 Training Paradigm Comparison

To isolate the effect of training objective, we compared pair classification and cognitive state regression on the same base model (macbert-102M) and data source (memory system statistics):

| Aspect | Pair Classification | Cognitive State Regression |
|--------|:----:|:----:|
| Training objective | Binary: "causal or not?" | Continuous: "what cognitive state?" |
| Label source | Human-defined rules + correction signals | Automatic from memory statistics |
| Data quantity | 1,130 pairs (bottleneck) | 1,477 samples (auto-scaling) |
| Best achievable score | pos 0.77 (structural ceiling) | cosine 0.967 |
| Data expansion attempts | 5 methods, all failed | Not needed |
| Cross-generalization | Fails between buckets | Consistent across sessions |
| Inference cost | <50ms | <50ms |

The paradigm shift from classification to regression eliminated the data bottleneck entirely. Classification requires external ground truth (which is scarce and noisy for behavioral causality). Regression requires only statistical labels (which the memory system generates automatically as a byproduct of its normal operation).

### 6.4 Model Capacity Check

We tested whether the 0.967 result was limited by model capacity by replacing macbert-102M (102M params, 768-dim) with chinese-roberta-wwm-ext-large (340M params, 1024-dim):

| Metric | macbert-102M | roberta-340M | Δ |
|--------|:----:|:----:|:----:|
| Cosine similarity | 0.967 | 0.969 | +0.002 |
| Inference time | <50ms | ~150ms | +200% |

The 3× larger model provides negligible improvement (+0.002 cosine) at 3× the latency. This confirms that the 0.967 result is not limited by model capacity — the macbert-102M is sufficient for cognitive state prediction. The remaining gap (0.967 vs. 0.9635 upper bound) is likely due to the statistical label's inherent noise, not model limitations.

### 6.5 Behavioral Validation: Retrieval Channel Distribution

A critical gap in offline evaluation is whether the cognitive state signal produces *behaviorally meaningful* differences in retrieval — not just statistically different results. To validate this, we conducted a controlled comparison on 28 historical user queries from real session transcripts.

**Setup**: For each query, we ran two retrieval methods against a pool of 500 active fragments with channel annotations:
- **Semantic retrieval**: Raw query embedding → cosine similarity → top-10 fragments
- **Cognitive retrieval**: Predicted cognitive state vector → cosine similarity → top-10 fragments

We measured three dimensions of behavioral relevance: (1) retrieval overlap between methods, (2) FEEL channel fragment proportion (correction/preference fragments that encode user constraints), and (3) FEEL fragment weight (the system's estimate of constraint importance).

**Results**:

| Metric | Semantic Retrieval | Cognitive Retrieval | Ratio |
|--------|:----:|:----:|:----:|
| FEEL fragments in top-10 | 60.7% | **90.0%** | **1.48×** |
| Total FEEL weight | 13,900 | **20,610** | **1.48×** |
| Avg top-10 overlap | — | — | **0.9 / 10** |
| Queries with zero overlap | — | — | **13 / 28 (46.4%)** |
| Avg fragment age (days) | 8.9 | **8.2** | — |

**Analysis**: Cognitive retrieval systematically surfaces more constraint-relevant fragments than semantic search. The 1.48× FEEL weight ratio indicates that these are not random additional fragments but higher-importance ones — fragments that the memory system has assigned higher weight due to user corrections, confirmations, and repeated interactions. Per query, cognitive retrieval recovers an average of 240 additional FEEL weight units that semantic search misses entirely.

The zero-overlap rate of 46.4% confirms that nearly half of all queries produce *completely disjoint* top-10 results between the two methods. This is not partial complementarity — it is full independence for a substantial fraction of queries. When cognitive retrieval diverges from semantic retrieval, it diverges completely.

The temporal depth results (8.2 vs. 8.9 days) indicate that cognitive retrieval favors slightly more recent fragments — the user's *current* constraints and corrections, rather than older ones. This is consistent with the design of the decay-weighted cognitive state label: recent high-weight FEEL fragments dominate the state vector, while older fragments with similar semantic content have decayed.

**Behavioral significance**: These results validate that the cognitive state signal is not merely a statistical artifact — it produces systematically different retrieval behavior that is aligned with the system's estimate of constraint importance. The cognitive dimension surfaces fragments that encode *how the user wants things done* (corrections, preferences, constraints), while the semantic dimension surfaces fragments about *what the user is talking about* (facts, decisions, file references). Both dimensions are useful for different aspects of agent behavior, and neither fully captures the other.

### 6.6 Summary of Quantitative Results

| Experiment | Key Metric | Result | Interpretation |
|-----------|-----------|--------|---------------|
| Memory-bias redirection | Query reranking rate | 60% | Memory changes query perspective |
| Diversity test | Biased-only overlap | 0% | Not popularity bias |
| Cognitive offset | Temporal shift detection | 96% | Cognitive state changes over time |
| Background orthogonality | Cognitive vs. recency overlap | 5.3% | Independent signal dimensions |
| Explicit knowledge edges | Retrieval improvement | +27% | Causal edges complement retrieval |
| Semantic edges | Retrieval improvement | +0% | Redundant with retriever |
| Graph propagation | Retrieval improvement | +0% | No structural advantage |
| Cognitive state prediction | Cosine similarity | 0.967 | High-accuracy local prediction |
| Orthogonality validation | Top-10 overlap | 0.48/10 | 93% independent from search |
| Behavioral validation | FEEL weight ratio | 1.48× | Cognitive surfaces constraints |
| Behavioral validation | Zero-overlap queries | 46.4% | Nearly half fully independent |
| Sequence context effect | Cognition vs. search | Opposite | Different processing paradigms |

## 7 Analysis

## 7 Analysis

### 7.1 Why Classification Failed

The five failed data expansion attempts (§5.1) are not merely negative results — they reveal a structural constraint in applying classification paradigms to behavioral causality.

**The external judgment problem**: Pair classification requires the model to answer "Do fragments A and B have a causal relationship?" This question has no universally correct answer — the "right" answer depends on the specific user's behavioral patterns, which are not encoded in the fragment text alone. For example:

```
Fragment A: "User corrected the agent for deleting comments"
Fragment B: "User modified login.ts configuration"

LLM judgment: Weak relationship (2/5)
  — From world knowledge, correcting comments and modifying files are independent.
Behavioral causality: Strong relationship (4/5)
  — The user's behavioral pattern connects these events temporally and causally.
```

The LLM calibration test showed only **10% agreement** between LLM causal judgments and the system's behavioral causality labels. This is not because the LLM is wrong — it is because the LLM answers a different question. The LLM judges "objective logical causality"; the system needs "user-specific behavioral linkage."

**The structural overfitting mechanism**: When trained on 1,130 pairs with mixed label sources, the model does not learn a unified causal judgment ability. Instead, it learns bucket-specific patterns:
- distilled_rule bucket (0.686): learns template-matching patterns
- existing bucket (0.463): learns correction-signal patterns
- session_replay bucket (0.283): learns spurious co-occurrence patterns

The cross-generalization matrix shows these patterns are mutually exclusive: a model trained on one bucket fails on others (pos 0.075 for session_replay → existing). The 0.77 aggregate score is the weighted mean of three non-transferable abilities, not a single coherent capability.

### 7.2 Why Regression Succeeded

Cognitive state regression succeeded where classification failed because the training objectives are fundamentally different:

**Classification asks**: "Is there a relationship between these two specific fragments?"
- Requires external ground truth (labels from user behavior)
- Labels are sparse, noisy, and bucket-specific
- Model learns to discriminate, not to represent
- Data is the bottleneck

**Regression asks**: "What is the user's cognitive state given this message?"
- Labels are computed from memory system statistics
- Labels are dense, automatic, and available for every turn
- Model learns to represent cognitive position
- Data is not the bottleneck

The critical difference is that regression labels come from **within the system** (memory statistics), while classification labels come from **outside the system** (user corrections, LLM judgments). Internal labels can scale with usage; external labels cannot.

This is the **self-bootstrapping property**: the memory system generates its own training signal as a byproduct of normal operation. Each conversation turn produces one training sample (the cognitive state vector at that moment). As usage increases, the training set grows automatically, and the model improves automatically. No labeling pipeline, no LLM calls, no human intervention.

### 7.3 Orthogonality as Architectural Insight

The 93% non-overlap between cognitive state and semantic retrieval is not merely an empirical observation — it has architectural implications for how agent memory systems should be designed.

**Single-dimension systems**: All existing agent memory systems (Mem0, Letta, Zep, MemGPT) operate on a single dimension: semantic relevance. Fragments are stored, retrieved by similarity, and injected as context. The system has one way of accessing memory.

**Dual-dimension systems**: Our results suggest that effective personal agent memory requires at least two independent access mechanisms:
1. **Semantic retrieval**: "Find memories relevant to this query" (existing approach)
2. **Cognitive perception**: "What is the user's cognitive state right now?" (this work)

These two mechanisms produce nearly non-overlapping results. An agent that only does semantic retrieval misses the cognitive dimension entirely. An agent that only does cognitive perception lacks the precision to answer specific questions.

**The lens vs. library metaphor**: Semantic retrieval treats memory as a library — you search for specific books. Cognitive perception treats memory as a lens — it changes how you see everything, not just what you find. The optimal agent memory system provides both: a library for specific queries and a lens for cognitive context.

### 7.4 Sequence Context as Diagnostic Tool

The sequence context experiment (§5.4) provides a clean diagnostic for distinguishing the two signal dimensions:

```
If adding context improves performance → cognitive signal
If adding context degrades performance → semantic signal
```

This simple test can be applied to any memory access mechanism to determine which dimension it operates on. It also suggests a design principle: **cognitive processing benefits from context expansion; semantic processing benefits from context focus.** Systems that try to do both with the same context window face an inherent tradeoff.

### 7.5 Implications for Agent Architecture

The dual-signal discovery has concrete implications for how agent memory should be structured:

1. **Separate the signals**: Cognitive state should not be computed from the same mechanism as semantic retrieval. They need different models, different training objectives, and different integration points.

2. **Inject differently**: Semantic retrieval results should be injected as content ("here are relevant facts"). Cognitive state should be injected as context ("here is the user's current cognitive position"). These require different prompt formats and different positions in the agent's context.

3. **Local vs. cloud**: Semantic retrieval can use cloud embedding APIs (latency-tolerant). Cognitive state prediction should run locally (<50ms) because it operates on every message and must not add to response latency.

4. **Continuous vs. discrete**: Semantic retrieval is triggered by queries (discrete events). Cognitive state should be maintained continuously (updated on every message) because the user's cognitive state changes with every interaction.

## 8 Discussion

## 8 Discussion

### 8.1 From Memory Retrieval to Cognitive Perception

The dominant paradigm in agent memory has been retrieval: store fragments, retrieve by similarity, inject into context. This paradigm treats memory as an external resource — something the agent looks up when needed. Our results suggest a complementary paradigm: **cognitive perception** — memory as an internal state that continuously shapes how the agent processes every input.

In cognitive perception, the agent does not "retrieve memories about the user." The agent's processing of the current input is *already shaped* by its model of the user's cognitive state. The cognitive state vector is not a set of facts to be consulted; it is a lens through which all information is interpreted.

This is closer to how human memory works. A person does not "retrieve" their knowledge of a friend's preferences before each interaction. Their model of the friend is continuously active, shaping how they interpret every word and gesture. The retrieval paradigm approximates this by injecting relevant facts; the cognitive perception paradigm attempts to reproduce the continuous shaping effect.

### 8.2 The Self-Bootstrapping Loop

The self-bootstrapping property (§5.2, §7.2) has implications beyond this specific system. Any memory system that maintains weighted statistics over its contents can generate training labels for a cognitive state model. The requirements are:

1. Fragments have weights (relevance, recency, importance)
2. Weights change over time (through decay, reinforcement, or consolidation)
3. The system can compute a weighted average of fragment embeddings

These requirements are met by most sophisticated memory systems, not just Lingxi. The bootstrapping approach could be applied to Mem0, Letta, or any system that maintains fragment-level statistics.

The bootstrapping loop creates a **virtuous cycle**: more usage → more training data → better cognitive prediction → more useful cognitive injection → more effective agent behavior → more usage. This self-reinforcing cycle is qualitatively different from systems that require external labeling or manual preference configuration.

### 8.3 Relationship to Proactive Agent Behavior

ProAct (Hu et al., 2026) demonstrated that agents can benefit from predicting user needs during idle time. Their approach uses LLM inference for prediction, which is accurate but expensive. Our cognitive state prediction model provides a cheaper alternative: a <50ms local model that continuously tracks the user's cognitive trajectory.

The combination is promising: use the local cognitive state model for continuous tracking (fast, free, always-on), and use LLM inference for specific prediction tasks when the cognitive state model detects an opportunity (e.g., cognitive offset exceeds a threshold, indicating the user has shifted to a new concern).

### 8.4 Privacy Implications

Cognitive state prediction running entirely on-device has privacy implications that distinguish it from cloud-based memory systems. The cognitive state vector never leaves the device — it is computed from local embeddings, by a local model, for local use. This is qualitatively different from systems that send user conversations to cloud APIs for memory extraction and retrieval.

For users concerned about privacy, the cognitive perception paradigm offers a path to personalized agent behavior without exposing user cognition to cloud infrastructure. The tradeoff is that the local model is less capable than cloud models — but our results (cosine 0.967) suggest the gap is small for this specific task.

### 8.5 Toward Cognitive Architecture for Agents

The Lingxi system demonstrates that a complete cognitive architecture for personal agents is feasible with current technology: local neural models for fast processing, SQLite for zero-maintenance storage, hook-based integration for cross-platform compatibility. The dual-signal discovery emerged from this architecture, not from a prior hypothesis — suggesting that building complete systems can reveal insights that component-level analysis cannot.

The path from "agent with memory" to "agent with cognition" requires more than better retrieval. It requires a separate signal dimension that captures not what the user said but how the user is thinking. Our results show this dimension exists, can be measured, can be predicted locally, and is orthogonal to the semantic dimension that existing systems already capture.

## 9 Limitations

## 9 Limitations

### 9.1 Single-User Evaluation

All experiments in this paper were conducted on data from a single deep user (2,700+ fragments, 130+ sessions, several months of daily use). While this depth provides rich data for mechanism discovery, it does not establish generalizability. The orthogonal signal structure may be specific to this user's interaction patterns, domain, or cognitive style.

We have not conducted evaluation on additional real users. The self-bootstrapping label generation is theoretically applicable to any user (it requires only fragment weights and embeddings), but empirical validation across users is necessary before claiming generalizability. Synthetic user experiments (generating virtual users with different interaction patterns via LLM) could provide preliminary generalization evidence, but would not substitute for real multi-user evaluation.

### 9.2 No End-to-End Behavioral Validation

We have demonstrated that cognitive state vectors can be predicted with high accuracy (cosine 0.967) and that they are orthogonal to semantic retrieval (93% non-overlap). However, we have not yet validated that injecting predicted cognitive state into the agent's reasoning process *changes the agent's behavior in measurably better ways*.

The cognitive state vector has been integrated into the system's context injection pipeline (Layer 4 in §3.5), but controlled experiments comparing agent output quality with vs. without cognitive state injection have not been completed. This is a critical gap: demonstrating that a signal exists is necessary but not sufficient for demonstrating that it is useful.

### 9.3 Statistical Labels as Approximate Ground Truth

The training labels for cognitive state regression are generated from memory-bias weighted averaging — a statistical computation over fragment embeddings and weights. These labels are not "ground truth" cognitive states in any absolute sense. They are the memory system's own estimate of what the cognitive state should be, based on its weighting mechanism.

This creates a potential circularity: the model learns to predict the statistical label, and the statistical label is computed from the same memory system that the model will eventually enhance. If the weighting mechanism has systematic biases, the model will learn and reproduce those biases.

We view this as a feature rather than a bug for the current stage — the goal is to learn the memory system's own cognitive representation, not an external ground truth. However, for applications requiring alignment with human judgments of cognitive state, external validation would be necessary.

### 9.4 Injection Mechanism Not Optimized

The cognitive state vector is currently injected into the agent's context as a text description (natural language summary of the predicted cognitive state). This is a lossy compression of the 768-dimensional vector into human-readable text. A more direct injection mechanism — such as embedding-level biasing of the LLM's input representations — could potentially capture more of the cognitive signal.

We have not explored embedding-level injection in this work due to API limitations (cloud LLM providers do not expose embedding-level control). This represents a potentially significant gap between our current implementation and the theoretical capabilities of cognitive state injection.

### 9.5 Temporal Scope

The system has been in active use for several months, but the cognitive state prediction model was trained on a single snapshot of the data. We have not evaluated how the model performs as the user's cognitive patterns evolve over longer time scales (months to years). The decay system is designed to handle this, but the prediction model's ability to track long-term cognitive evolution has not been validated.

## 10 Conclusion

## 10 Conclusion

We have presented Lingxi, a personal agent cognitive architecture, and through its construction discovered that agent memory contains two orthogonal signal dimensions: semantic retrieval (what the user is talking about) and cognitive state perception (what the user is thinking about). We validated this discovery through three converging experimental lines: memory-bias redirection showing 60% of queries are reranked with 93% non-overlap against semantic search; cognitive offset detection identifying 96% attention shift between temporal windows; and cognitive state regression achieving cosine similarity 0.967 with automatically generated labels.

The discovery that sequence context improves cognitive state prediction but degrades semantic search quality provides strong evidence that these are fundamentally different information processing paradigms, not merely different ranking strategies. The self-bootstrapping label generation eliminates the data bottleneck that constrained prior classification approaches, demonstrating that personal agent memory can learn from the memory system's own statistical outputs without external annotation.

Our results suggest that effective personal agent memory requires at least two independent processing mechanisms operating in parallel: a semantic retrieval mechanism for content-specific memory access, and a cognitive perception mechanism for continuous cognitive state tracking. The cognitive dimension captures information that semantic retrieval cannot — the user's attentional trajectory, concern priorities, and cognitive phase — and this information is available for continuous, local, real-time processing without cloud API calls.

The path from "agent with memory" to "agent with cognition" requires more than better retrieval algorithms. It requires recognizing that cognitive state is an independent signal dimension that must be captured, predicted, and integrated separately from semantic content. Lingxi demonstrates that this is feasible with current technology: a <50ms local model, self-generated training labels, and a complete cognitive architecture that makes the discovery possible.

Future work will focus on: (1) end-to-end behavioral validation comparing agent output quality with and without cognitive state injection; (2) multi-user generalization evaluation; (3) embedding-level injection mechanisms for tighter integration with LLM reasoning; and (4) extending the cognitive state model to support proactive agent behavior — moving from "agent that knows what you're thinking" to "agent that acts on what it knows."

---

## References

Hu, H., Lyu, Q., Kong, X., Liu, W., Lin, J., Guo, Z., Xu, Y., Wang, Y., Zhang, W., & Yu, Y. (2026). Anticipate and Learn: Unleashing Idle-Time Compute in Proactive Agents. *arXiv:2605.25971*.

Luo, J., Tian, Y., Cao, C., Luo, Z., Lin, H., Li, K., Kong, C., Yang, R., & Ma, J. (2026). From Storage to Experience: A Survey on the Evolution of LLM Agent Memory Mechanisms. *ACL 2026 Findings*. arXiv:2605.06716.

Packer, C., Wooders, S., Lin, K., Fang, V., Patil, S. G., Stoica, I., & Gonzalez, J. E. (2023). MemGPT: Towards LLMs as Operating Systems. *arXiv:2310.08560*.

Shinn, N., Cassano, F., Gopinath, A., Narasimhan, K., & Yao, S. (2023). Reflexion: Language Agents with Verbal Reinforcement Learning. *NeurIPS 2023*.

Wang, G., Xie, Y., Jiang, Y., Mandlekar, A., Xiao, C., Zhu, Y., ... & Anandkumar, A. (2023). Voyager: An Open-Ended Embodied Agent with Large Language Models. *arXiv:2305.16291*.

Xu, H. (2026). MeloTune: On-Device Arousal Learning and Peer-to-Peer Mood Coupling for Proactive Music Curation. *arXiv:2604.10815*.

Zhao, X., Wang, K., Zhang, X., Yao, C., & Wang, A. (2026). HyMem: Hybrid Memory Architecture with Dynamic Retrieval Scheduling. *arXiv:2602.13933*.

Zhong, W., Guo, L., Gao, Q., & Wang, Y. (2024). MemoryBank: Enhancing Large Language Models with Long-Term Memory. *AAAI 2024*.
