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
}

export function closeDb(): void {
  if (db) { db.close(); db = null; }
}

export function getDb(): Database.Database {
  if (!db) throw new Error("Database not opened. Call openDb() first.");
  return db;
}
