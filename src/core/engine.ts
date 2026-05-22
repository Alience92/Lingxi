import type { FragmentationInput, Fragment } from "../types.js";
import { getDb } from "../db/connection.js";
import { fragmentTranscript } from "./fragmenter.js";
import { computeDecayScore } from "./decay.js";

export interface EngineConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
}

export class MemoryEngine {
  constructor(private config: EngineConfig) {}

  // Path A: Compaction-time sync summary
  async compactSession(input: FragmentationInput): Promise<string> {
    const result = await this.callFragmenter(input);
    return result.summary;
  }

  // Path B: Async fragmentation after compaction
  async fragmentSession(input: FragmentationInput): Promise<Fragment[]> {
    const result = await this.callFragmenter(input);

    const db = getDb();
    const fragments: Fragment[] = [];

    const insertFrag = db.prepare(`INSERT INTO fragments (id, session_id, project_id, summary, linked_count, decay_score, created_at, status) VALUES (?, ?, ?, ?, ?, 1.0, ?, 'active')`);
    const insertAnchor = db.prepare(`INSERT INTO fragment_anchors (fragment_id, channel, label, weight, source, timestamp) VALUES (?, ?, ?, ?, ?, ?)`);
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

        const rowidObj = db.prepare("SELECT rowid FROM fragments WHERE id = ?").get(f.id) as { rowid: number } | undefined;
        if (rowidObj) {
          insertFts.run(rowidObj.rowid, f.summary);
        }

        fragments.push(f);
      }
    });

    insertAll();

    db.prepare(`UPDATE sessions SET pending_fragmentation = 0 WHERE id = ?`).run(input.sessionId);

    return fragments;
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
          db.prepare(`DELETE FROM fragments WHERE id = ?`).run(f.id);
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
