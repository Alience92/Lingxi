// Unified persistence layer — single source of truth for all fragment writes
// Ensures FTS, anchors, links, sessions, and projects are always written atomically

import type { Fragment, FragmentationOutput } from "../types.js";
import { getDb } from "./connection.js";

export interface PersistInput {
  output: FragmentationOutput;
  sessionId: string;
  projectId: string;
  workspaceDir?: string;
}

export function persistFragments(input: PersistInput): Fragment[] {
  const db = getDb();
  const { output, sessionId, projectId, workspaceDir } = input;
  const fragments: Fragment[] = [];

  // Ensure project record
  db.prepare(`INSERT OR IGNORE INTO projects (id, name, workspace_dir, created_at) VALUES (?, ?, ?, ?)`).run(
    projectId, projectId, workspaceDir ?? "", Date.now()
  );

  // Ensure session record
  db.prepare(`INSERT OR REPLACE INTO sessions (id, project_id, started_at, pending_fragmentation) VALUES (?, ?, ?, 0)`).run(
    sessionId, projectId, Date.now()
  );

  const insertFrag = db.prepare(`
    INSERT INTO fragments (id, session_id, project_id, summary, linked_count, decay_score, created_at, status)
    VALUES (?, ?, ?, ?, ?, 1.0, ?, 'active')
  `);
  const insertAnchor = db.prepare(`
    INSERT INTO fragment_anchors (fragment_id, channel, label, weight, source, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertLink = db.prepare(`
    INSERT OR IGNORE INTO fragment_links (source_id, target_id) VALUES (?, ?)
  `);

  const persist = db.transaction(() => {
    // Phase 1: insert all fragments, anchors, and FTS entries first
    // (fragment_links FK requires targets to exist, so defer links to phase 2)
    for (const raw of output.fragments) {
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

      // FTS: insert using the actual SQLite rowid (not the TEXT UUID)
      const row = db.prepare("SELECT rowid FROM fragments WHERE id = ?").get(f.id) as { rowid: number } | undefined;
      if (row) {
        db.prepare("INSERT INTO fragments_fts (rowid, summary) VALUES (?, ?)").run(row.rowid, f.summary);
      }

      fragments.push(f);
    }

    // Phase 2: insert all links now that every fragment exists
    for (const f of fragments) {
      for (const targetId of f.linkedIds) {
        insertLink.run(f.id, targetId);
      }
    }
  });

  persist();
  return fragments;
}

// Delete fragment and clean up FTS
export function deleteFragment(fragmentId: string): void {
  const db = getDb();
  const row = db.prepare("SELECT rowid FROM fragments WHERE id = ?").get(fragmentId) as { rowid: number } | undefined;

  const cleanup = db.transaction(() => {
    // Explicitly delete child records before the parent, avoiding reliance on CASCADE
    db.prepare("DELETE FROM recall_log WHERE fragment_id = ?").run(fragmentId);
    db.prepare("DELETE FROM fragment_links WHERE source_id = ? OR target_id = ?").run(fragmentId, fragmentId);
    db.prepare("DELETE FROM fragment_anchors WHERE fragment_id = ?").run(fragmentId);

    if (row) {
      db.prepare("INSERT INTO fragments_fts (fragments_fts, rowid, summary) VALUES ('delete', ?, ?)").run(row.rowid, "");
    }
    db.prepare("DELETE FROM fragments WHERE id = ?").run(fragmentId);
  });

  cleanup();
}

// Fix backup-recall archive query: use correct rowid mapping
export function searchArchiveFragments(
  query: string,
  projectId: string,
  limit: number = 5
): Array<{ id: string; summary: string }> {
  const db = getDb();
  const ftsQuery = query.replace(/[^\w一-鿿]+/g, " ").trim().split(/\s+/).filter(Boolean).join(" AND ");
  if (!ftsQuery) return [];

  try {
    // Correct: search FTS → get rowid → join back to fragments by rowid
    return db.prepare(`
      SELECT f.id, f.summary FROM fragments_fts ft
      JOIN fragments f ON f.rowid = ft.rowid
      WHERE fragments_fts MATCH ? AND f.project_id = ? AND f.status = 'archived'
      LIMIT ?
    `).all(ftsQuery, projectId, limit) as Array<{ id: string; summary: string }>;
  } catch {
    return [];
  }
}
