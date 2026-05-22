import type { FragmentationInput, Fragment } from "../types.js";
import { getDb } from "../db/connection.js";
import { persistFragments, deleteFragment } from "../db/repository.js";
import { fragmentTranscript } from "./fragmenter.js";
import { computeDecayScore } from "./decay.js";

export interface EngineConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
}

export class MemoryEngine {
  constructor(private config: EngineConfig) {}

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

    return persistFragments({
      output: result,
      sessionId: input.sessionId,
      projectId: input.projectId,
    });
  }

  // Run decay on all active fragments
  runDecay(): { archived: number; deleted: number } {
    const db = getDb();
    const fragments = db.prepare(`SELECT * FROM fragments WHERE status = 'active'`).all() as Fragment[];

    let archived = 0;
    let deleted = 0;

    const update = db.transaction(() => {
      for (const f of fragments) {
        const decay = computeDecayScore(f.createdAt, f.lastRecalledAt, f.recalledCount);
        if (decay.status === "archived" && f.status !== "archived") {
          db.prepare(`UPDATE fragments SET status = 'archived', decay_score = 0 WHERE id = ?`).run(f.id);
          archived++;
        } else if (decay.status === "deleted") {
          deleteFragment(f.id);
          deleted++;
        }
      }
    });

    update();
    return { archived, deleted };
  }

  // Internal: call LLM fragmenter
  private async callFragmenter(input: FragmentationInput) {
    if (!this.config.apiKey || this.config.apiKey === "test-key") {
      return { fragments: [], summary: "" };
    }
    return await fragmentTranscript(input, this.config.apiKey, this.config.model ?? "deepseek-chat", this.config.baseURL);
  }
}
