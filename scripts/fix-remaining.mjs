#!/usr/bin/env node
/**
 * Fix remaining fragments without bge-m3 vectors after batch and retry scripts.
 * Sanitizes text aggressively to handle fragments that caused Ollama NaN errors.
 */

import { openDb, getDb } from "../dist/db/connection.js";
import * as fs from "node:fs";

const projectId = process.argv[2] || "C--Users-Administrator";
const BGE_BLOB_SIZE = 1024 * 4;

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
const embeddingModel = settingsEnv.AGENTMEMORY_EMBEDDING_MODEL || "bge-m3";

openDb();
const db = getDb();

const rows = db.prepare("SELECT id, summary, length(vector) as vlen FROM fragments WHERE project_id = ?").all(projectId);
const needsFix = rows.filter(r => !r.vlen || r.vlen !== BGE_BLOB_SIZE);
console.log(`Fragments without bge-m3 vector: ${needsFix.length}`);

function sanitize(t) {
  return (t || "empty")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[A-Z]:[\\\/]\S+/g, " ")
    .replace(/[^一-鿿\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200) || "empty";
}

function normalize(vec) {
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? vec : vec.map(x => x / norm);
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
    const nv = normalize(v);
    db.prepare("UPDATE fragments SET vector = ? WHERE id = ?").run(Buffer.from(new Float32Array(nv).buffer), f.id);
    ok++;
  } catch (e) {
    fail++;
    console.log(`  FAILED: ${f.id.slice(0, 8)} — ${e.message?.slice(0, 60)} | ${text.slice(0, 40)}`);
  }
}

const remaining = db.prepare("SELECT COUNT(*) as c FROM fragments WHERE project_id = ? AND (vector IS NULL OR length(vector) != ?)").get(projectId, BGE_BLOB_SIZE);
console.log(`${ok} OK, ${fail} failed, ${remaining.c} remaining`);
db.close();
