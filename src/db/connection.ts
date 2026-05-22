import Database from "better-sqlite3";
import * as path from "node:path";
import * as fs from "node:fs";
import { SCHEMA_SQL } from "./schema.js";

let db: Database.Database | null = null;

export function getDbPath(workspaceDir?: string): string {
  const base = workspaceDir ?? process.env.AGENTMEMORY_HOME ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".agentmemory");
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
  const distilledRuleColumns = database.prepare(`PRAGMA table_info(distilled_rules)`).all() as Array<{ name: string }>;
  const hasFingerprint = distilledRuleColumns.some((column) => column.name === "fingerprint");
  if (!hasFingerprint) {
    database.exec(`ALTER TABLE distilled_rules ADD COLUMN fingerprint TEXT`);
    database.exec(`UPDATE distilled_rules SET fingerprint = id WHERE fingerprint IS NULL`);
    database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_distilled_rules_fingerprint ON distilled_rules(fingerprint)`);
  }
}

export function closeDb(): void {
  if (db) { db.close(); db = null; }
}

export function getDb(): Database.Database {
  if (!db) throw new Error("Database not opened. Call openDb() first.");
  return db;
}
