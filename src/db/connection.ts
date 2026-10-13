import Database from "better-sqlite3";
import * as path from "node:path";
import * as fs from "node:fs";
import { SCHEMA_SQL } from "./schema.js";
import { resolveConfig, ensureDbDir } from "../config.js";

let db: Database.Database | null = null;

export function getDbPath(workspaceDir?: string): string {
  const cfg = resolveConfig(workspaceDir ? { dbPath: path.join(workspaceDir, "memory.db") } : {});
  ensureDbDir(cfg.dbPath);
  return cfg.dbPath;
}

export function openDb(dbPath?: string): Database.Database {
  if (db) return db;
  const resolved = dbPath ?? getDbPath();
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
        profile_data TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, project_id)
      )
    `);
  }

  // Migration 16b: profile_data column for storing signals7d + windowStats JSON
  const rpCols = database.prepare(`PRAGMA table_info(relationship_profiles)`).all() as Array<{ name: string }>;
  if (!rpCols.some((col) => col.name === "profile_data")) {
    database.exec(`ALTER TABLE relationship_profiles ADD COLUMN profile_data TEXT`);
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

  // Migration 22: shadow_comparisons table for encoder vs LLM classification benchmarking
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

  // Migration 22b: encoder_label + encoder_confidence columns for separating encoder vs final result
  const shadowCols = database.prepare(`PRAGMA table_info(shadow_comparisons)`).all() as Array<{ name: string }>;
  if (!shadowCols.some((col) => col.name === "encoder_label")) {
    database.exec(`ALTER TABLE shadow_comparisons ADD COLUMN encoder_label TEXT`);
    database.exec(`ALTER TABLE shadow_comparisons ADD COLUMN encoder_confidence REAL`);
    database.exec(`ALTER TABLE shadow_comparisons ADD COLUMN fallback_used INTEGER NOT NULL DEFAULT 0`);
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

  // Migration 24: retrieval_state on fragments (system-managed, flows active→warm→archived→cold)
  const fragCols6 = database.prepare(`PRAGMA table_info(fragments)`).all() as Array<{ name: string }>;
  const hasRetrievalState = fragCols6.some((column) => column.name === "retrieval_state");
  if (!hasRetrievalState) {
    database.exec(`ALTER TABLE fragments ADD COLUMN retrieval_state TEXT NOT NULL DEFAULT 'warm' CHECK(retrieval_state IN ('active','warm','archived','cold'))`);
    database.exec(`UPDATE fragments SET retrieval_state = 'active' WHERE status = 'active' AND retrieval_state = 'warm'`);
    database.exec(`UPDATE fragments SET retrieval_state = 'archived' WHERE status IN ('archived', 'distilled') AND retrieval_state = 'warm'`);
    database.exec(`UPDATE fragments SET retrieval_state = 'cold' WHERE status = 'deleted' AND retrieval_state = 'warm'`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_fragments_project_retrieval ON fragments(project_id, retrieval_state)`);
  }

  // Migration 25: asset_state on fragments (user-managed: retained | exportable | user_deleted)
  const fragCols7 = database.prepare(`PRAGMA table_info(fragments)`).all() as Array<{ name: string }>;
  const hasAssetState = fragCols7.some((column) => column.name === "asset_state");
  if (!hasAssetState) {
    database.exec(`ALTER TABLE fragments ADD COLUMN asset_state TEXT NOT NULL DEFAULT 'retained' CHECK(asset_state IN ('retained','exportable','user_deleted'))`);
    database.exec(`UPDATE fragments SET asset_state = 'user_deleted' WHERE status = 'deleted' AND asset_state = 'retained'`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_fragments_project_asset ON fragments(project_id, asset_state)`);
  }

  // Migration 26: priority column on distilled_rules for constitutional vs behavioral tiering
  const drCols = database.prepare(`PRAGMA table_info(distilled_rules)`).all() as Array<{ name: string }>;
  const hasPriority = drCols.some((col) => col.name === "priority");
  if (!hasPriority) {
    database.exec(`ALTER TABLE distilled_rules ADD COLUMN priority INTEGER NOT NULL DEFAULT 50`);
    // Existing constitutional rules (detected via FEEL anchor w >= 80): mark as priority=0
    database.exec(`
      UPDATE distilled_rules SET priority = 0
      WHERE id IN (
        SELECT DISTINCT dr.id FROM distilled_rules dr
        JOIN rule_sources rs ON rs.rule_id = dr.id
        JOIN fragment_anchors fa ON fa.fragment_id = rs.fragment_id
        WHERE fa.channel = 'FEEL' AND fa.weight >= 80
      )
    `);
  }

  // Migration 27: scope column on fragments for memory applicability boundaries
  const fragCols8 = database.prepare(`PRAGMA table_info(fragments)`).all() as Array<{ name: string }>;
  const hasScope = fragCols8.some((col) => col.name === "scope");
  if (!hasScope) {
    database.exec(`ALTER TABLE fragments ADD COLUMN scope TEXT`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_fragments_project_scope ON fragments(project_id, scope)`);
  }

  // Migration 28: superseded_by on distilled_rules for conflict resolution chain
  const drCols2 = database.prepare(`PRAGMA table_info(distilled_rules)`).all() as Array<{ name: string }>;
  const hasSupersededBy = drCols2.some((col) => col.name === "superseded_by");
  if (!hasSupersededBy) {
    database.exec(`ALTER TABLE distilled_rules ADD COLUMN superseded_by TEXT`);
  }

  // Migration 28b: vector column on distilled_rules for dedup in distillSingleEventRules
  const drCols3 = database.prepare(`PRAGMA table_info(distilled_rules)`).all() as Array<{ name: string }>;
  const hasRuleVector = drCols3.some((col) => col.name === "vector");
  if (!hasRuleVector) {
    database.exec(`ALTER TABLE distilled_rules ADD COLUMN vector BLOB`);
  }

  // Migration 29: memory_repair_jobs CHECK constraint — add P0 active cycle job types.
  // SQLite can't alter CHECK, so rebuild the table.
  const mrjCheck = database.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_repair_jobs'`).get() as { sql: string } | undefined;
  if (mrjCheck?.sql && !mrjCheck.sql.includes("contradiction_detect")) {
    database.exec(`
      CREATE TABLE memory_repair_jobs_new (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        job_type TEXT NOT NULL CHECK(job_type IN ('auto_alias','re_embed','re_group','weight_adjust','deprecate_rule','contradiction_detect','pattern_insight','self_check','proactive_care')),
        trigger TEXT NOT NULL,
        fragments_affected TEXT NOT NULL,
        action_taken TEXT NOT NULL,
        before_state TEXT,
        after_state TEXT,
        created_at INTEGER NOT NULL
      );
      INSERT INTO memory_repair_jobs_new SELECT * FROM memory_repair_jobs;
      DROP TABLE memory_repair_jobs;
      ALTER TABLE memory_repair_jobs_new RENAME TO memory_repair_jobs;
    `);
  }

  // Migration 30: activation_log table for real-time activation tracking
  const hasActivationLog = database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='activation_log'`).get();
  if (!hasActivationLog) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS activation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fragment_id TEXT NOT NULL,
        query_hash TEXT NOT NULL,
        activated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_activation_log_fragment ON activation_log(fragment_id);
      CREATE INDEX IF NOT EXISTS idx_activation_log_time ON activation_log(activated_at);
    `);
  }

  // Migration 31: vector_model column on fragments — track which embedder produced the vector
  const hasVectorModel = database.prepare("SELECT name FROM pragma_table_info('fragments') WHERE name = 'vector_model'").get();
  if (!hasVectorModel) {
    database.exec(`ALTER TABLE fragments ADD COLUMN vector_model TEXT`);
  }

  // Migration 32: keywords + raw_prefix columns — dual-track storage for retrieval quality
  const hasKeywords = database.prepare("SELECT name FROM pragma_table_info('fragments') WHERE name = 'keywords'").get();
  if (!hasKeywords) {
    database.exec(`ALTER TABLE fragments ADD COLUMN keywords TEXT`);
    database.exec(`ALTER TABLE fragments ADD COLUMN raw_prefix TEXT`);
  }

  // Migration 33: is_proactive + is_read columns — proactive care push notification loop
  const hasIsProactive = database.prepare("SELECT name FROM pragma_table_info('fragments') WHERE name = 'is_proactive'").get();
  if (!hasIsProactive) {
    database.exec(`ALTER TABLE fragments ADD COLUMN is_proactive INTEGER NOT NULL DEFAULT 0`);
    database.exec(`ALTER TABLE fragments ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_fragments_proactive_unread ON fragments(is_proactive, is_read, created_at)`);
  }

  // Migration 34: profile_id — dual-profile isolation (user model + star persona)
  const hasProfileId = database.prepare("SELECT name FROM pragma_table_info('fragments') WHERE name = 'profile_id'").get();
  if (!hasProfileId) {
    database.exec(`ALTER TABLE fragments ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'user_default'`);
    const hasDcgkNodes = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dcgk_nodes'").get();
    const hasDcgkEdges = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dcgk_edges'").get();
    if (hasDcgkNodes) {
      database.exec(`ALTER TABLE dcgk_nodes ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'user_default'`);
      database.exec(`CREATE INDEX IF NOT EXISTS idx_dcgk_nodes_profile ON dcgk_nodes(profile_id)`);
    }
    if (hasDcgkEdges) {
      database.exec(`ALTER TABLE dcgk_edges ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'user_default'`);
      database.exec(`CREATE INDEX IF NOT EXISTS idx_dcgk_edges_profile ON dcgk_edges(profile_id)`);
    }
    database.exec(`CREATE INDEX IF NOT EXISTS idx_fragments_profile ON fragments(profile_id)`);
  }

  // Migration 35: 多设备支持 + 调试日志 + 远程配置 (Android App MVP)
  database.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      device_type TEXT NOT NULL DEFAULT 'phone',
      capabilities TEXT DEFAULT '[]',
      last_heartbeat INTEGER,
      device_token TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_devices_heartbeat ON devices(last_heartbeat);

    CREATE TABLE IF NOT EXISTS debug_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      level TEXT NOT NULL,
      category TEXT NOT NULL,
      message TEXT NOT NULL,
      data TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_debug_logs_device ON debug_logs(device_id, timestamp);

    CREATE TABLE IF NOT EXISTS remote_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    INSERT OR IGNORE INTO remote_config (key, value) VALUES
      ('context_interval', '30'),
      ('proactive_interval', '8'),
      ('health_enabled', 'true'),
      ('location_enabled', 'true'),
      ('log_level', 'info'),
      ('debug_mode', 'false');

    CREATE TABLE IF NOT EXISTS proactive_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      messages TEXT NOT NULL,
      is_delivered INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_proactive_actions_device ON proactive_actions(device_id, is_delivered);

    CREATE TABLE IF NOT EXISTS device_contexts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_device_contexts_device ON device_contexts(device_id, created_at);

    CREATE TABLE IF NOT EXISTS device_feedbacks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT,
      content TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
  `);

  const deviceColumns = database.prepare("PRAGMA table_info(devices)").all() as Array<{ name: string }>;
  const hasDeviceToken = deviceColumns.some((column) => column.name === "device_token");
  if (!hasDeviceToken) {
    database.exec("ALTER TABLE devices ADD COLUMN device_token TEXT");
  }

  // Migration 37: Time dimension — edge freshness + validity windows
  const hasFreshness = database.prepare("SELECT name FROM pragma_table_info('dcgk_edges') WHERE name = 'freshness'").get();
  if (!hasFreshness) {
    const hasDcgkNodes = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dcgk_nodes'").get();
    const hasDcgkEdges = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dcgk_edges'").get();
    if (hasDcgkEdges) {
      database.exec(`ALTER TABLE dcgk_edges ADD COLUMN freshness REAL NOT NULL DEFAULT 1.0`);
      database.exec(`ALTER TABLE dcgk_edges ADD COLUMN valid_from INTEGER`);
      database.exec(`ALTER TABLE dcgk_edges ADD COLUMN valid_until INTEGER`);
      database.exec(`CREATE INDEX IF NOT EXISTS idx_dcgk_edges_freshness ON dcgk_edges(freshness)`);
    }
    if (hasDcgkNodes) {
      database.exec(`ALTER TABLE dcgk_nodes ADD COLUMN observed_at INTEGER`);
    }
  }

  // Migration 36: Memory fidelity — variable compression + raw evidence tracing
  const hasCompression = database.prepare("SELECT name FROM pragma_table_info('fragments') WHERE name = 'compression_level'").get();
  if (!hasCompression) {
    database.exec(`ALTER TABLE fragments ADD COLUMN compression_level INTEGER NOT NULL DEFAULT 3`);
    database.exec(`ALTER TABLE fragments ADD COLUMN raw_text TEXT`);
    database.exec(`ALTER TABLE fragments ADD COLUMN original_length INTEGER`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_fragments_compression ON fragments(compression_level)`);
    database.exec(`CREATE TABLE IF NOT EXISTS raw_evidence (
      fragment_id TEXT PRIMARY KEY,
      original_text TEXT NOT NULL,
      original_length INTEGER,
      saved_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      FOREIGN KEY (fragment_id) REFERENCES fragments(id)
    )`);
  }

  // Migration 38: V7 long-term user modeling layer.
  database.exec(`
    CREATE TABLE IF NOT EXISTS user_memory_models (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      profile_id TEXT NOT NULL DEFAULT 'user_default',
      dimension TEXT NOT NULL CHECK(dimension IN ('preference','rule','goal','style','boundary','identity')),
      fingerprint TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','probation','superseded','deleted')),
      priority INTEGER NOT NULL DEFAULT 50,
      superseded_by TEXT,
      confidence REAL NOT NULL DEFAULT 0.5,
      evidence_count INTEGER NOT NULL DEFAULT 0,
      source_session_count INTEGER NOT NULL DEFAULT 0,
      source_fragment_count INTEGER NOT NULL DEFAULT 0,
      evidence_ids TEXT NOT NULL DEFAULT '[]',
      last_conflict_at INTEGER,
      last_reinforced_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const userModelCols = database.prepare("PRAGMA table_info(user_memory_models)").all() as Array<{ name: string }>;
  const hasUserModelCol = (name: string) => userModelCols.some((col) => col.name === name);
  if (!hasUserModelCol("fingerprint")) database.exec(`ALTER TABLE user_memory_models ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''`);
  if (!hasUserModelCol("status")) database.exec(`ALTER TABLE user_memory_models ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','probation','superseded','deleted'))`);
  if (!hasUserModelCol("priority")) database.exec(`ALTER TABLE user_memory_models ADD COLUMN priority INTEGER NOT NULL DEFAULT 50`);
  if (!hasUserModelCol("superseded_by")) database.exec(`ALTER TABLE user_memory_models ADD COLUMN superseded_by TEXT`);
  if (!hasUserModelCol("source_session_count")) database.exec(`ALTER TABLE user_memory_models ADD COLUMN source_session_count INTEGER NOT NULL DEFAULT 0`);
  if (!hasUserModelCol("source_fragment_count")) database.exec(`ALTER TABLE user_memory_models ADD COLUMN source_fragment_count INTEGER NOT NULL DEFAULT 0`);
  if (!hasUserModelCol("last_conflict_at")) database.exec(`ALTER TABLE user_memory_models ADD COLUMN last_conflict_at INTEGER`);
  database.exec(`
    UPDATE user_memory_models SET fingerprint = lower(trim(text)) WHERE fingerprint = '';
    UPDATE user_memory_models SET source_fragment_count = evidence_count WHERE source_fragment_count = 0;
    DROP INDEX IF EXISTS idx_user_memory_models_fingerprint;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_memory_models_fingerprint ON user_memory_models(project_id, profile_id, dimension, fingerprint);
    CREATE INDEX IF NOT EXISTS idx_user_memory_models_scope ON user_memory_models(project_id, profile_id, dimension, status, confidence);
  `);

  // Migration 39: Add project_id to dcgk tables for multi-project isolation
  try {
    const nodeCols = (database.pragma("table_info(dcgk_nodes)") as Array<{ name: string }>).map((c) => c.name);
    if (!nodeCols.includes("project_id")) {
      database.exec("ALTER TABLE dcgk_nodes ADD COLUMN project_id TEXT NOT NULL DEFAULT 'user_default'");
    }
    if (!nodeCols.includes("profile_id")) {
      database.exec("ALTER TABLE dcgk_nodes ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'user_default'");
    }
    const edgeCols = (database.pragma("table_info(dcgk_edges)") as Array<{ name: string }>).map((c) => c.name);
    if (!edgeCols.includes("project_id")) {
      database.exec("ALTER TABLE dcgk_edges ADD COLUMN project_id TEXT NOT NULL DEFAULT 'user_default'");
    }
    if (!edgeCols.includes("profile_id")) {
      database.exec("ALTER TABLE dcgk_edges ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'user_default'");
    }
  } catch { /* table may not exist yet — CREATE TABLE IF NOT EXISTS handles it */ }
}

export function checkpointWAL(): void {
  if (db) { db.pragma("wal_checkpoint(RESTART)"); }
}

export function closeDb(): void {
  if (db) { db.close(); db = null; }
}

export function getDb(): Database.Database {
  if (!db) throw new Error("Database not opened. Call openDb() first.");
  return db;
}
