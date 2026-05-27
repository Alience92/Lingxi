import Database from "better-sqlite3";
import * as path from "node:path";
import * as fs from "node:fs";
import { SCHEMA_SQL } from "./schema.js";

let db: Database.Database | null = null;

export function getDbPath(workspaceDir?: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home && !workspaceDir && !process.env.AGENTMEMORY_HOME) {
    console.error("[AgentMemory] WARNING: No home directory found — using CWD for database. Set AGENTMEMORY_HOME env var.");
  }
  const base = workspaceDir ?? process.env.AGENTMEMORY_HOME ?? path.join(home ?? ".", ".agentmemory");
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
  ensureSchemaMigrations(db);
  return db;
}

function ensureSchemaMigrations(database: Database.Database): void {
  // Migration 1: fingerprint column on distilled_rules
  const distilledRuleColumns = database.prepare(`PRAGMA table_info(distilled_rules)`).all() as Array<{ name: string }>;
  const hasFingerprint = distilledRuleColumns.some((column) => column.name === "fingerprint");
  if (!hasFingerprint) {
    database.exec(`ALTER TABLE distilled_rules ADD COLUMN fingerprint TEXT`);
    database.exec(`UPDATE distilled_rules SET fingerprint = id WHERE fingerprint IS NULL`);
    database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_distilled_rules_fingerprint ON distilled_rules(fingerprint)`);
  }

  // Migration 2: vector column for embedding persistence
  const fragmentColumns = database.prepare(`PRAGMA table_info(fragments)`).all() as Array<{ name: string }>;
  const hasVector = fragmentColumns.some((column) => column.name === "vector");
  if (!hasVector) {
    database.exec(`ALTER TABLE fragments ADD COLUMN vector BLOB`);
  }

  // Migration 3: last_dreaming_at on projects for auto-dreaming threshold tracking
  const projectColumns = database.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>;
  const hasDreamingAt = projectColumns.some((column) => column.name === "last_dreaming_at");
  if (!hasDreamingAt) {
    database.exec(`ALTER TABLE projects ADD COLUMN last_dreaming_at INTEGER`);
  }

  // Migration 4: decision_criteria table for structured decision memory
  const hasDecisionCriteria = database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='decision_criteria'`).get();
  if (!hasDecisionCriteria) {
    database.exec(`
      CREATE TABLE decision_criteria (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        subject TEXT NOT NULL,
        target TEXT NOT NULL,
        criteria_type TEXT NOT NULL,
        criteria_value TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        source TEXT NOT NULL DEFAULT 'auto',
        session_id TEXT,
        created_at INTEGER NOT NULL
      )
    `);
  }

  // Migration 5: compact_summary on sessions
  const sessColumns = database.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
  const hasCompactSummary = sessColumns.some((column) => column.name === "compact_summary");
  if (!hasCompactSummary) {
    database.exec(`ALTER TABLE sessions ADD COLUMN compact_summary TEXT`);
  }

  // Migration 6: install_guide_shown on projects
  const projCols2 = database.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>;
  const hasGuideShown = projCols2.some((column) => column.name === "install_guide_shown");
  if (!hasGuideShown) {
    database.exec(`ALTER TABLE projects ADD COLUMN install_guide_shown INTEGER DEFAULT 0`);
  }

  // Migration 6: entity_embedding column on decision_criteria
  const dcColumns = database.prepare(`PRAGMA table_info(decision_criteria)`).all() as Array<{ name: string }>;
  const hasEntityEmb = dcColumns.some((column) => column.name === "entity_embedding");
  if (!hasEntityEmb) {
    database.exec(`ALTER TABLE decision_criteria ADD COLUMN entity_embedding BLOB`);
  }

  // Migration 7: distilled_to column on fragments
  const fragCols3 = database.prepare(`PRAGMA table_info(fragments)`).all() as Array<{ name: string }>;
  const hasDistilledTo = fragCols3.some((column) => column.name === "distilled_to");
  if (!hasDistilledTo) {
    database.exec(`ALTER TABLE fragments ADD COLUMN distilled_to TEXT`);
  }

  // Migration 8: locked_at column on sessions for worker timeout recovery
  const sessCols2 = database.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
  const hasLockedAt = sessCols2.some((column) => column.name === "locked_at");
  if (!hasLockedAt) {
    database.exec(`ALTER TABLE sessions ADD COLUMN locked_at INTEGER`);
  }

  // Migration 6: skill_routes table for intent→skill mapping
  const hasSkillRoutes = database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='skill_routes'`).get();
  if (!hasSkillRoutes) {
    database.exec(`
      CREATE TABLE skill_routes (
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
      )
    `);
  }

  // Migration 6: trust_profile table for autonomy state tracking
  const hasTrustProfile = database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='trust_profile'`).get();
  if (!hasTrustProfile) {
    database.exec(`
      CREATE TABLE trust_profile (
        project_id TEXT PRIMARY KEY REFERENCES projects(id),
        confirm_count INTEGER NOT NULL DEFAULT 0,
        auto_decision_count INTEGER NOT NULL DEFAULT 0,
        correct_count INTEGER NOT NULL DEFAULT 0,
        wrong_count INTEGER NOT NULL DEFAULT 0,
        autonomy_level INTEGER NOT NULL DEFAULT 1,
        last_decision_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  // Migration 9: fragmented_at column for duplicate fragmentation prevention
  const sessCols3 = database.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
  const hasFragmentedAt = sessCols3.some((column) => column.name === "fragmented_at");
  if (!hasFragmentedAt) {
    database.exec(`ALTER TABLE sessions ADD COLUMN fragmented_at INTEGER`);
  }

  // Migration 10: task_brief column for task-oriented cross-session continuity
  const sessCols4 = database.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
  const hasTaskBrief = sessCols4.some((column) => column.name === "task_brief");
  if (!hasTaskBrief) {
    database.exec(`ALTER TABLE sessions ADD COLUMN task_brief TEXT`);
  }

  // Migration 11: subtype column on fragments for active_context tagging (decision/todo/preference)
  const fragCols5 = database.prepare(`PRAGMA table_info(fragments)`).all() as Array<{ name: string }>;
  const hasSubtype = fragCols5.some((column) => column.name === "subtype");
  if (!hasSubtype) {
    database.exec(`ALTER TABLE fragments ADD COLUMN subtype TEXT CHECK(subtype IN ('decision','todo','preference',NULL))`);
  }

  // Migration 12: active_context column on projects for persistent working memory
  const projCols4 = database.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>;
  const hasActiveContext = projCols4.some((column) => column.name === "active_context");
  if (!hasActiveContext) {
    database.exec(`ALTER TABLE projects ADD COLUMN active_context TEXT`);
  }

  // Migration 13: aliases table for terminology grounding / symbol mapping
  const hasAliases = database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='aliases'`).get();
  if (!hasAliases) {
    database.exec(`
      CREATE TABLE aliases (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        canonical TEXT NOT NULL,
        alias TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('manual','auto')),
        confidence REAL NOT NULL DEFAULT 0.7,
        created_at INTEGER NOT NULL
      )
    `);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_aliases_project ON aliases(project_id)`);
    database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_aliases_canonical_alias ON aliases(project_id, canonical, alias)`);
  }

  // Migration 14: challenge_events table
  const hasChallengeEvents = database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='challenge_events'`).get();
  if (!hasChallengeEvents) {
    database.exec(`
      CREATE TABLE challenge_events (
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
      )
    `);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_challenge_events_project ON challenge_events(project_id, created_at)`);
  }

  // Migration 15: rule_application_logs table
  const hasRuleAppLogs = database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='rule_application_logs'`).get();
  if (!hasRuleAppLogs) {
    database.exec(`
      CREATE TABLE rule_application_logs (
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL REFERENCES distilled_rules(id),
        session_id TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        user_accepted INTEGER,
        caused_conflict INTEGER NOT NULL DEFAULT 0,
        context_summary TEXT
      )
    `);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_rule_app_logs_rule ON rule_application_logs(rule_id)`);
  }

  // Migration 16: relationship_profiles table
  const hasRelationshipProfiles = database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='relationship_profiles'`).get();
  if (!hasRelationshipProfiles) {
    database.exec(`
      CREATE TABLE relationship_profiles (
        user_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id),
        trust_level TEXT NOT NULL DEFAULT 'L1' CHECK(trust_level IN ('L1','L2','L3')),
        friction_score REAL NOT NULL DEFAULT 0.0,
        repair_needed INTEGER NOT NULL DEFAULT 0,
        autonomy_budget REAL NOT NULL DEFAULT 0.0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, project_id)
      )
    `);
  }

  // Migration 17: memory_repair_jobs table
  const hasMemoryRepairJobs = database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memory_repair_jobs'`).get();
  if (!hasMemoryRepairJobs) {
    database.exec(`
      CREATE TABLE memory_repair_jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        job_type TEXT NOT NULL CHECK(job_type IN ('auto_alias','re_embed','re_group','weight_adjust','deprecate_rule')),
        trigger TEXT NOT NULL,
        fragments_affected TEXT NOT NULL,
        action_taken TEXT NOT NULL,
        before_state TEXT,
        after_state TEXT,
        created_at INTEGER NOT NULL
      )
    `);
  }

  // Migration 18: agent_message_queue table
  const hasAgentMsgQueue = database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='agent_message_queue'`).get();
  if (!hasAgentMsgQueue) {
    database.exec(`
      CREATE TABLE agent_message_queue (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        publisher TEXT NOT NULL CHECK(publisher IN ('skill','smallmodel','agent')),
        payload TEXT NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0,
        consumed_at INTEGER,
        created_at INTEGER NOT NULL
      )
    `);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_agent_msg_queue_type ON agent_message_queue(event_type, consumed)`);
  }

  // Migration 19: data_state column on sessions
  const sessCols5 = database.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
  const hasDataState = sessCols5.some((column) => column.name === "data_state");
  if (!hasDataState) {
    database.exec(`ALTER TABLE sessions ADD COLUMN data_state TEXT CHECK(data_state IN ('raw_saved','fragmenting','fragmented','indexed','agent_observed','announced',NULL))`);
  }

  // Migration 20: feature_flags table
  const hasFeatureFlags = database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='feature_flags'`).get();
  if (!hasFeatureFlags) {
    database.exec(`
      CREATE TABLE feature_flags (
        id TEXT PRIMARY KEY,
        flag_name TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 0,
        rollout_percentage REAL NOT NULL DEFAULT 0.0,
        description TEXT,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  // Migration 21: interaction_stream table
  const hasInteractionStream = database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='interaction_stream'`).get();
  if (!hasInteractionStream) {
    database.exec(`
      CREATE TABLE interaction_stream (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT,
        role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
        content_preview TEXT NOT NULL,
        topic_id TEXT,
        continuity_window_ms INTEGER,
        created_at INTEGER NOT NULL
      )
    `);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_interaction_stream_project ON interaction_stream(project_id, created_at)`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_interaction_stream_topic ON interaction_stream(topic_id)`);
  }

  // Migration 22: shadow_comparisons table for SLM vs LLM classification benchmarking
  const hasShadowComparisons = database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='shadow_comparisons'`).get();
  if (!hasShadowComparisons) {
    database.exec(`
      CREATE TABLE shadow_comparisons (
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
      )
    `);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_shadow_comparisons_project ON shadow_comparisons(project_id, created_at)`);
  }

  // Migration 23: query_events table for accurate zero-hit rate tracking
  const hasQueryEvents = database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='query_events'`).get();
  if (!hasQueryEvents) {
    database.exec(`
      CREATE TABLE query_events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        query TEXT NOT NULL,
        result_count INTEGER NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('prefetch','explicit')),
        searched_at INTEGER NOT NULL
      )
    `);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_query_events_project ON query_events(project_id, searched_at)`);
  }
}

export function closeDb(): void {
  if (db) { db.close(); db = null; }
}

export function getDb(): Database.Database {
  if (!db) throw new Error("Database not opened. Call openDb() first.");
  return db;
}
