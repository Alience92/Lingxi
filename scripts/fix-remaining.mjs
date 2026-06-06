#!/usr/bin/env node
/**
 * Fix remaining fragments without bge-m3 vectors after batch and retry scripts.
 * Sanitizes text aggressively to handle fragments that caused Ollama NaN errors.
 *
 * Usage: node scripts/fix-remaining.mjs [projectId] [--dry-run]
 */

import { openDb, getDb } from "../dist/db/connection.js";
import * as fs from "node:fs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const projectId = args.find(a => a !== "--dry-run")
  || process.env.AGENTMEMORY_PROJECT
  || null;

if (!projectId) {
  console.error("ERROR: No projectId provided. Set AGENTMEMORY_PROJECT env var or pass as argument.");
  console.error("Usage: node scripts/fix-remaining.mjs <projectId> [--dry-run]");
  process.exit(1);
}

const BGE_BLOB_SIZE = 1024 * 4;
const TARGET_MODEL = "bge-m3";

function loadSettingsEnv() {
  const paths = [
    `${process.env.HOME || process.env.USERPROFILE}/.claude/settings.json`,
    `${process.env.HOME || process.env.USERPROFILE}/.claude/settings.local.json`,
  ];
  const env = { ...process.env };
  for (const p of paths) {
    try { const obj = JSON.parse(fs.readFileSync(p, "utf-8")); if (obj.env) Object.assign(env, obj.env); } catch {}
  }
  return env;
}

const settingsEnv = loadSettingsEnv();
const embeddingURL = (settingsEnv.AGENTMEMORY_EMBEDDING_URL || "http://127.0.0.1:11434").replace("localhost", "127.0.0.1");
const embeddingKey = settingsEnv.AGENTMEMORY_API_KEY || "ollama";
const embeddingModel = settingsEnv.AGENTMEMORY_EMBEDDING_MODEL || TARGET_MODEL;

console.log(`Project: ${projectId}  |  Model: ${embeddingModel}${dryRun ? "  |  DRY RUN" : ""}\n`);

function sanitize(t) {
  return (t || "empty")
    .replace(/https?:\/\/\S+/g, " ")   // strip URLs
    .replace(/[A-Z]:[\\\/]\S+/g, " ")  // strip Windows paths
    .replace(/[^\w\s一-鿿　-〿＀-￯]/g, " ") // keep CJK + basic punctuation
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200) || "empty";
}

function normalize(vec) {
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? vec : vec.map(x => x / norm);
}

openDb();
const db = getDb();

const rows = db.prepare("SELECT id, summary, length(vector) as vlen, vector_model FROM fragments WHERE project_id = ?").all(projectId);
const needsFix = rows.filter(r => !r.vlen || r.vlen !== BGE_BLOB_SIZE || r.vector_model !== TARGET_MODEL);

console.log(`Total: ${rows.length}  |  Already ${TARGET_MODEL}: ${rows.length - needsFix.length}  |  Need fix: ${needsFix.length}\n`);

if (needsFix.length === 0) {
  console.log("Nothing to do.");
  db.close();
  process.exit(0);
}

if (dryRun) {
  console.log(`[DRY RUN] Would fix ${needsFix.length} fragments. No changes made.`);
  db.close();
  process.exit(0);
}

let ok = 0, fail = 0;

for (const f of needsFix) {
  const text = sanitize(f.summary);
  try {
    const r = await fetch(`${embeddingURL}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${embeddingKey}` },
      body: JSON.stringify({ model: embeddingModel, input: [text], encoding_format: "float" }),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    const v = d.data[0].embedding;
    const hasNaN = v.some(x => isNaN(x));
    if (hasNaN) throw new Error("NaN in embedding");
    const nv = normalize(v);
    db.prepare("UPDATE fragments SET vector = ?, vector_model = ? WHERE id = ?").run(Buffer.from(new Float32Array(nv).buffer), TARGET_MODEL, f.id);
    ok++;
  } catch (e) {
    fail++;
    console.log(`  FAILED: ${f.id.slice(0, 8)} — ${e.message?.slice(0, 60)} | ${text.slice(0, 40)}`);
  }
}

const remaining = db.prepare("SELECT COUNT(*) as c FROM fragments WHERE project_id = ? AND (vector IS NULL OR length(vector) != ? OR vector_model IS NULL OR vector_model != ?)").get(projectId, BGE_BLOB_SIZE, TARGET_MODEL);
console.log(`\n${ok} OK, ${fail} failed, ${remaining.c} remaining without ${TARGET_MODEL}`);
db.close();
