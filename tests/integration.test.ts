import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

// Mock @xenova/transformers to avoid loading the "sharp" native module
// (which wasn't built because npm install was run with --ignore-scripts).
// The only import from embedder.ts used in these tests is cosineSimilarity,
// which is a pure math function and does not use the pipeline.
vi.mock("@xenova/transformers", () => ({
  pipeline: vi.fn().mockResolvedValue(vi.fn()),
}));

import { openDb, closeDb, getDb } from "../src/db/connection.js";
import { MemoryEngine } from "../src/core/engine.js";
import { parseFragmentationResponse, buildFragmentationPrompt } from "../src/core/fragmenter.js";
import { detectBehaviorSignals, computeFeelWeight } from "../src/core/signal-channel.js";
import { computeDecayScore, boostDecayScore } from "../src/core/decay.js";
import { cosineSimilarity } from "../src/core/embedder.js";
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

  it("engine: runDecay on empty DB returns zeros", () => {
    const engine = new MemoryEngine({ apiKey: "test-key" });
    const result = engine.runDecay();
    expect(result.archived).toBe(0);
    expect(result.deleted).toBe(0);
  });
});
