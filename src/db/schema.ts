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
  status TEXT NOT NULL DEFAULT 'active',
  vector BLOB
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
  verified INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id, target_id)
);

CREATE TABLE IF NOT EXISTS distilled_rules (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
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

export const VECTOR_DIMENSIONS = 1536;
