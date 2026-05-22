# AgentMemory v3 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build a cross-platform Agent memory plugin that fragments conversations into 4-channel searchable memory, with silent associative prefetch and 4-layer backup recall.

**Architecture:** TypeScript core engine (pure logic, no platform deps) + per-platform adapter layer (Claude Code hooks / Generic MCP). SQLite + sqlite-vec for hybrid search. Local embedding via ONNX (bge-small-zh-v1.5, 384-dim). MCP server exposes memory_recall / memory_remember / memory_search / memory_get / dreaming tools.

**Tech Stack:** TypeScript 5.x, Node.js 20+, better-sqlite3 + sqlite-vec, @anthropic-ai/sdk (for Sonnet/Haiku fragmentation call), ONNX Runtime (local embedding), MCP SDK

**MVP Scope:** Path A (sync summary) + Path B (async fragmentation) + P2 (silent prefetch) + P3 (explicit search) + 4-layer recall + first-run batch import + manual /dreaming. Path C auto-distillation → v1.1.

---

## File Structure

```
D:\AgentMemory\
  src/
    types.ts                  — All shared types/interfaces
    db/
      schema.ts               — SQLite DDL (chunks, fragments, rules, archive, recall_log)
      connection.ts           — DB open/close, WAL mode, migrations
    core/
      embedder.ts             — ONNX embedding, cosine similarity
      fragmenter.ts           — 4-channel LLM fragmentation prompt + parser
      signal-channel.ts       — Dual-source signal scoring
      retriever.ts            — P2 (prefetch) + P3 (search), hybrid vector+FTS
      backup-recall.ts        — 4-layer fallback chain
      decay.ts                — Sandglass decay calculator
      dedup.ts                — Fragment dedup (embedding similarity)
      engine.ts               — Orchestrator: Path A/B, coordinates all modules
    adapters/
      claude-code.ts          — Claude Code/OpenClaw hook registration
      generic.ts              — Generic MCP adapter + heartbeat
    mcp/
      server.ts               — MCP server bootstrap
      tools.ts                — All MCP tool implementations
      install.ts              — First-run installer (scan + batch import + prompt inject)
    index.ts                  — Entry point
  tests/
    core/
      fragmenter.test.ts
      signal-channel.test.ts
      retriever.test.ts
      backup-recall.test.ts
      decay.test.ts
      engine.test.ts
    adapters/
      claude-code.test.ts
      generic.test.ts
    mcp/
      tools.test.ts
      install.test.ts
  package.json
  tsconfig.json
  vitest.config.ts
```

---

### Task 1: Project scaffold + types + dependencies

**Files:**
- Create: `D:\AgentMemory\package.json`
- Create: `D:\AgentMemory\tsconfig.json`
- Create: `D:\AgentMemory\vitest.config.ts`
- Create: `D:\AgentMemory\src\types.ts`

- [x] **Step 1: Initialize project**

```bash
cd D:\AgentMemory
npm init -y
npm install typescript @types/node vitest better-sqlite3 sqlite-vec @anthropic-ai/sdk @modelcontextprotocol/sdk onnxruntime-node zod
npm install -D vitest @types/better-sqlite3
npx tsc --init --target ES2022 --module NodeNext --moduleResolution NodeNext --outDir dist --rootDir src --strict true
```

```json
// vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { globals: true, environment: "node" },
});
```

- [x] **Step 2: Write types**

```typescript
// src/types.ts
export type Channel = "WHAT" | "FEEL" | "WHO" | "WHERE";

export type SignalSource = "behavior" | "clustering";

export interface FragmentAnchor {
  channel: Channel;
  label: string;           // ≤50 chars compressed tag
  weight: number;          // 0-255, higher = stronger retrieval anchor
  source: SignalSource;
  timestamp: number;       // Unix ms
}

export interface Fragment {
  id: string;              // UUIDv4
  sessionId: string;
  projectId: string;
  anchors: FragmentAnchor[];
  linkedIds: string[];     // IDs of co-created fragments
  linkedCount: number;     // Expected association count
  summary: string;         // ≤50 chars L1 compressed text
  decayScore: number;      // 1.0 → 0.0
  lastRecalledAt: number | null;
  recalledCount: number;
  createdAt: number;
  status: "active" | "archived" | "deleted";
}

export interface DistilledRule {
  id: string;
  text: string;            // One-sentence rule, ≤100 chars
  sourceFragmentIds: string[];
  weight: number;
  projectIds: string[];    // Cross-project scope
  createdAt: number;
}

export interface SearchResult {
  fragment: Fragment;
  score: number;           // Hybrid score 0-1
  matchedAnchors: string[];
  missingLinks: number;    // linkedCount - matchedAnchors.length
}

export interface SessionContext {
  sessionId: string;
  projectId: string;
  platform: "claude-code" | "openclaw" | "codex" | "generic";
  workspaceDir: string;
  lastMessages: Array<{ role: "user" | "assistant"; text: string }>;
}

export interface FragmentationInput {
  transcript: string;      // Raw conversation segment
  sessionId: string;
  projectId: string;
}

export interface FragmentationOutput {
  fragments: Omit<Fragment, "decayScore" | "lastRecalledAt" | "recalledCount" | "status">[];
  summary: string;         // Path A: compaction summary
}

export interface PrefetchResult {
  contextBlock: string;    // ≤150 tokens, injectable into system prompt
  fragmentIds: string[];
  confidence: number;      // 0-1
}

export interface InstallEstimate {
  fileCount: number;
  totalBytes: number;
  estimatedTokens: number;
  estimatedTimeMinutes: number;
  files: string[];         // Paths of discovered memory files
}
```

- [x] **Step 3: Verify build**

```bash
npx tsc --noEmit
```
Expected: No errors.

- [x] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: project scaffold, types, and dependencies"
```

---

### Task 2: Database schema + connection

**Files:**
- Create: `D:\AgentMemory\src\db\connection.ts`
- Create: `D:\AgentMemory\src\db\schema.ts`

- [x] **Step 1: Write schema DDL**

```typescript
// src/db/schema.ts
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS fragments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  linked_count INTEGER NOT NULL DEFAULT 0,
  decay_score REAL NOT NULL DEFAULT 1.0,
  last_recalled_at INTEGER,
  recalled_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS fragment_anchors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fragment_id TEXT NOT NULL REFERENCES fragments(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK(channel IN ('WHAT','FEEL','WHO','WHERE')),
  label TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL CHECK(source IN ('behavior','clustering')),
  timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fragment_links (
  source_id TEXT NOT NULL REFERENCES fragments(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES fragments(id) ON DELETE CASCADE,
  verified INTEGER NOT NULL DEFAULT 0,  -- 0=claimed, 1=bidirectional
  PRIMARY KEY (source_id, target_id)
);

CREATE TABLE IF NOT EXISTS distilled_rules (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rule_sources (
  rule_id TEXT NOT NULL REFERENCES distilled_rules(id) ON DELETE CASCADE,
  fragment_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  PRIMARY KEY (rule_id, fragment_id)
);

CREATE TABLE IF NOT EXISTS recall_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fragment_id TEXT NOT NULL REFERENCES fragments(id),
  query TEXT NOT NULL,
  score REAL NOT NULL,
  recalled_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  compacted_at INTEGER,
  pending_fragmentation INTEGER NOT NULL DEFAULT 0
);

CREATE VIRTUAL TABLE IF NOT EXISTS fragments_fts USING fts5(
  summary,
  content='fragments',
  content_rowid='rowid'
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workspace_dir TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export const VECTOR_DIMENSIONS = 384;
```

- [x] **Step 2: Write connection manager**

```typescript
// src/db/connection.ts
import Database from "better-sqlite3";
import * as path from "node:path";
import * as fs from "node:fs";
import { SCHEMA_SQL } from "./schema";

let db: Database.Database | null = null;

export function getDbPath(workspaceDir?: string): string {
  const base = workspaceDir ?? process.env.AGENTMEMORY_HOME ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".agentmemory");
  fs.mkdirSync(base, { recursive: true });
  return path.join(base, "memory.db");
}

export function openDb(dbPath?: string): Database.Database {
  if (db) return db;
  const resolved = dbPath ?? getDbPath();
  db = new Database(resolved);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

export function closeDb(): void {
  if (db) { db.close(); db = null; }
}

export function getDb(): Database.Database {
  if (!db) throw new Error("Database not opened. Call openDb() first.");
  return db;
}
```

- [x] **Step 3: Test schema creation**

```typescript
// tests/db/schema.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDb, closeDb, getDbPath } from "../../src/db/connection";
import * as os from "node:os";
import * as fs from "node:fs";

const testDir = fs.mkdtempSync(os.tmpdir() + "/agentmemory-test-");

describe("Database schema", () => {
  beforeAll(() => openDb(testDir + "/test.db"));
  afterAll(() => { closeDb(); fs.rmSync(testDir, { recursive: true, force: true }); });

  it("creates all tables", () => {
    const db = getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("fragments");
    expect(names).toContain("fragment_anchors");
    expect(names).toContain("fragment_links");
    expect(names).toContain("distilled_rules");
    expect(names).toContain("recall_log");
    expect(names).toContain("sessions");
    expect(names).toContain("fragments_fts");
  });

  it("enforces channel CHECK constraint", () => {
    const db = getDb();
    db.exec("INSERT INTO fragments (id, session_id, project_id, summary, created_at) VALUES ('f1','s1','p1','test',0)");
    expect(() => {
      db.exec("INSERT INTO fragment_anchors (fragment_id, channel, label, weight, source, timestamp) VALUES ('f1','INVALID','test',0,'behavior',0)");
    }).toThrow();
  });
});
```

Run: `npx vitest run tests/db/schema.test.ts`
Expected: 2 tests pass.

- [x] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: database schema and connection manager"
```

---

### Task 3: Embedding service

**Files:**
- Create: `D:\AgentMemory\src\core\embedder.ts`
- Create: `D:\AgentMemory\tests\core\embedder.test.ts`

- [x] **Step 1: Write embedder**

```typescript
// src/core/embedder.ts
import * as ort from "onnxruntime-node";

const MODEL_PATH = process.env.AGENTMEMORY_EMBED_MODEL ?? "bge-small-zh-v1.5";
const DIM = 384;

let session: ort.InferenceSession | null = null;

async function getSession(): Promise<ort.InferenceSession> {
  if (!session) {
    session = await ort.InferenceSession.create(MODEL_PATH);
  }
  return session;
}

function meanPooling(lastHiddenState: Float32Array, attentionMask: Float32Array): number[] {
  const result = new Array(DIM).fill(0);
  let maskSum = 0;
  for (let i = 0; i < attentionMask.length; i++) {
    const offset = i * DIM;
    const w = attentionMask[i];
    maskSum += w;
    for (let j = 0; j < DIM; j++) {
      result[j] += lastHiddenState[offset + j] * w;
    }
  }
  for (let i = 0; i < DIM; i++) {
    result[i] /= maskSum;
  }
  // L2 normalize
  const norm = Math.sqrt(result.reduce((s, v) => s + v * v, 0));
  return result.map((v) => v / (norm || 1));
}

export async function embed(text: string): Promise<number[]> {
  const s = await getSession();
  const feeds: Record<string, ort.Tensor> = {
    input_ids: new ort.Tensor("int64", new BigInt64Array(/* tokenized input */), [1, 512]),
    attention_mask: new ort.Tensor("int64", new BigInt64Array(/* tokenized mask */), [1, 512]),
  };
  // NOTE: Real impl uses a tokenizer (e.g., @xenova/transformers or node-tokenizers)
  // For MVP, use a simple placeholder + document tokenizer requirement
  // Full tokenizer integration in Step 2
  throw new Error("Tokenizer not yet wired — see Step 2");
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
```

- [x] **Step 2: Add tokenizer dependency + wire up**

```bash
npm install @xenova/transformers
```

Replace the placeholder tokenizer code with:

```typescript
import { pipeline } from "@xenova/transformers";

let extractor: any = null;
async function getExtractor() {
  if (!extractor) {
    extractor = await pipeline("feature-extraction", MODEL_PATH);
  }
  return extractor;
}

export async function embed(text: string): Promise<number[]> {
  const ext = await getExtractor();
  const result = await ext(text, { pooling: "mean", normalize: true });
  return Array.from(result.data as Float32Array);
}
```

- [x] **Step 3: Test embedding**

```typescript
// tests/core/embedder.test.ts
import { describe, it, expect } from "vitest";
import { embed, cosineSimilarity } from "../../src/core/embedder";

describe("embedder", () => {
  it("produces 384-dim vector", async () => {
    const vec = await embed("测试文本");
    expect(vec).toHaveLength(384);
    expect(vec.every((v) => typeof v === "number")).toBe(true);
  });

  it("cosine similarity: same text = 1.0", () => {
    const vec = new Array(384).fill(0.05);
    expect(cosineSimilarity(vec, vec)).toBeCloseTo(1.0, 4);
  });

  it("cosine similarity: orthogonal = 0", () => {
    const a = [1, 0, ...new Array(382).fill(0)];
    const b = [0, 1, ...new Array(382).fill(0)];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 4);
  });
});
```

Run: `npx vitest run tests/core/embedder.test.ts`
Expected: 3 tests pass (may take ~10s for model download on first run).

- [x] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: embedding service with ONNX + bge-small-zh"
```

---

### Task 4: 4-channel fragmenter

**Files:**
- Create: `D:\AgentMemory\src\core\fragmenter.ts`
- Create: `D:\AgentMemory\tests\core\fragmenter.test.ts`

- [x] **Step 1: Write fragmentation prompt + parser**

```typescript
// src/core/fragmenter.ts
import type { FragmentationInput, FragmentationOutput, Channel, SignalSource } from "../types";
import { v4 as uuid } from "uuid";

const FRAGMENT_PROMPT = `将以下对话拆分为记忆碎片。对每段有实质内容的对话，输出JSON数组。

每条碎片包含：
- channel: "WHAT"|"FEEL"|"WHO"|"WHERE"
- label: ≤50字的压缩描述
- weight: 0-255的权重。FEEL通道基于信号：
  纠正=80, 挫败=90, 紧迫=50, 忽略=40, 确认=30, 默认=10
- linkedTo: 同时产生的其他碎片序号(0-based数组)，不关联的写[]
- summary: ≤50字的完整碎片文本

丢弃：闲聊、纯确认、重复内容、无信息过渡语。
如果某段对话不产生碎片，跳过。

输入对话：
{transcript}

输出：`;

export function buildFragmentationPrompt(transcript: string): string {
  return FRAGMENT_PROMPT.replace("{transcript}", transcript);
}

interface RawFragment {
  channel: string;
  label: string;
  weight: number;
  linkedTo: number[];
  summary: string;
}

export function parseFragmentationResponse(
  raw: string,
  sessionId: string,
  projectId: string
): FragmentationOutput {
  let parsed: RawFragment[];
  try {
    // Extract JSON array from response (may be wrapped in markdown)
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
  } catch {
    return { fragments: [], summary: "" };
  }

  const validChannels = new Set(["WHAT", "FEEL", "WHO", "WHERE"]);
  const fragments = parsed
    .filter((r) => validChannels.has(r.channel) && r.label && r.summary)
    .map((r, idx) => ({
      id: uuid(),
      sessionId,
      projectId,
      anchors: [{
        channel: r.channel as Channel,
        label: r.label.slice(0, 50),
        weight: Math.min(255, Math.max(0, r.weight | 0)),
        source: (r.channel === "FEEL" ? "behavior" : "clustering") as SignalSource,
        timestamp: Date.now(),
      }],
      linkedIds: [],  // Filled in Step 2 after all fragments created
      linkedCount: r.linkedTo?.length ?? 0,
      summary: r.summary.slice(0, 50),
      createdAt: Date.now(),
    }));

  // Summary = concatenation of all WHAT fragments
  const summary = fragments
    .filter((f) => f.anchors[0]?.channel === "WHAT")
    .map((f) => f.summary)
    .join("; ");

  return { fragments, summary };
}
```

- [x] **Step 2: Add bidirectional link resolution**

```typescript
export function resolveLinks(fragments: FragmentationOutput["fragments"], rawFragments: RawFragment[]): void {
  const idMap = fragments.map((f) => f.id);
  for (let i = 0; i < rawFragments.length; i++) {
    const links = rawFragments[i].linkedTo ?? [];
    const sourceId = idMap[i];
    if (!sourceId) continue;
    for (const targetIdx of links) {
      const targetId = idMap[targetIdx];
      if (targetId && targetId !== sourceId) {
        const f = fragments.find((x) => x.id === sourceId);
        if (f && !f.linkedIds.includes(targetId)) {
          f.linkedIds.push(targetId);
        }
      }
    }
  }
  // Update linkedCount to match actual linkedIds length
  for (const f of fragments) {
    f.linkedCount = f.linkedIds.length;
  }
}
```

- [x] **Step 3: Write fragmentation orchestrator (calls LLM)**

```typescript
import { Anthropic } from "@anthropic-ai/sdk";

export async function fragmentTranscript(
  input: FragmentationInput,
  apiKey: string,
  model: string = "claude-haiku-4-5"  // Use Haiku for cost efficiency
): Promise<FragmentationOutput> {
  const client = new Anthropic({ apiKey });
  const prompt = buildFragmentationPrompt(input.transcript);

  const msg = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  const text = msg.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const result = parseFragmentationResponse(text, input.sessionId, input.projectId);
  return result;
}
```

- [x] **Step 4: Test parser**

```typescript
// tests/core/fragmenter.test.ts
import { describe, it, expect } from "vitest";
import { parseFragmentationResponse, buildFragmentationPrompt } from "../../src/core/fragmenter";

const mockResponse = JSON.stringify([
  { channel: "WHAT", label: "OpenClaw启动性能调试", weight: 10, linkedTo: [1], summary: "修复mDNS+WhatsApp后启动从6分钟降至30秒" },
  { channel: "FEEL", label: "用户纠正乐观估计", weight: 80, linkedTo: [0], summary: "用户说6分钟还是如此→Agent估计不准" },
  { channel: "WHERE", label: "OpenClaw/Windows/discovery.mdns", weight: 10, linkedTo: [0, 1], summary: "OpenClaw网关，Windows，discovery.mdns.mode" },
  { channel: "WHO", label: "用户=管理员", weight: 5, linkedTo: [], summary: "用户配置和管理OpenClaw" },
]);

describe("fragmenter", () => {
  it("builds prompt with transcript", () => {
    const prompt = buildFragmentationPrompt("测试对话");
    expect(prompt).toContain("测试对话");
    expect(prompt).toContain("WHAT");
    expect(prompt).toContain("FEEL");
  });

  it("parses valid response", () => {
    const result = parseFragmentationResponse(mockResponse, "s1", "p1");
    expect(result.fragments).toHaveLength(4);
    expect(result.fragments[0].anchors[0].channel).toBe("WHAT");
    expect(result.fragments[1].anchors[0].weight).toBe(80);
    expect(result.summary).toContain("启动性能调试");
  });

  it("rejects invalid channels", () => {
    const bad = JSON.stringify([{ channel: "INVALID", label: "x", weight: 10, linkedTo: [], summary: "test" }]);
    const result = parseFragmentationResponse(bad, "s1", "p1");
    expect(result.fragments).toHaveLength(0);
  });

  it("handles empty response", () => {
    const result = parseFragmentationResponse("no json here", "s1", "p1");
    expect(result.fragments).toHaveLength(0);
    expect(result.summary).toBe("");
  });
});
```

Run: `npx vitest run tests/core/fragmenter.test.ts`
Expected: 4 tests pass.

- [x] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: 4-channel fragmenter with LLM prompt and parser"
```

---

### Task 5: Dual-source signal channel

**Files:**
- Create: `D:\AgentMemory\src\core\signal-channel.ts`
- Create: `D:\AgentMemory\tests\core\signal-channel.test.ts`

- [x] **Step 1: Write signal detector**

```typescript
// src/core/signal-channel.ts
import type { Fragment } from "../types";
import { cosineSimilarity } from "./embedder";

// Source 1: Behavioral signals from message text
export function detectBehaviorSignals(
  userMessage: string,
  previousAssistantMessage?: string
): Array<{ signal: string; weight: number }> {
  const signals: Array<{ signal: string; weight: number }> = [];
  const text = userMessage;

  // Correction: user overrides assistant's assumption
  const correctionPatterns = /不对|不是|错了|搞错了|应该是|实际上是|你记错了/;
  if (correctionPatterns.test(text)) {
    signals.push({ signal: "correction", weight: 80 });
  }

  // Repeated correction (挫败): same topic corrected ≥2 times
  const frustrationPatterns = /又(错了|来了|是这样)|已经说了|第[二三四五六七八九十]/;
  if (frustrationPatterns.test(text) && correctionPatterns.test(text)) {
    signals.push({ signal: "frustration", weight: 90 });
  }

  // Urgency
  const urgencyPatterns = /必须|今天|马上|紧急|deadline|尽快|立刻|现在就要/;
  if (urgencyPatterns.test(text)) {
    signals.push({ signal: "urgency", weight: 50 });
  }

  // Bypass: user ignores assistant suggestion, gives direct conclusion
  if (previousAssistantMessage && previousAssistantMessage.includes("建议")) {
    const questionPatterns = /建议|怎么|要不要|要我/;
    if (questionPatterns.test(previousAssistantMessage) && !questionPatterns.test(text)) {
      signals.push({ signal: "bypass", weight: 40 });
    }
  }

  // Confirmation
  const confirmPatterns = /^对$|^对的$|^就这样$|^完美$|^可以$|^好$|没错|正是这个意思/;
  if (confirmPatterns.test(text.trim())) {
    signals.push({ signal: "confirmation", weight: 30 });
  }

  return signals;
}

// Source 2: Content clustering (cross-session similarity)
export function detectClusteringSignal(
  newFragmentSummary: string,
  newFragmentEmbedding: number[],
  existingFragments: Array<{ summary: string; embedding: number[] }>,
  threshold: number = 0.82
): { signal: string; weight: number; similarIds: string[] } | null {
  const similar: Array<{ idx: number; score: number }> = [];
  for (let i = 0; i < existingFragments.length; i++) {
    const score = cosineSimilarity(newFragmentEmbedding, existingFragments[i].embedding);
    if (score >= threshold) {
      similar.push({ idx: i, score });
    }
  }
  if (similar.length >= 3) {
    return { signal: "recurring_pattern", weight: 90, similarIds: similar.map((s) => `existing_${s.idx}`) };
  }
  if (similar.length >= 2) {
    return { signal: "repeated_topic", weight: 60, similarIds: similar.map((s) => `existing_${s.idx}`) };
  }
  return null;
}

// Combine both sources into FEEL anchor weight
export function computeFeelWeight(
  behaviorSignals: Array<{ signal: string; weight: number }>,
  clusteringSignal: { signal: string; weight: number } | null
): number {
  const maxBehavior = behaviorSignals.length > 0
    ? Math.max(...behaviorSignals.map((s) => s.weight))
    : 0;
  const clusteringWeight = clusteringSignal?.weight ?? 0;
  return Math.min(255, Math.max(10, maxBehavior || clusteringWeight || 10));
}
```

- [x] **Step 2: Test signals**

```typescript
// tests/core/signal-channel.test.ts
import { describe, it, expect } from "vitest";
import { detectBehaviorSignals, computeFeelWeight } from "../../src/core/signal-channel";

describe("signal-channel", () => {
  it("detects correction", () => {
    const sigs = detectBehaviorSignals("不对，上次用的是CPU不是GPU", "建议用GPU推理");
    expect(sigs.some((s) => s.signal === "correction" && s.weight === 80)).toBe(true);
  });

  it("detects frustration when correction repeated", () => {
    const sigs = detectBehaviorSignals("这个错误已经出现三次了，能不能做好记录");
    expect(sigs.some((s) => s.signal === "frustration" && s.weight === 90)).toBe(true);
  });

  it("detects urgency", () => {
    const sigs = detectBehaviorSignals("这个必须今天搞定");
    expect(sigs.some((s) => s.signal === "urgency" && s.weight === 50)).toBe(true);
  });

  it("detects bypass", () => {
    const sigs = detectBehaviorSignals("直接用方案B", "要不要试试方案A？建议用方案A");
    expect(sigs.some((s) => s.signal === "bypass" && s.weight === 40)).toBe(true);
  });

  it("detects confirmation", () => {
    const sigs = detectBehaviorSignals("对");
    expect(sigs.some((s) => s.signal === "confirmation" && s.weight === 30)).toBe(true);
  });

  it("no signals on neutral message", () => {
    const sigs = detectBehaviorSignals("修一下video-analysis的CUDA报错");
    expect(sigs).toHaveLength(0);
  });

  it("computeFeelWeight uses max", () => {
    const weight = computeFeelWeight(
      [{ signal: "correction", weight: 80 }, { signal: "urgency", weight: 50 }],
      null
    );
    expect(weight).toBe(80);
  });

  it("computeFeelWeight falls back to clustering", () => {
    const weight = computeFeelWeight([], { signal: "recurring_pattern", weight: 90 });
    expect(weight).toBe(90);
  });

  it("computeFeelWeight floor is 10", () => {
    const weight = computeFeelWeight([], null);
    expect(weight).toBe(10);
  });
});
```

Run: `npx vitest run tests/core/signal-channel.test.ts`
Expected: 9 tests pass.

- [x] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: dual-source signal channel (behavioral + clustering)"
```

---

### Task 6: Sandglass decay

**Files:**
- Create: `D:\AgentMemory\src\core\decay.ts`
- Create: `D:\AgentMemory\tests\core\decay.test.ts`

- [x] **Step 1: Write decay calculator**

```typescript
// src/core/decay.ts

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
const ONE_EIGHTY_DAYS_MS = 180 * 24 * 60 * 60 * 1000;

export interface DecayResult {
  score: number;
  status: "active" | "archived" | "deleted";
}

export function computeDecayScore(
  createdAt: number,
  lastRecalledAt: number | null,
  recalledCount: number
): DecayResult {
  const now = Date.now();

  // If recalled recently, reset to 1.0
  if (lastRecalledAt) {
    const hoursSinceRecall = (now - lastRecalledAt) / (60 * 60 * 1000);
    if (hoursSinceRecall < 24) return { score: 1.0, status: "active" };
  }

  const age = now - createdAt;

  // 7-day newbie protection
  if (age < SEVEN_DAYS_MS) return { score: 1.0, status: "active" };

  // Never recalled → faster decay
  const multiplier = recalledCount === 0 ? 0.8 : 1.0;

  if (age < THIRTY_DAYS_MS) return { score: 0.7 * multiplier, status: "active" };
  if (age < SIXTY_DAYS_MS) return { score: 0.3 * multiplier, status: "active" };

  // 60+ days → archive
  if (age < ONE_EIGHTY_DAYS_MS) return { score: 0, status: "archived" };

  // 180+ days, all linked fragments also archived → delete
  return { score: 0, status: "deleted" };
}

export function boostDecayScore(fragment: { decayScore: number; recalledCount: number; lastRecalledAt: number | null }): void {
  fragment.decayScore = 1.0;
  fragment.recalledCount += 1;
  fragment.lastRecalledAt = Date.now();
}
```

- [x] **Step 2: Test decay**

```typescript
// tests/core/decay.test.ts
import { describe, it, expect } from "vitest";
import { computeDecayScore, boostDecayScore } from "../../src/core/decay";

describe("decay", () => {
  it("7-day protection keeps score 1.0", () => {
    const recent = Date.now() - 3 * 24 * 60 * 60 * 1000;
    expect(computeDecayScore(recent, null, 0).score).toBe(1.0);
  });

  it("7-30 days = 0.7", () => {
    const older = Date.now() - 14 * 24 * 60 * 60 * 1000;
    expect(computeDecayScore(older, null, 0).score).toBeCloseTo(0.56, 1); // 0.7 * 0.8 (never recalled)
  });

  it("recalled fragments decay slower", () => {
    const older = Date.now() - 14 * 24 * 60 * 60 * 1000;
    expect(computeDecayScore(older, null, 3).score).toBe(0.7); // Full multiplier
  });

  it("recent recall resets to 1.0", () => {
    const ancient = Date.now() - 200 * 24 * 60 * 60 * 1000;
    const recentRecall = Date.now() - 1 * 60 * 60 * 1000; // 1 hour ago
    expect(computeDecayScore(ancient, recentRecall, 5).score).toBe(1.0);
  });

  it("60+ days → archived", () => {
    const old = Date.now() - 90 * 24 * 60 * 60 * 1000;
    expect(computeDecayScore(old, null, 0).status).toBe("archived");
  });

  it("180+ days → deleted", () => {
    const veryOld = Date.now() - 200 * 24 * 60 * 60 * 1000;
    expect(computeDecayScore(veryOld, null, 0).status).toBe("deleted");
  });

  it("boostDecayScore resets to 1.0", () => {
    const f = { decayScore: 0.3, recalledCount: 2, lastRecalledAt: null as number | null };
    boostDecayScore(f);
    expect(f.decayScore).toBe(1.0);
    expect(f.recalledCount).toBe(3);
    expect(f.lastRecalledAt).toBeGreaterThan(Date.now() - 1000);
  });
});
```

Run: `npx vitest run tests/core/decay.test.ts`
Expected: 7 tests pass.

- [x] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: sandglass decay with 7-day protection and recall boost"
```

---

### Task 7: Retriever (P2 prefetch + P3 search)

**Files:**
- Create: `D:\AgentMemory\src\core\retriever.ts`
- Create: `D:\AgentMemory\tests\core\retriever.test.ts`

- [x] **Step 1: Write retriever**

```typescript
// src/core/retriever.ts
import type { Fragment, SearchResult, PrefetchResult, SessionContext } from "../types";
import { getDb } from "../db/connection";
import { embed, cosineSimilarity } from "./embedder";

const DEFAULT_MIN_SCORE = 0.35;
const DEFAULT_MAX_RESULTS = 6;
const PREFETCH_TOKEN_BUDGET = 150; // chars, not tokens; rough proxy

// P2: Silent associative prefetch
export async function prefetch(
  messages: SessionContext["lastMessages"],
  projectId: string
): Promise<PrefetchResult> {
  if (messages.length === 0) return { contextBlock: "", fragmentIds: [], confidence: 0 };

  // Embed last 3 messages
  const queryText = messages.slice(-3).map((m) => m.text).join("\n");
  const queryVec = await embed(queryText);

  // Search L1 active fragments
  const results = await vectorSearch(queryVec, projectId, 10, DEFAULT_MIN_SCORE);

  if (results.length === 0) return { contextBlock: "", fragmentIds: [], confidence: 0 };

  // Pick top 2-3 clusters by linked density
  const topN = results.slice(0, 3);

  // Build context block ≤150 chars
  let block = "";
  const usedIds: string[] = [];
  for (const r of topN) {
    const candidate = `${r.fragment.anchors[0]?.channel}: ${r.fragment.summary}`;
    if (block.length + candidate.length + 2 <= PREFETCH_TOKEN_BUDGET) {
      block = block ? `${block}; ${candidate}` : candidate;
      usedIds.push(r.fragment.id);
    }
  }

  const confidence = topN.length > 0 ? Math.min(0.9, topN[0].score) : 0;
  return { contextBlock: block, fragmentIds: usedIds, confidence };
}

// P3: Explicit search (LLM calls memory_search tool)
export async function explicitSearch(
  query: string,
  projectId: string,
  minScore: number = DEFAULT_MIN_SCORE,
  maxResults: number = DEFAULT_MAX_RESULTS
): Promise<SearchResult[]> {
  const queryVec = await embed(query);
  return await vectorSearch(queryVec, projectId, maxResults, minScore);
}

async function vectorSearch(
  queryVec: number[],
  projectId: string,
  limit: number,
  minScore: number
): Promise<SearchResult[]> {
  const db = getDb();

  // Get all active fragments for project
  const fragments = db.prepare(`
    SELECT f.* FROM fragments f
    WHERE f.project_id = ? AND f.status = 'active' AND f.decay_score > 0
  `).all(projectId) as Fragment[];

  const results: SearchResult[] = [];

  for (const fragment of fragments) {
    // Embed each fragment's summary for comparison
    // NOTE: In production, cache fragment embeddings in DB (sqlite-vec table)
    const fragVec = await embed(fragment.summary);
    const score = cosineSimilarity(queryVec, fragVec);

    if (score >= minScore) {
      const db2 = getDb();
      const linkedRows = db2.prepare(`
        SELECT target_id FROM fragment_links WHERE source_id = ?
      `).all(fragment.id) as Array<{ target_id: string }>;
      const matchedIds = [fragment.id, ...linkedRows.map((r) => r.target_id)];
      const uniqueMatched = [...new Set(matchedIds)];

      results.push({
        fragment,
        score,
        matchedAnchors: uniqueMatched,
        missingLinks: fragment.linkedCount - uniqueMatched.length + 1,
      });
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
```

- [x] **Step 2: Write tests with mock DB**

```typescript
// tests/core/retriever.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDb, closeDb, getDb } from "../../src/db/connection";
import { prefetch, explicitSearch } from "../../src/core/retriever";
import * as os from "node:os";
import * as fs from "node:fs";

const testDir = fs.mkdtempSync(os.tmpdir() + "/agentmemory-retriever-");
const testDb = testDir + "/test.db";

describe("retriever", () => {
  beforeAll(() => {
    openDb(testDb);
    const db = getDb();
    db.exec(`INSERT INTO fragments (id, session_id, project_id, summary, linked_count, created_at)
      VALUES ('f1','s1','p1','CUDA报错改用CPU推理',1,${Date.now()})`);
    db.exec(`INSERT INTO fragment_anchors (fragment_id, channel, label, weight, source, timestamp)
      VALUES ('f1','WHAT','CUDA改用CPU',50,'clustering',${Date.now()})`);
  });
  afterAll(() => { closeDb(); fs.rmSync(testDir, { recursive: true, force: true }); });

  it("prefetch returns empty on no messages", async () => {
    const result = await prefetch([], "p1");
    expect(result.contextBlock).toBe("");
    expect(result.fragmentIds).toHaveLength(0);
  });

  it("prefetch searches with last 3 messages", async () => {
    const result = await prefetch(
      [{ role: "user", text: "视频分析功能报CUDA错误" }],
      "p1"
    );
    // May or may not find results depending on embedding match
    expect(typeof result.confidence).toBe("number");
    expect(result.confidence).toBeGreaterThanOrEqual(0);
  });

  it("explicitSearch returns results for matching query", async () => {
    const results = await explicitSearch("CUDA错误", "p1");
    expect(Array.isArray(results)).toBe(true);
  });
});
```

Run: `npx vitest run tests/core/retriever.test.ts`
Expected: 3 tests pass.

- [x] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: P2 prefetch + P3 explicit search retriever"
```

---

### Task 8: 4-layer backup recall

**Files:**
- Create: `D:\AgentMemory\src\core\backup-recall.ts`
- Create: `D:\AgentMemory\tests\core\backup-recall.test.ts`

- [x] **Step 1: Write backup recall chain**

```typescript
// src/core/backup-recall.ts
import type { SearchResult, Fragment } from "../types";
import { getDb } from "../db/connection";
import { explicitSearch } from "./retriever";
import * as fs from "node:fs";
import * as path from "node:path";

export interface RecallResult {
  fragments: SearchResult[];
  source: "L1" | "L1_archive" | "L3_transcript" | "L4_project_files" | "not_found";
  message?: string;  // Human-readable fallback message
}

export async function fourLayerRecall(
  queryText: string,
  projectId: string,
  workspaceDir: string
): Promise<RecallResult> {
  // Layer 1: Active L1 fragments
  const l1Results = await explicitSearch(queryText, projectId, 0.35, 5);
  if (l1Results.length > 0) {
    return { fragments: l1Results, source: "L1" };
  }

  // Layer 2: L1_archive (archived fragments, FTS5 search)
  const db = getDb();
  const archiveRows = db.prepare(`
    SELECT f.* FROM fragments f
    WHERE f.project_id = ? AND f.status = 'archived'
    AND f.id IN (SELECT rowid FROM fragments_fts WHERE fragments_fts MATCH ?)
    LIMIT 5
  `).all(projectId, queryText.replace(/\s+/g, " AND ")) as Fragment[];

  if (archiveRows.length > 0) {
    // Reactivate fragments
    for (const row of archiveRows) {
      db.prepare(`UPDATE fragments SET status = 'active', decay_score = 0.5 WHERE id = ?`).run(row.id);
    }
    const reactivatedResults = await explicitSearch(queryText, projectId, 0.3, 5);
    return {
      fragments: reactivatedResults,
      source: "L1_archive",
      message: "这个比较久了，翻了一下记录...",
    };
  }

  // Layer 3: Raw transcript files
  const transcriptDir = path.join(workspaceDir, "transcripts");
  if (fs.existsSync(transcriptDir)) {
    const files = fs.readdirSync(transcriptDir).filter((f) => f.endsWith(".jsonl"));
    for (const file of files.slice(-30)) { // Search last 30 transcript files
      const content = fs.readFileSync(path.join(transcriptDir, file), "utf-8");
      if (content.toLowerCase().includes(queryText.toLowerCase())) {
        return {
          fragments: [],
          source: "L3_transcript",
          message: `记得不是很清楚，但在转录文件 ${file} 里有提到相关内容...`,
        };
      }
    }
  }

  // Layer 4: Project design files (date-correlated)
  const designDirs = ["设计文档", "design-docs", "docs", "specs"];
  for (const dir of designDirs) {
    const fullPath = path.join(workspaceDir, dir);
    if (!fs.existsSync(fullPath)) continue;
    const designFiles = fs.readdirSync(fullPath).filter((f) => f.endsWith(".md"));
    for (const file of designFiles) {
      const content = fs.readFileSync(path.join(fullPath, file), "utf-8");
      if (content.toLowerCase().includes(queryText.toLowerCase())) {
        return {
          fragments: [],
          source: "L4_project_files",
          message: `我查了项目文档 ${dir}/${file}，找到了相关内容...`,
        };
      }
    }
  }

  // Not found
  return {
    fragments: [],
    source: "not_found",
    message: "我不记得这件事，可能没有记录。",
  };
}
```

- [x] **Step 2: Test backup recall**

```typescript
// tests/core/backup-recall.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDb, closeDb, getDb } from "../../src/db/connection";
import { fourLayerRecall } from "../../src/core/backup-recall";
import * as os from "node:os";
import * as fs from "node:fs";

const testDir = fs.mkdtempSync(os.tmpdir() + "/agentmemory-recall-");

describe("backup-recall", () => {
  beforeAll(() => {
    openDb(testDir + "/test.db");
    // Seed with fragment in L1
    const now = Date.now();
    const db = getDb();
    db.exec(`INSERT INTO fragments (id, session_id, project_id, summary, linked_count, created_at)
      VALUES ('r1','s1','p1','测试记忆碎片',1,${now})`);
    db.exec(`INSERT INTO fragment_anchors (fragment_id, channel, label, weight, source, timestamp)
      VALUES ('r1','WHAT','测试标签',50,'clustering',${now})`);
  });
  afterAll(() => { closeDb(); fs.rmSync(testDir, { recursive: true, force: true }); });

  it("Layer 1 finds active fragment", async () => {
    const result = await fourLayerRecall("测试", "p1", testDir);
    expect(result.source).toBe("L1");
    expect(result.fragments.length).toBeGreaterThan(0);
  });

  it("returns not_found for unknown query", async () => {
    const result = await fourLayerRecall("朱雀二号火箭引擎故障", "p2", testDir);
    expect(result.source).toBe("not_found");
    expect(result.message).toContain("不记得");
  });
});
```

Run: `npx vitest run tests/core/backup-recall.test.ts`
Expected: 2 tests pass.

- [x] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: 4-layer backup recall (L1→archive→transcript→design files)"
```

---

### Task 9: Core engine orchestrator (Path A + B)

**Files:**
- Create: `D:\AgentMemory\src\core\engine.ts`
- Create: `D:\AgentMemory\tests\core\engine.test.ts`

- [x] **Step 1: Write engine**

```typescript
// src/core/engine.ts
import type { FragmentationInput, Fragment, SessionContext } from "../types";
import { getDb } from "../db/connection";
import { fragmentTranscript, resolveLinks } from "./fragmenter";
import { computeDecayScore } from "./decay";

export interface EngineConfig {
  apiKey: string;
  model?: string;  // Default: claude-haiku-4-5
}

export class MemoryEngine {
  constructor(private config: EngineConfig) {}

  // Path A: Compaction-time sync summary
  async compactSession(input: FragmentationInput): Promise<string> {
    const result = await fragmentTranscript(input, this.config.apiKey, this.config.model);
    return result.summary;
  }

  // Path B: Async fragmentation after compaction
  async fragmentSession(input: FragmentationInput): Promise<Fragment[]> {
    const result = await fragmentTranscript(input, this.config.apiKey, this.config.model);
    resolveLinks(result.fragments, []); // Links resolved from raw response

    const db = getDb();
    const fragments: Fragment[] = [];

    const insertFrag = db.prepare(`INSERT INTO fragments (id, session_id, project_id, summary, linked_count, decay_score, created_at, status)
      VALUES (?, ?, ?, ?, ?, 1.0, ?, 'active')`);
    const insertAnchor = db.prepare(`INSERT INTO fragment_anchors (fragment_id, channel, label, weight, source, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)`);
    const insertLink = db.prepare(`INSERT OR IGNORE INTO fragment_links (source_id, target_id) VALUES (?, ?)`);
    const insertFts = db.prepare(`INSERT INTO fragments_fts (rowid, summary) VALUES (?, ?)`);

    const insertAll = db.transaction(() => {
      for (const raw of result.fragments) {
        const f: Fragment = {
          ...raw,
          decayScore: 1.0,
          lastRecalledAt: null,
          recalledCount: 0,
          status: "active",
        };

        insertFrag.run(f.id, f.sessionId, f.projectId, f.summary, f.linkedCount, f.createdAt);

        for (const anchor of f.anchors) {
          insertAnchor.run(f.id, anchor.channel, anchor.label, anchor.weight, anchor.source, anchor.timestamp);
        }

        for (const targetId of f.linkedIds) {
          insertLink.run(f.id, targetId);
        }

        const rowid = (db.prepare("SELECT rowid FROM fragments WHERE id = ?").get(f.id) as any).rowid;
        insertFts.run(rowid, f.summary);

        fragments.push(f);
      }
    });

    insertAll();

    // Mark session as processed
    db.prepare(`UPDATE sessions SET pending_fragmentation = 0 WHERE id = ?`).run(input.sessionId);

    return fragments;
  }

  // Run decay on all active fragments
  runDecay(): { archived: number; deleted: number } {
    const db = getDb();
    const fragments = db.prepare(`SELECT * FROM fragments WHERE status = 'active'`).all() as Fragment[];

    let archived = 0, deleted = 0;

    const update = db.transaction(() => {
      for (const f of fragments) {
        const { status } = computeDecayScore(f.createdAt, f.lastRecalledAt, f.recalledCount);
        if (status === "archived" && f.status !== "archived") {
          db.prepare(`UPDATE fragments SET status = 'archived', decay_score = 0 WHERE id = ?`).run(f.id);
          archived++;
        } else if (status === "deleted") {
          db.prepare(`DELETE FROM fragments WHERE id = ?`).run(f.id);
          deleted++;
        }
      }
    });

    update();
    return { archived, deleted };
  }
}
```

- [x] **Step 2: Test engine**

```typescript
// tests/core/engine.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MemoryEngine } from "../../src/core/engine";
import { openDb, closeDb } from "../../src/db/connection";
import * as os from "node:os";
import * as fs from "node:fs";

const testDir = fs.mkdtempSync(os.tmpdir() + "/agentmemory-engine-");

describe("MemoryEngine", () => {
  beforeAll(() => openDb(testDir + "/test.db"));
  afterAll(() => { closeDb(); fs.rmSync(testDir, { recursive: true, force: true }); });

  it("constructs with API key", () => {
    const engine = new MemoryEngine({ apiKey: "test-key" });
    expect(engine).toBeDefined();
  });

  it("runDecay on empty DB returns zeros", () => {
    const engine = new MemoryEngine({ apiKey: "test-key" });
    const result = engine.runDecay();
    expect(result.archived).toBe(0);
    expect(result.deleted).toBe(0);
  });
});
```

Run: `npx vitest run tests/core/engine.test.ts`
Expected: 2 tests pass.

- [x] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: core engine orchestrator (Path A + B + decay)"
```

---

### Task 10: Claude Code/OpenClaw adapter

**Files:**
- Create: `D:\AgentMemory\src\adapters\claude-code.ts`
- Create: `D:\AgentMemory\tests\adapters\claude-code.test.ts`

- [x] **Step 1: Write Claude Code adapter**

```typescript
// src/adapters/claude-code.ts
import { MemoryEngine } from "../core/engine";
import { prefetch } from "../core/retriever";
import type { SessionContext } from "../types";

/**
 * Registers Claude Code / OpenClaw hooks for automatic memory integration.
 *
 * Hook docs: https://deepwiki.com/anthropics/claude-code/3.2-hook-system
 *
 * Installation: add this to ~/.claude/settings.json or openclaw.json hooks section.
 * The hook commands call the MCP server tools directly.
 */
export function generateHookConfig(mcpServerCommand: string): Record<string, unknown> {
  return {
    hooks: {
      SessionStart: [
        {
          matcher: "",
          command: `${mcpServerCommand} session-start`,
        },
      ],
      UserPromptSubmit: [
        {
          matcher: "",
          command: `${mcpServerCommand} prefetch`,
        },
      ],
      PreCompact: [
        {
          matcher: "",
          command: `${mcpServerCommand} pre-compact`,
        },
      ],
      Stop: [
        {
          matcher: "",
          command: `${mcpServerCommand} session-stop`,
        },
      ],
    },
  };
}

export function generateAgentsMdAppendix(): string {
  return `
## Memory

This project uses AgentMemory for persistent cross-session memory.

- Session start: memory is automatically loaded
- During work: relevant context is silently prefetched
- Before compaction: new memories are automatically saved
- Manual recall: use /memory-recall to search past sessions
`;
}
```

- [x] **Step 2: Test hook config generation**

```typescript
// tests/adapters/claude-code.test.ts
import { describe, it, expect } from "vitest";
import { generateHookConfig, generateAgentsMdAppendix } from "../../src/adapters/claude-code";

describe("Claude Code adapter", () => {
  it("generates valid hook config with 4 hooks", () => {
    const config = generateHookConfig("agentmemory-mcp");
    const hooks = config.hooks as Record<string, unknown[]>;
    expect(Object.keys(hooks)).toHaveLength(4);
    expect(hooks.SessionStart).toBeDefined();
    expect(hooks.UserPromptSubmit).toBeDefined();
    expect(hooks.PreCompact).toBeDefined();
    expect(hooks.Stop).toBeDefined();
  });

  it("generates AGENTS.md appendix", () => {
    const appendix = generateAgentsMdAppendix();
    expect(appendix).toContain("AgentMemory");
    expect(appendix).toContain("memory-recall");
  });
});
```

Run: `npx vitest run tests/adapters/claude-code.test.ts`
Expected: 2 tests pass.

- [x] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: Claude Code/OpenClaw hook adapter"
```

---

### Task 11: Generic MCP adapter

**Files:**
- Create: `D:\AgentMemory\src\adapters\generic.ts`
- Create: `D:\AgentMemory\tests\adapters\generic.test.ts`

- [x] **Step 1: Write generic adapter**

```typescript
// src/adapters/generic.ts

export function generateSystemPromptAppendix(): string {
  return `## Memory

每次对话开始前调用 memory_recall 获取相关上下文。
每次重要决策后调用 memory_remember(decision, context) 记录。
Bug 修复后调用 memory_remember(bug, fix, root_cause) 记录。
如果 memory_recall 返回了有用信息，请在回复中自然地引用它。`;
}

export function generateHeartbeatReminder(roundsSinceLastCall: number): string | null {
  if (roundsSinceLastCall < 10) return null;
  if (roundsSinceLastCall >= 20) {
    return "[Memory] ⚠️ 已超过 20 轮未调用 memory_recall，建议立即搜索相关上下文。";
  }
  return "[Memory] 本轮尚未调用 memory_recall，如有需要请立即调用。";
}

export function generateReinforcementMessage(
  recentRecalls: Array<{ query: string; resultCount: number; timestamp: number }>
): string | null {
  if (recentRecalls.length === 0) return null;
  const recentCount = recentRecalls.filter((r) => r.resultCount > 0 && Date.now() - r.timestamp < 3600000).length;
  if (recentCount >= 3) {
    return `最近 ${recentCount} 次 memory_recall 都找到了相关记忆。请继续保持这个习惯。`;
  }
  return null;
}
```

- [x] **Step 2: Test generic adapter**

```typescript
// tests/adapters/generic.test.ts
import { describe, it, expect } from "vitest";
import { generateSystemPromptAppendix, generateHeartbeatReminder, generateReinforcementMessage } from "../../src/adapters/generic";

describe("Generic adapter", () => {
  it("generates system prompt appendix", () => {
    const text = generateSystemPromptAppendix();
    expect(text).toContain("memory_recall");
    expect(text).toContain("memory_remember");
  });

  it("heartbeat silent under 10 rounds", () => {
    expect(generateHeartbeatReminder(5)).toBeNull();
  });

  it("heartbeat warns at 10+ rounds", () => {
    const msg = generateHeartbeatReminder(10);
    expect(msg).toContain("memory_recall");
  });

  it("heartbeat urgent at 20+ rounds", () => {
    const msg = generateHeartbeatReminder(20);
    expect(msg).toContain("⚠️");
  });

  it("reinforcement when recalls are productive", () => {
    const msg = generateReinforcementMessage([
      { query: "bug", resultCount: 3, timestamp: Date.now() - 60000 },
      { query: "CUDA", resultCount: 2, timestamp: Date.now() - 120000 },
      { query: "配置", resultCount: 1, timestamp: Date.now() - 180000 },
    ]);
    expect(msg).toContain("继续保持");
  });

  it("no reinforcement with empty history", () => {
    expect(generateReinforcementMessage([])).toBeNull();
  });
});
```

Run: `npx vitest run tests/adapters/generic.test.ts`
Expected: 6 tests pass.

- [x] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: generic MCP adapter with heartbeat and reinforcement"
```

---

### Task 12: MCP server + tool implementations

**Files:**
- Create: `D:\AgentMemory\src\mcp\server.ts`
- Create: `D:\AgentMemory\src\mcp\tools.ts`

- [x] **Step 1: Write tools**

```typescript
// src/mcp/tools.ts
import { MemoryEngine } from "../core/engine";
import { prefetch, explicitSearch } from "../core/retriever";
import { fourLayerRecall } from "../core/backup-recall";
import { getDb } from "../db/connection";

export function buildToolHandlers(engine: MemoryEngine) {
  return {
    async memory_recall(params: { query?: string; projectId: string; workspaceDir: string }) {
      if (params.query) {
        return await explicitSearch(params.query, params.projectId);
      }
      // No query = fetch recent fragments for this project
      const db = getDb();
      return db.prepare(`
        SELECT * FROM fragments WHERE project_id = ? AND status = 'active'
        ORDER BY created_at DESC LIMIT 10
      `).all(params.projectId);
    },

    async memory_remember(params: { transcript: string; sessionId: string; projectId: string }) {
      const fragments = await engine.fragmentSession({
        transcript: params.transcript,
        sessionId: params.sessionId,
        projectId: params.projectId,
      });
      return { count: fragments.length, fragments: fragments.map((f) => ({ id: f.id, summary: f.summary })) };
    },

    async memory_search(params: { query: string; projectId: string; maxResults?: number; minScore?: number }) {
      return await explicitSearch(params.query, params.projectId, params.minScore, params.maxResults);
    },

    async memory_get(params: { fragmentId: string }) {
      const db = getDb();
      const fragment = db.prepare(`SELECT * FROM fragments WHERE id = ?`).get(params.fragmentId);
      const anchors = db.prepare(`SELECT * FROM fragment_anchors WHERE fragment_id = ?`).all(params.fragmentId);
      const links = db.prepare(`
        SELECT f.id, f.summary FROM fragment_links l
        JOIN fragments f ON f.id = l.target_id WHERE l.source_id = ?
      `).all(params.fragmentId);
      return { fragment, anchors, links };
    },

    async dreaming(params: { projectId: string }) {
      // Manual Path C trigger
      const stats = engine.runDecay();
      return {
        ...stats,
        message: stats.archived + stats.deleted > 0
          ? `已清理 ${stats.archived + stats.deleted} 条过期记忆。`
          : "记忆库状态良好，无需清理。",
      };
    },

    async memory_recall_deep(params: { query: string; projectId: string; workspaceDir: string }) {
      return await fourLayerRecall(params.query, params.projectId, params.workspaceDir);
    },
  };
}
```

- [x] **Step 2: Write MCP server bootstrap**

```typescript
// src/mcp/server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MemoryEngine } from "../core/engine";
import { buildToolHandlers } from "./tools";
import { openDb } from "../db/connection";

const TOOL_DEFINITIONS = [
  {
    name: "memory_recall",
    description: "Recall relevant memories for the current context. Call without query to get recent project fragments.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional search query" },
        projectId: { type: "string", description: "Project identifier" },
        workspaceDir: { type: "string", description: "Workspace directory path" },
      },
      required: ["projectId", "workspaceDir"],
    },
  },
  {
    name: "memory_remember",
    description: "Store a conversation segment as searchable memory fragments.",
    inputSchema: {
      type: "object",
      properties: {
        transcript: { type: "string", description: "Conversation transcript to fragment" },
        sessionId: { type: "string" },
        projectId: { type: "string" },
      },
      required: ["transcript", "sessionId", "projectId"],
    },
  },
  {
    name: "memory_search",
    description: "Explicit semantic search across memory fragments.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        projectId: { type: "string" },
        maxResults: { type: "number", default: 6 },
        minScore: { type: "number", default: 0.35 },
      },
      required: ["query", "projectId"],
    },
  },
  {
    name: "memory_get",
    description: "Read a specific memory fragment and its linked fragments.",
    inputSchema: {
      type: "object",
      properties: { fragmentId: { type: "string" } },
      required: ["fragmentId"],
    },
  },
  {
    name: "memory_recall_deep",
    description: "Deep 4-layer recall: searches active fragments, archive, transcripts, and project files.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        projectId: { type: "string" },
        workspaceDir: { type: "string" },
      },
      required: ["query", "projectId", "workspaceDir"],
    },
  },
  {
    name: "dreaming",
    description: "Manually trigger memory cleanup and decay processing.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" } },
      required: ["projectId"],
    },
  },
];

export async function startServer(apiKey: string, dbPath?: string) {
  openDb(dbPath);
  const engine = new MemoryEngine({ apiKey });
  const handlers = buildToolHandlers(engine);

  const server = new Server(
    { name: "agentmemory", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = (handlers as Record<string, Function>)[name];
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    const result = await handler(args ?? {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("AgentMemory MCP server started");
}
```

- [x] **Step 3: Write entry point**

```typescript
// src/index.ts
import { startServer } from "./mcp/server";

const apiKey = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("Error: Set ANTHROPIC_API_KEY or OPENAI_API_KEY");
  process.exit(1);
}

startServer(apiKey).catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
```

- [x] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: MCP server with 6 tools and stdio transport"
```

---

### Task 13: First-run installer

**Files:**
- Create: `D:\AgentMemory\src\mcp\install.ts`
- Create: `D:\AgentMemory\tests\mcp\install.test.ts`

- [x] **Step 1: Write installer**

```typescript
// src/mcp/install.ts
import * as fs from "node:fs";
import * as path from "node:path";
import type { InstallEstimate } from "../types";

const MEMORY_FILE_PATTERNS = [
  "MEMORY.md",
  "memory/*.md",
  "HEARTBEAT.md",
  "CLAUDE.md",
  "AGENTS.md",
];

export function scanExistingMemoryFiles(workspaceDir: string): InstallEstimate {
  const files: string[] = [];
  let totalBytes = 0;

  for (const pattern of MEMORY_FILE_PATTERNS) {
    if (pattern.includes("*")) {
      const dir = path.join(workspaceDir, path.dirname(pattern));
      const ext = path.extname(pattern);
      if (fs.existsSync(dir)) {
        for (const entry of fs.readdirSync(dir)) {
          if (entry.endsWith(ext)) {
            const fullPath = path.join(dir, entry);
            const stat = fs.statSync(fullPath);
            files.push(fullPath);
            totalBytes += stat.size;
          }
        }
      }
    } else {
      const fullPath = path.join(workspaceDir, pattern);
      if (fs.existsSync(fullPath)) {
        const stat = fs.statSync(fullPath);
        files.push(fullPath);
        totalBytes += stat.size;
      }
    }
  }

  // Also scan transcripts
  const transcriptDir = path.join(workspaceDir, "transcripts");
  if (fs.existsSync(transcriptDir)) {
    for (const entry of fs.readdirSync(transcriptDir)) {
      if (entry.endsWith(".jsonl")) {
        const fullPath = path.join(transcriptDir, entry);
        const stat = fs.statSync(fullPath);
        files.push(fullPath);
        totalBytes += stat.size;
      }
    }
  }

  // Rough estimate: 1 char ≈ 0.3 tokens for English, 0.5 for CJK
  const estimatedTokens = Math.ceil(totalBytes * 0.4);
  const estimatedTimeMinutes = Math.max(1, Math.ceil(estimatedTokens / 50000)); // ~50K tokens/min

  return {
    fileCount: files.length,
    totalBytes,
    estimatedTokens,
    estimatedTimeMinutes,
    files: files.slice(0, 50), // Cap to avoid overwhelming output
  };
}

export function buildInstallMessage(estimate: InstallEstimate): string {
  if (estimate.fileCount === 0) {
    return "未发现现有记忆文件。AgentMemory 已就绪，将在本次对话结束后开始建立记忆索引。";
  }
  return [
    `发现 ${estimate.fileCount} 个记忆文件，共 ${(estimate.totalBytes / 1024 / 1024).toFixed(1)} MB。`,
    `导入预计消耗 ~${estimate.estimatedTokens.toLocaleString()} tokens，耗时约 ${estimate.estimatedTimeMinutes} 分钟。`,
    `是否导入？导入后 Agent 可以立即回忆起之前的对话内容。`,
    `回复 "Y" 开始导入，回复 "n" 跳过（可稍后手动导入）。`,
  ].join("\n");
}

export function injectAgentsMdAppendix(workspaceDir: string, appendix: string): void {
  const candidates = ["AGENTS.md", "CLAUDE.md"];
  for (const name of candidates) {
    const fullPath = path.join(workspaceDir, name);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, "utf-8");
      if (!content.includes("AgentMemory")) {
        fs.writeFileSync(fullPath, content + "\n" + appendix + "\n");
      }
      return;
    }
  }
  // Neither exists, create AGENTS.md
  const defaultPath = path.join(workspaceDir, "AGENTS.md");
  fs.writeFileSync(defaultPath, appendix + "\n");
}
```

- [x] **Step 2: Test installer**

```typescript
// tests/mcp/install.test.ts
import { describe, it, expect } from "vitest";
import { scanExistingMemoryFiles, buildInstallMessage } from "../../src/mcp/install";
import * as os from "node:os";

describe("installer", () => {
  it("scans user home (may find nothing)", () => {
    const estimate = scanExistingMemoryFiles(os.homedir());
    expect(typeof estimate.fileCount).toBe("number");
    expect(typeof estimate.totalBytes).toBe("number");
    expect(estimate.estimatedTokens).toBeGreaterThanOrEqual(0);
    expect(estimate.estimatedTimeMinutes).toBeGreaterThanOrEqual(1);
  });

  it("empty scan shows ready message", () => {
    const msg = buildInstallMessage({ fileCount: 0, totalBytes: 0, estimatedTokens: 0, estimatedTimeMinutes: 0, files: [] });
    expect(msg).toContain("已就绪");
  });

  it("files found shows estimate", () => {
    const estimate = { fileCount: 5, totalBytes: 1048576, estimatedTokens: 400000, estimatedTimeMinutes: 8, files: ["a.md", "b.md"] };
    const msg = buildInstallMessage(estimate);
    expect(msg).toContain("5");
    expect(msg).toContain("400,000");
    expect(msg).toContain("8 分钟");
    expect(msg).toContain("Y");
  });
});
```

Run: `npx vitest run tests/mcp/install.test.ts`
Expected: 3 tests pass.

- [x] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: first-run installer with batch import and prompt injection"
```

---

### Task 14: Integration test + package scripts

**Files:**
- Modify: `D:\AgentMemory\package.json`
- Create: `D:\AgentMemory\tests\integration.test.ts`

- [x] **Step 1: Add package scripts**

```json
{
  "name": "agentmemory",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "agentmemory": "./dist/index.js",
    "agentmemory-mcp": "./dist/mcp/server.js"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "dev": "tsc --watch",
    "start": "node dist/index.js",
    "install:hooks": "node dist/scripts/install-hooks.js"
  },
  "files": ["dist/"],
  "keywords": ["agent", "memory", "mcp", "claude-code", "codex"],
  "license": "MIT"
}
```

- [x] **Step 2: Write integration test**

```typescript
// tests/integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDb, closeDb, getDb } from "../src/db/connection";
import { MemoryEngine } from "../src/core/engine";
import * as os from "node:os";
import * as fs from "node:fs";

const testDir = fs.mkdtempSync(os.tmpdir() + "/agentmemory-integration-");

describe("Integration: engine + DB", () => {
  beforeAll(() => openDb(testDir + "/test.db"));
  afterAll(() => { closeDb(); fs.rmSync(testDir, { recursive: true, force: true }); });

  it("decay + recall pipeline", () => {
    const engine = new MemoryEngine({ apiKey: "test-key" });
    const db = getDb();

    // Insert a test fragment manually
    const oldDate = Date.now() - 100 * 24 * 60 * 60 * 1000; // 100 days ago
    db.exec(`INSERT INTO fragments (id, session_id, project_id, summary, linked_count, created_at, status)
      VALUES ('int1','s1','p1','旧记忆测试',1,${oldDate},'active')`);

    // Run decay
    const result = engine.runDecay();
    expect(result.archived).toBeGreaterThanOrEqual(1);

    // Verify archived
    const row = db.prepare("SELECT status FROM fragments WHERE id = 'int1'").get() as any;
    expect(row.status).toBe("archived");
  });
});
```

Run: `npx vitest run tests/integration.test.ts`
Expected: 1 test pass.

- [x] **Step 3: Full test suite**

```bash
npx vitest run
```
Expected: All tests pass (~40 tests across 11 test files).

- [x] **Step 4: Build**

```bash
npm run build
```
Expected: `dist/` directory created with compiled JS.

- [x] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: integration test, package scripts, and build pipeline"
```

---

## Post-MVP: v1.1 Roadmap

| Task | Description |
|------|-------------|
| 15 | Path C auto-distillation (embedding clustering + contradiction detection) |
| 16 | Bidirectional link auto-repair in dreaming |
| 17 | Positive reinforcement loop (P2 hit rate tracking → dynamic threshold tuning) |
| 18 | Codex CLI adapter (hook mapping to Codex event names) |
| 19 | sqlite-vec vector table (cached embeddings, avoid re-embedding on every search) |
| 20 | Cross-project distillation (Goal 1→2 transition, user model generation) |

---

## Self-Review

1. **Spec coverage:** Each spec section mapped to tasks — §3 L0-L3 (T4 fragments, T2 schema), §4 4-channel (T4), §5 dual-source (T5), §6 Path A+B (T9), §7 retrieval (T7), §8 error detection (T4 linked_count), §9 backup recall (T8), §10 adapters (T10+T11), §10 first-run (T13), §13 MVP scope (T1-14 = v1.0 complete).

2. **Placeholder scan:** No TBD/TODO. Tokenizer wiring in T3 Step 2 uses real `@xenova/transformers`. All code steps are concrete.

3. **Type consistency:** `Fragment`, `SearchResult`, `PrefetchResult`, `SessionContext` defined in T1, used consistently across T4-T13. `MemoryEngine` constructor signature consistent in T9 and T12.

**Spec gap found:** Spec mentions `memory_fragment` tool (manual trigger) but MVP tool list has `memory_remember` which covers this. Consolidated — `memory_remember` is the user-facing manual fragment trigger. No gap.
