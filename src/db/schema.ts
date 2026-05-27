export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workspace_dir TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_dreaming_at INTEGER,
  install_guide_shown INTEGER DEFAULT 0,
  active_context TEXT
);

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
  distilled_to TEXT,
  subtype TEXT CHECK(subtype IN ('decision','todo','preference',NULL)),
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
  pending_fragmentation INTEGER NOT NULL DEFAULT 0,
  compact_summary TEXT,
  task_brief TEXT,
  locked_at INTEGER,
  fragmented_at INTEGER
);

CREATE TABLE IF NOT EXISTS decision_criteria (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  subject TEXT NOT NULL,
  target TEXT NOT NULL,
  criteria_type TEXT NOT NULL,
  criteria_value TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  source TEXT NOT NULL DEFAULT 'auto',
  session_id TEXT,
  entity_embedding BLOB,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_routes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  intent_pattern TEXT NOT NULL,
  intent_embedding BLOB,
  skill_name TEXT NOT NULL,
  skill_description TEXT NOT NULL,
  success_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0.5,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trust_profile (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  confirm_count INTEGER NOT NULL DEFAULT 0,
  auto_decision_count INTEGER NOT NULL DEFAULT 0,
  correct_count INTEGER NOT NULL DEFAULT 0,
  wrong_count INTEGER NOT NULL DEFAULT 0,
  autonomy_level INTEGER NOT NULL DEFAULT 1,
  last_decision_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fragments_project_status ON fragments(project_id, status);

CREATE VIRTUAL TABLE IF NOT EXISTS fragments_fts USING fts5(
  summary,
  content='fragments',
  content_rowid='rowid'
);

CREATE INDEX IF NOT EXISTS idx_fragment_anchors_fragment ON fragment_anchors(fragment_id);
CREATE INDEX IF NOT EXISTS idx_fragment_links_source ON fragment_links(source_id);
CREATE INDEX IF NOT EXISTS idx_fragment_links_target ON fragment_links(target_id);
CREATE INDEX IF NOT EXISTS idx_decision_criteria_project_subject ON decision_criteria(project_id, subject);

CREATE TABLE IF NOT EXISTS aliases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  canonical TEXT NOT NULL,
  alias TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('manual','auto')),
  confidence REAL NOT NULL DEFAULT 0.7,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_aliases_project ON aliases(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_aliases_canonical_alias ON aliases(project_id, canonical, alias);

-- Phase 2+ tables (v4 migration #14-21)

CREATE TABLE IF NOT EXISTS challenge_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  session_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK(level IN ('L1','L2','L3')),
  action TEXT NOT NULL CHECK(action IN ('advise','revise_required','deliver_blocked')),
  reason_type TEXT NOT NULL CHECK(reason_type IN ('preference_conflict','decision_conflict','constitutional_conflict')),
  evidence_ids TEXT NOT NULL,
  evidence_summary TEXT NOT NULL,
  llm_response_id TEXT,
  confidence REAL NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  user_accepted INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rule_application_logs (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES distilled_rules(id),
  session_id TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  user_accepted INTEGER,
  caused_conflict INTEGER NOT NULL DEFAULT 0,
  context_summary TEXT
);

CREATE TABLE IF NOT EXISTS relationship_profiles (
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  trust_level TEXT NOT NULL DEFAULT 'L1' CHECK(trust_level IN ('L1','L2','L3')),
  friction_score REAL NOT NULL DEFAULT 0.0,
  repair_needed INTEGER NOT NULL DEFAULT 0,
  autonomy_budget REAL NOT NULL DEFAULT 0.0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, project_id)
);

CREATE TABLE IF NOT EXISTS memory_repair_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  job_type TEXT NOT NULL CHECK(job_type IN ('auto_alias','re_embed','re_group','weight_adjust','deprecate_rule')),
  trigger TEXT NOT NULL,
  fragments_affected TEXT NOT NULL,
  action_taken TEXT NOT NULL,
  before_state TEXT,
  after_state TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_message_queue (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  publisher TEXT NOT NULL CHECK(publisher IN ('skill','smallmodel','agent')),
  payload TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feature_flags (
  id TEXT PRIMARY KEY,
  flag_name TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 0,
  rollout_percentage REAL NOT NULL DEFAULT 0.0,
  description TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS interaction_stream (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
  content_preview TEXT NOT NULL,
  topic_id TEXT,
  continuity_window_ms INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_challenge_events_project ON challenge_events(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rule_app_logs_rule ON rule_application_logs(rule_id);
CREATE INDEX IF NOT EXISTS idx_agent_msg_queue_type ON agent_message_queue(event_type, consumed);
CREATE INDEX IF NOT EXISTS idx_interaction_stream_project ON interaction_stream(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_interaction_stream_topic ON interaction_stream(topic_id);

CREATE TABLE IF NOT EXISTS shadow_comparisons (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  fragment_id TEXT NOT NULL,
  summary_preview TEXT NOT NULL,
  slm_channel TEXT NOT NULL,
  llm_channel TEXT NOT NULL,
  slm_model TEXT NOT NULL,
  match_result INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shadow_comparisons_project ON shadow_comparisons(project_id, created_at);
`;

export const VECTOR_DIMENSIONS = 1536;
