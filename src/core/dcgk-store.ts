// 灵络 Store — 图持久化 + 增量更新 + 突触修剪
// SQLite Schema: nodes + edges, UPSERT on significant changes

import { getDb } from "../db/connection.js";

export interface GraphNode {
  id: string;            // unique concept identifier (e.g. "modify_code")
  label: string;         // human-readable label
  activation: number;    // [-1, 1] current activation
  confidence: number;    // [0, 1] certainty about this node
  plasticity: number;    // [0, 1] how easily modified (0=immutable iron rule)
  last_updated: number;  // epoch ms
}

export interface GraphEdge {
  source_id: string;
  target_id: string;
  weight: number;           // [-1, 1] positive=causal, negative=inhibitory
  eligibility_trace: number;// [0, 1] recent activation history
  etype: string;            // "causal" | "inhibits" | "requires"
  tag_plastic: number;      // 0=normal, 1=high plasticity (STC phase)
  last_updated: number;     // epoch ms
}

// ── Schema Migration ──────────────────────────────

const MIGRATION = `
CREATE TABLE IF NOT EXISTS dcgk_nodes (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  activation REAL NOT NULL DEFAULT 0.0,
  confidence REAL NOT NULL DEFAULT 0.5,
  plasticity REAL NOT NULL DEFAULT 0.5,
  last_updated INTEGER NOT NULL DEFAULT 0,
  project_id TEXT NOT NULL DEFAULT 'user_default',
  profile_id TEXT NOT NULL DEFAULT 'user_default',
  observed_at INTEGER
);

CREATE TABLE IF NOT EXISTS dcgk_edges (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 0.0,
  eligibility_trace REAL NOT NULL DEFAULT 0.0,
  etype TEXT NOT NULL DEFAULT 'causal',
  tag_plastic INTEGER NOT NULL DEFAULT 0,
  last_updated INTEGER NOT NULL DEFAULT 0,
  project_id TEXT NOT NULL DEFAULT 'user_default',
  profile_id TEXT NOT NULL DEFAULT 'user_default',
  freshness REAL NOT NULL DEFAULT 1.0,
  valid_from INTEGER,
  valid_until INTEGER,
  PRIMARY KEY (source_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_dcgk_edges_src ON dcgk_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_dcgk_edges_dst ON dcgk_edges(target_id);
CREATE INDEX IF NOT EXISTS idx_dcgk_nodes_project ON dcgk_nodes(project_id, profile_id);
CREATE INDEX IF NOT EXISTS idx_dcgk_edges_project ON dcgk_edges(project_id, profile_id);
CREATE INDEX IF NOT EXISTS idx_dcgk_edges_freshness ON dcgk_edges(freshness);
CREATE INDEX IF NOT EXISTS idx_dcgk_edges_dead ON dcgk_edges(weight, eligibility_trace)
  WHERE ABS(weight) < 0.05 AND eligibility_trace < 0.01;
`;

let migrated = false;

function ensureSchema(): void {
  if (migrated) return;
  const db = getDb();
  db.exec(MIGRATION);
  migrated = true;
}

function getCurrentProjectId(): string {
  return process.env.LINGXI_PROJECT_ID || "user_default";
}

function getCurrentProfileId(): string {
  return process.env.LINGXI_PROFILE_ID || "user_default";
}

// ── Node CRUD ─────────────────────────────────────

export function upsertNode(node: GraphNode & { project_id?: string; profile_id?: string }): void {
  ensureSchema();
  const db = getDb();
  db.prepare(`
    INSERT INTO dcgk_nodes (id, label, activation, confidence, plasticity, last_updated, project_id, profile_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      activation = excluded.activation,
      confidence = excluded.confidence,
      plasticity = excluded.plasticity,
      last_updated = excluded.last_updated
  `).run(node.id, node.label, node.activation, node.confidence, node.plasticity, node.last_updated, node.project_id || "user_default", node.profile_id || "user_default");
}

export function loadNode(id: string): GraphNode | null {
  ensureSchema();
  const db = getDb();
  return db.prepare("SELECT * FROM dcgk_nodes WHERE id = ?").get(id) as GraphNode | null;
}

export function loadAllNodes(projectId: string = "user_default", profileId: string = "user_default"): GraphNode[] {
  ensureSchema();
  const db = getDb();
  return db.prepare("SELECT * FROM dcgk_nodes WHERE project_id = ? AND profile_id = ?").all(projectId, profileId) as GraphNode[];
}

// ── Edge CRUD ─────────────────────────────────────

export function upsertEdge(edge: GraphEdge & { project_id?: string; profile_id?: string }): void {
  ensureSchema();
  const db = getDb();
  db.prepare(`
    INSERT INTO dcgk_edges (source_id, target_id, weight, eligibility_trace, etype, tag_plastic, last_updated, project_id, profile_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id, target_id) DO UPDATE SET
      weight = excluded.weight,
      eligibility_trace = excluded.eligibility_trace,
      etype = excluded.etype,
      tag_plastic = excluded.tag_plastic,
      last_updated = excluded.last_updated
  `).run(edge.source_id, edge.target_id, edge.weight, edge.eligibility_trace, edge.etype, edge.tag_plastic, edge.last_updated, edge.project_id || "user_default", edge.profile_id || "user_default");
}

export function loadEdges(source_id?: string, projectId?: string, profileId?: string): GraphEdge[] {
  ensureSchema();
  const db = getDb();
  const pid = projectId || getCurrentProjectId();
  const pfid = profileId || getCurrentProfileId();
  if (source_id) {
    return db.prepare("SELECT * FROM dcgk_edges WHERE source_id = ? AND project_id = ? AND profile_id = ?").all(source_id, pid, pfid) as GraphEdge[];
  }
  return db.prepare("SELECT * FROM dcgk_edges WHERE project_id = ? AND profile_id = ?").all(pid, pfid) as GraphEdge[];
}

export function loadEdge(source_id: string, target_id: string): GraphEdge | null {
  ensureSchema();
  const db = getDb();
  return db.prepare("SELECT * FROM dcgk_edges WHERE source_id = ? AND target_id = ?").get(source_id, target_id) as GraphEdge | null;
}

// ── Incremental Persistence ───────────────────────

const PERSIST_THRESHOLD = 0.05; // only write if weight changed >5%

export function persistIfChanged(
  edge: GraphEdge,
  oldWeight: number,
  oldEligibility: number,
): void {
  const dw = Math.abs(edge.weight - oldWeight);
  const de = Math.abs(edge.eligibility_trace - oldEligibility);
  if (dw > PERSIST_THRESHOLD || de > 0.1) {
    upsertEdge(edge);
  }
}

// ── Synaptic Pruning (灵络后台) ───────────────────

export function synapticPrune(): { removed_edges: number; hardened_nodes: number } {
  ensureSchema();
  const db = getDb();
  const now = Date.now();
  const DEAD_THRESHOLD = 30 * 24 * 3600 * 1000; // 30 days untouched

  // 1. Remove dead edges: weight near zero, no eligibility, untouched >30 days
  const deadResult = db.prepare(`
    DELETE FROM dcgk_edges
    WHERE ABS(weight) < 0.05
      AND eligibility_trace < 0.01
      AND last_updated < ?
  `).run(now - DEAD_THRESHOLD);

  // 2. Harden iron rules: high-confidence, long-stable edges → reduce plasticity
  const hardened = db.prepare(`
    UPDATE dcgk_nodes
    SET plasticity = MAX(plasticity * 0.5, 0.05),
        last_updated = ?
    WHERE confidence > 0.85
      AND plasticity > 0.1
      AND last_updated < ?
  `).run(now, now - 7 * 24 * 3600 * 1000); // stable for 7+ days

  return {
    removed_edges: deadResult.changes,
    hardened_nodes: hardened.changes,
  };
}

// ── Load Full Graph Into Memory ───────────────────

export function loadFullGraph(projectId?: string, profileId?: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const pid = projectId || getCurrentProjectId();
  const pfid = profileId || getCurrentProfileId();
  return {
    nodes: loadAllNodes(pid, pfid),
    edges: loadEdges(undefined, pid, pfid),
  };
}
