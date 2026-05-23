import type { FragmentationInput, Fragment } from "../types.js";
import { getDb } from "../db/connection.js";
import { persistFragments, deleteFragment } from "../db/repository.js";
import { fragmentTranscript } from "./fragmenter.js";
import { computeDecayScore } from "./decay.js";
import { Embedder, setCurrentEmbedder } from "./embedder.js";

export interface EngineConfig {
  /** API key for embeddings (MiniMax, OpenAI, etc.). Falls back to env vars. */
  apiKey: string;
  /** API key for LLM fragmentation (DeepSeek, OpenAI, etc.). Falls back to apiKey if unset. */
  fragmentationKey?: string;
  /** Base URL for LLM fragmentation. Defaults to DeepSeek if fragmentationKey is set. */
  fragmentationBaseURL?: string;
  model?: string;
  baseURL?: string;
}

export class MemoryEngine {
  public readonly embedder: Embedder;

  constructor(private config: EngineConfig) {
    this.embedder = new Embedder(config.apiKey, config.baseURL);
    setCurrentEmbedder(this.embedder);
  }

  /** Whether server-side fragmentation is available. False → prompt-mode. */
  canFragment(): boolean {
    const key = this.config.fragmentationKey || this.config.apiKey;
    return !!(key && key.length > 10 && key !== "test-key");
  }

  // Path A: Compaction-time sync summary (lightweight, no LLM fragmentation)
  async compactSession(input: FragmentationInput): Promise<string> {
    // Path A produces only a summary + archive transcript.
    // Full fragmentation is deferred to Path B (fragmentSession).
    const db = getDb();
    db.prepare(`INSERT OR REPLACE INTO sessions (id, project_id, started_at, pending_fragmentation) VALUES (?, ?, ?, 1)`).run(
      input.sessionId, input.projectId, Date.now()
    );
    // For MVP, the summary is a truncation of the raw transcript.
    // Full LLM summarization is Path B's responsibility.
    return input.transcript.length > 500
      ? input.transcript.slice(0, 500) + "..."
      : input.transcript;
  }

  // Path B: Async fragmentation after compaction
  async fragmentSession(input: FragmentationInput): Promise<Fragment[]> {
    const db = getDb();
    const result = await this.callFragmenter(input);
    if (result.fragments.length === 0) {
      db.prepare(`UPDATE sessions SET pending_fragmentation = 0 WHERE id = ?`).run(input.sessionId);
      return [];
    }

    return await persistFragments({
      output: result,
      sessionId: input.sessionId,
      projectId: input.projectId,
    });
  }

  // Run decay on all active fragments
  runDecay(): { archived: number; deleted: number } {
    const db = getDb();
    // Raw SQLite rows use snake_case column names — map explicitly
    const rows = db.prepare(`SELECT * FROM fragments WHERE status = 'active'`).all() as Array<Record<string, unknown>>;

    let archived = 0;
    let deleted = 0;

    const update = db.transaction(() => {
      for (const r of rows) {
        const createdAt = r.created_at as number;
        const lastRecalledAt = r.last_recalled_at as number | null;
        const recalledCount = r.recalled_count as number;
        const status = r.status as string;
        const id = r.id as string;

        const decay = computeDecayScore(createdAt, lastRecalledAt, recalledCount);
        if (decay.status === "archived" && status !== "archived") {
          db.prepare(`UPDATE fragments SET status = 'archived', decay_score = 0 WHERE id = ?`).run(id);
          archived++;
        } else if (decay.status === "deleted") {
          deleteFragment(id);
          deleted++;
        }
      }
    });

    update();
    return { archived, deleted };
  }

  // Run distillation: cluster fragments with similar labels, merge ≥3 into L0 rules
  runDistillation(projectId: string): number {
    const db = getDb();
    const fragments = db.prepare(`
      SELECT f.id, f.summary, MIN(fa.label) AS label, MIN(fa.channel) AS channel
      FROM fragments f
      JOIN fragment_anchors fa ON fa.fragment_id = f.id
      WHERE f.project_id = ? AND f.status = 'active'
      GROUP BY f.id, f.summary
    `).all(projectId) as Array<{ id: string; summary: string; label: string; channel: string }>;

    const groups = new Map<string, Array<{ id: string; summary: string; label: string; channel: string }>>();
    for (const f of fragments) {
      const key = `${f.channel}:${(f.label || f.summary).slice(0, 15)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({ id: f.id, summary: f.summary, label: f.label, channel: f.channel });
    }

    let distilled = 0;
    for (const [groupKey, members] of groups) {
      if (members.length >= 3) {
        const exemplar = members[0];
        const labelBase = groupKey.split(":").slice(1).join(":");
        const channel = exemplar?.channel ?? "WHAT";
        const fingerprint = `${projectId}::${channel}::${labelBase.trim().toLowerCase()}`;

        const existingRule = db.prepare(`SELECT id FROM distilled_rules WHERE fingerprint = ?`).get(fingerprint) as { id: string } | undefined;
        if (existingRule) {
          for (const m of members) {
            db.prepare(`INSERT OR IGNORE INTO rule_sources (rule_id, fragment_id, project_id) VALUES (?, ?, ?)`).run(
              existingRule.id, m.id, projectId
            );
          }
          continue;
        }

        const ruleText = members.map((m) => m.summary).join("; ").slice(0, 100);
        const ruleId = `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

        db.prepare(`INSERT OR IGNORE INTO distilled_rules (id, fingerprint, text, weight, created_at) VALUES (?, ?, ?, 1.0, ?)`).run(
          ruleId, fingerprint, ruleText, Date.now()
        );
        for (const m of members) {
          db.prepare(`INSERT OR IGNORE INTO rule_sources (rule_id, fragment_id, project_id) VALUES (?, ?, ?)`).run(
            ruleId, m.id, projectId
          );
        }
        distilled++;
      }
    }
    return distilled;
  }

  // Internal: call LLM fragmenter
  private async callFragmenter(input: FragmentationInput) {
    const key = this.config.fragmentationKey || this.config.apiKey;
    if (!key || key === "test-key" || key.length <= 10) {
      return { fragments: [], summary: "" };
    }
    const baseURL = this.config.fragmentationBaseURL || "https://api.deepseek.com";
    return await fragmentTranscript(input, key, this.config.model ?? "deepseek-chat", baseURL);
  }
}
