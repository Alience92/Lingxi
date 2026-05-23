import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

import { openDb, closeDb, getDb } from "../src/db/connection.js";
import { MemoryEngine } from "../src/core/engine.js";
import { parseFragmentationResponse, buildFragmentationPrompt } from "../src/core/fragmenter.js";
import { detectBehaviorSignals, computeFeelWeight } from "../src/core/signal-channel.js";
import { computeDecayScore, boostDecayScore } from "../src/core/decay.js";
import { cosineSimilarity } from "../src/core/embedder.js";
import { prefetch, explicitSearch } from "../src/core/retriever.js";
import { persistFragments } from "../src/db/repository.js";
import { fourLayerRecall } from "../src/core/backup-recall.js";
import { generateHeartbeatReminder, generateReinforcementMessage, generateSystemPromptAppendix } from "../src/adapters/generic.js";
import * as os from "node:os";
import * as fs from "node:fs";

const testDir = fs.mkdtempSync(os.tmpdir() + "/agentmemory-int-");

describe("AgentMemory integration", () => {
  beforeAll(() => openDb(testDir + "/test.db"));
  afterAll(() => { closeDb(); fs.rmSync(testDir, { recursive: true, force: true }); });

  it("builds fragmentation prompt", () => {
    const prompt = buildFragmentationPrompt("测试对话内容");
    expect(prompt).toContain("测试对话内容");
    expect(prompt).toContain("WHAT");
    expect(prompt).toContain("FEEL");
    expect(prompt).toContain("WHO");
    expect(prompt).toContain("WHERE");
  });

  it("parses valid fragmentation JSON", () => {
    const json = JSON.stringify([
      { channel: "WHAT", label: "决策记录", weight: 10, linkedTo: [1], summary: "用户决定用方案A而非方案B" },
      { channel: "FEEL", label: "用户纠正", weight: 80, linkedTo: [0], summary: "用户说不对，上次不是这样" },
      { channel: "WHERE", label: "项目X", weight: 10, linkedTo: [], summary: "项目X的配置文件" },
    ]);
    const result = parseFragmentationResponse(json, "s1", "p1");
    expect(result.fragments).toHaveLength(3);
    expect(result.fragments[0].anchors[0].channel).toBe("WHAT");
    expect(result.fragments[1].anchors[0].weight).toBe(80);
    expect(result.summary).toContain("方案A");
  });

  it("rejects invalid channel names", () => {
    const bad = JSON.stringify([{ channel: "INVALID", label: "x", weight: 10, linkedTo: [], summary: "test" }]);
    const result = parseFragmentationResponse(bad, "s1", "p1");
    expect(result.fragments).toHaveLength(0);
  });

  it("detects behavior signals", () => {
    const signals = detectBehaviorSignals("不对，上次用的是CPU不是GPU", "建议用GPU推理");
    expect(signals.some((s) => s.signal === "correction")).toBe(true);
  });

  it("computes feel weight with both sources", () => {
    const weight = computeFeelWeight(
      [{ signal: "correction", weight: 80 }],
      { signal: "recurring_pattern", weight: 90 }
    );
    expect(weight).toBe(90); // max of both
  });

  it("computes decay: 7-day protection", () => {
    const recentDate = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const result = computeDecayScore(recentDate, null, 0);
    expect(result.score).toBe(1.0);
    expect(result.status).toBe("active");
  });

  it("computes decay: 90-day → archived", () => {
    const oldDate = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const result = computeDecayScore(oldDate, null, 0);
    expect(result.status).toBe("archived");
  });

  it("boost resets decay to 1.0", () => {
    const frag = { decayScore: 0.3, recalledCount: 2, lastRecalledAt: null as number | null };
    boostDecayScore(frag);
    expect(frag.decayScore).toBe(1.0);
    expect(frag.recalledCount).toBe(3);
    expect(frag.lastRecalledAt).toBeGreaterThan(0);
  });

  it("cosine similarity: identical = 1.0", () => {
    const vec = new Array(384).fill(0.05);
    expect(cosineSimilarity(vec, vec)).toBeCloseTo(1.0, 4);
  });

  it("DB: schema creates all tables", () => {
    const db = getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("fragments");
    expect(names).toContain("fragment_anchors");
    expect(names).toContain("fragment_links");
    expect(names).toContain("distilled_rules");
    expect(names).toContain("recall_log");
    expect(names).toContain("sessions");
    expect(names).toContain("projects");
  });

  it("DB: distilled_rules has fingerprint column", () => {
    const columns = getDb().prepare("PRAGMA table_info(distilled_rules)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "fingerprint")).toBe(true);
  });

  it("engine: runDecay on empty DB returns zeros", () => {
    const engine = new MemoryEngine({ apiKey: "test-key" });
    const result = engine.runDecay();
    expect(result.archived).toBe(0);
    expect(result.deleted).toBe(0);
  });

  it("engine: fragmentSession clears pending flag on empty fragmentation result", async () => {
    const engine = new MemoryEngine({ apiKey: "test-key" });
    await engine.compactSession({ transcript: "test transcript", sessionId: "pending-s1", projectId: "pending-p1" });

    let session = getDb().prepare("SELECT pending_fragmentation FROM sessions WHERE id = ?").get("pending-s1") as { pending_fragmentation: number };
    expect(session.pending_fragmentation).toBe(1);

    const fragments = await engine.fragmentSession({ transcript: "test transcript", sessionId: "pending-s1", projectId: "pending-p1" });
    expect(fragments).toHaveLength(0);

    session = getDb().prepare("SELECT pending_fragmentation FROM sessions WHERE id = ?").get("pending-s1") as { pending_fragmentation: number };
    expect(session.pending_fragmentation).toBe(0);
  });

  it("prefetch prefers diversity over duplicate summaries", async () => {
    await persistFragments({
      sessionId: "prefetch-s1",
      projectId: "prefetch-p1",
      output: {
        summary: "",
        fragments: [
          {
            id: "dup-1",
            sessionId: "prefetch-s1",
            projectId: "prefetch-p1",
            anchors: [{ channel: "WHAT", label: "GPU decision", weight: 100, source: "clustering", timestamp: Date.now() }],
            linkedIds: [],
            linkedCount: 0,
            summary: "use GPU inference for this pipeline",
            createdAt: Date.now(),
          },
          {
            id: "dup-2",
            sessionId: "prefetch-s1",
            projectId: "prefetch-p1",
            anchors: [{ channel: "WHAT", label: "GPU decision", weight: 100, source: "clustering", timestamp: Date.now() }],
            linkedIds: [],
            linkedCount: 0,
            summary: "use GPU inference for this pipeline",
            createdAt: Date.now(),
          },
          {
            id: "diverse-1",
            sessionId: "prefetch-s1",
            projectId: "prefetch-p1",
            anchors: [{ channel: "WHERE", label: "CPU fallback", weight: 80, source: "clustering", timestamp: Date.now() }],
            linkedIds: [],
            linkedCount: 0,
            summary: "fallback to CPU when CUDA is unavailable",
            createdAt: Date.now(),
          },
        ],
      },
    });

    const result = await prefetch([{ role: "user", text: "should we use gpu or cpu fallback" }], "prefetch-p1");
    expect(result.fragmentIds).toContain("dup-1");
    expect(result.fragmentIds).toContain("diverse-1");
    expect(result.fragmentIds).not.toContain("dup-2");
  });

  it("persists forward-reference links correctly (P0 regression)", async () => {
    // Fragment 0 links to 1 and 2 — both come after it in the array.
    // This simulates resolveLinks output where linkedTo indices map to later UUIDs.
    const fragments = await persistFragments({
      sessionId: "fwdref-s1",
      projectId: "fwdref-p1",
      output: {
        summary: "",
        fragments: [
          {
            id: "fwd-0",
            sessionId: "fwdref-s1",
            projectId: "fwdref-p1",
            anchors: [{ channel: "WHAT", label: "Root decision", weight: 50, source: "clustering", timestamp: Date.now() }],
            linkedIds: ["fwd-1", "fwd-2"], // forward references
            linkedCount: 2,
            summary: "root fragment linking forward",
            createdAt: Date.now(),
          },
          {
            id: "fwd-1",
            sessionId: "fwdref-s1",
            projectId: "fwdref-p1",
            anchors: [{ channel: "FEEL", label: "User correction", weight: 80, source: "behavior", timestamp: Date.now() }],
            linkedIds: ["fwd-0"], // backward reference
            linkedCount: 1,
            summary: "child fragment linking back",
            createdAt: Date.now(),
          },
          {
            id: "fwd-2",
            sessionId: "fwdref-s1",
            projectId: "fwdref-p1",
            anchors: [{ channel: "WHERE", label: "Location", weight: 10, source: "clustering", timestamp: Date.now() }],
            linkedIds: [],
            linkedCount: 0,
            summary: "leaf fragment no links",
            createdAt: Date.now(),
          },
        ],
      },
    });
    expect(fragments).toHaveLength(3);

    // Verify links in DB
    const db = getDb();
    const links = db.prepare(`
      SELECT source_id, target_id FROM fragment_links
      WHERE source_id LIKE 'fwd-%' OR target_id LIKE 'fwd-%'
      ORDER BY source_id, target_id
    `).all() as Array<{ source_id: string; target_id: string }>;
    expect(links).toHaveLength(3);
    expect(links).toContainEqual({ source_id: "fwd-0", target_id: "fwd-1" });
    expect(links).toContainEqual({ source_id: "fwd-0", target_id: "fwd-2" });
    expect(links).toContainEqual({ source_id: "fwd-1", target_id: "fwd-0" });
  });

  it("prefetch does not write recall logs, explicit search does", async () => {
    await persistFragments({
      sessionId: "recall-s1",
      projectId: "recall-p1",
      output: {
        summary: "",
        fragments: [
          {
            id: "recall-frag-1",
            sessionId: "recall-s1",
            projectId: "recall-p1",
            anchors: [{ channel: "WHAT", label: "Recall test", weight: 90, source: "clustering", timestamp: Date.now() }],
            linkedIds: [],
            linkedCount: 0,
            summary: "recall log should only be written by explicit search",
            createdAt: Date.now(),
          },
        ],
      },
    });

    await prefetch([{ role: "user", text: "recall log explicit search" }], "recall-p1");
    let count = getDb().prepare("SELECT COUNT(*) as count FROM recall_log WHERE fragment_id = ?").get("recall-frag-1") as { count: number };
    expect(count.count).toBe(0);

    await explicitSearch("recall log explicit search", "recall-p1");
    count = getDb().prepare("SELECT COUNT(*) as count FROM recall_log WHERE fragment_id = ?").get("recall-frag-1") as { count: number };
    expect(count.count).toBe(1);
  });

  it("L2 archive recall reactivates archived fragments", async () => {
    const db = getDb();
    // Create and archive a fragment manually
    const fragId = "archive-test-1";
    const archiveProject = "archive-p1";
    db.prepare(`INSERT INTO projects (id, name, workspace_dir, created_at) VALUES (?, ?, ?, ?)`).run(
      archiveProject, archiveProject, testDir, Date.now()
    );
    db.prepare(`INSERT INTO fragments (id, session_id, project_id, summary, linked_count, decay_score, created_at, status) VALUES (?, ?, ?, ?, 0, 0, ?, 'archived')`).run(
      fragId, "archive-s1", archiveProject, "this is a unique archived memory about starship design", Date.now()
    );
    // FTS needs an entry too
    const row = db.prepare("SELECT rowid FROM fragments WHERE id = ?").get(fragId) as { rowid: number };
    db.prepare("INSERT INTO fragments_fts (rowid, summary) VALUES (?, ?)").run(row.rowid, "this is a unique archived memory about starship design");

    const result = await fourLayerRecall("starship design", archiveProject, testDir);
    expect(result.source).toBe("L1_archive");
    expect(result.fragments.length).toBeGreaterThan(0);

    // Verify fragment was reactivated
    const frag = db.prepare("SELECT status FROM fragments WHERE id = ?").get(fragId) as { status: string };
    expect(frag.status).toBe("active");
  });

  it("L3 transcript recall finds matching .jsonl transcript", async () => {
    const transcriptDir = testDir + "/transcripts";
    fs.mkdirSync(transcriptDir);
    fs.writeFileSync(transcriptDir + "/session-1.jsonl", `{"role":"user","text":"we should refactor the warp drive module"}\n{"role":"assistant","text":"agreed, the plasma conduits need replacing"}`);

    const result = await fourLayerRecall("warp drive", "no-such-project", testDir);
    expect(result.source).toBe("L3_transcript");
    expect(result.message).toContain("session-1.jsonl");
  });

  it("runDistillation merges ≥3 similar-label fragments into L0 rule", async () => {
    const db = getDb();
    const distProject = "distill-p1";
    db.prepare(`INSERT OR IGNORE INTO projects (id, name, workspace_dir, created_at) VALUES (?, ?, ?, ?)`).run(
      distProject, distProject, testDir, Date.now()
    );

    // Create 3 fragments with same channel + similar label prefix
    const engine = new MemoryEngine({ apiKey: "test-key" });
    await persistFragments({
      sessionId: "distill-s1",
      projectId: distProject,
      output: {
        summary: "",
        fragments: [
          {
            id: "dist-frag-1",
            sessionId: "distill-s1",
            projectId: distProject,
            anchors: [{ channel: "FEEL", label: "代码修改前必须先讨论", weight: 90, source: "behavior", timestamp: Date.now() }],
            linkedIds: [],
            linkedCount: 0,
            summary: "任何代码修改前必须先讨论确认全部细节",
            createdAt: Date.now(),
          },
          {
            id: "dist-frag-2",
            sessionId: "distill-s1",
            projectId: distProject,
            anchors: [{ channel: "FEEL", label: "代码修改前必须先讨论", weight: 90, source: "behavior", timestamp: Date.now() }],
            linkedIds: [],
            linkedCount: 0,
            summary: "任何代码修改前需要得到明确许可后才能动手",
            createdAt: Date.now(),
          },
          {
            id: "dist-frag-3",
            sessionId: "distill-s1",
            projectId: distProject,
            anchors: [{ channel: "FEEL", label: "代码修改前必须先讨论", weight: 80, source: "behavior", timestamp: Date.now() }],
            linkedIds: [],
            linkedCount: 0,
            summary: "代码修改要先讨论再执行",
            createdAt: Date.now(),
          },
        ],
      },
    });

    const distilled = engine.runDistillation(distProject);
    expect(distilled).toBeGreaterThanOrEqual(1);

    // Verify distilled rule exists
    const rule = db.prepare("SELECT * FROM distilled_rules LIMIT 1").get() as { text: string; fingerprint: string } | undefined;
    expect(rule).toBeDefined();
    expect(rule!.text.length).toBeGreaterThan(0);

    // Verify rule_sources link back to fragments
    const sources = db.prepare("SELECT fragment_id FROM rule_sources").all() as Array<{ fragment_id: string }>;
    expect(sources.length).toBeGreaterThanOrEqual(3);
    const fragIds = sources.map((s) => s.fragment_id);
    expect(fragIds).toContain("dist-frag-1");
    expect(fragIds).toContain("dist-frag-2");
    expect(fragIds).toContain("dist-frag-3");
  });

  it("L4 design file recall finds matching .md design doc", async () => {
    const designDir = testDir + "/design-docs";
    fs.mkdirSync(designDir);
    fs.writeFileSync(designDir + "/2026-05-22-starship-architecture.md", "# Starship Architecture\n\nShield frequency harmonics at 257.4 MHz.");

    const result = await fourLayerRecall("shield frequency", "no-such-project", testDir);
    expect(result.source).toBe("L4_project_files");
    expect(result.message).toContain("design-docs/2026-05-22-starship-architecture.md");
  });

  // Generic adapter tests
  it("generateHeartbeatReminder escalates correctly", () => {
    expect(generateHeartbeatReminder(5)).toBeNull();
    expect(generateHeartbeatReminder(12)).toContain("memory_recall");
    expect(generateHeartbeatReminder(25)).toContain("⚠️");
  });

  it("generateReinforcementMessage reinforces when recall is productive", () => {
    const now = Date.now();
    expect(generateReinforcementMessage([])).toBeNull();
    expect(generateReinforcementMessage([
      { query: "q1", resultCount: 3, timestamp: now - 1000 },
      { query: "q2", resultCount: 2, timestamp: now - 2000 },
      { query: "q3", resultCount: 1, timestamp: now - 3000 },
    ])).toContain("继续保持");
    expect(generateReinforcementMessage([
      { query: "q1", resultCount: 0, timestamp: now },
    ])).toBeNull();
  });

  it("generateSystemPromptAppendix includes key instructions", () => {
    const appendix = generateSystemPromptAppendix();
    expect(appendix).toContain("memory_recall");
    expect(appendix).toContain("memory_remember");
  });
});
