#!/usr/bin/env node
/**
 * Retry failed bge-m3 embeddings one fragment at a time.
 * Use after reembed-bge-m3.mjs to fix fragments that failed in batch mode.
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

const fragments = db.prepare(`
  SELECT f.id, f.summary, f.vector, GROUP_CONCAT(fa.label, ' ') as labels
  FROM fragments f
  LEFT JOIN fragment_anchors fa ON fa.fragment_id = f.id
  WHERE f.project_id = ?
  GROUP BY f.id
`).all(projectId);

const needsRetry = fragments.filter(f => !f.vector || f.vector.length !== BGE_BLOB_SIZE);
console.log(`Found ${needsRetry.length} fragments needing retry (out of ${fragments.length} total)\n`);

function sanitizeText(text) {
  return (text || "empty fragment")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "")
    .replace(/�/g, "")
    .slice(0, 512)
    .trim() || "empty fragment";
}

function normalize(vec) {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm === 0 ? vec : vec.map(v => v / norm);
}

function vectorToBlob(vec) {
  return Buffer.from(new Float32Array(normalize(vec)).buffer);
}

async function embedOne(text) {
  const url = `${embeddingURL}/v1/embeddings`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${embeddingKey}` },
    body: JSON.stringify({ model: embeddingModel, input: [text], encoding_format: "float" }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  return data.data[0].embedding;
}

const updateStmt = db.prepare(`UPDATE fragments SET vector = ? WHERE id = ?`);
let success = 0, failed = 0;
const failures = [];

for (let i = 0; i < needsRetry.length; i++) {
  const f = needsRetry[i];
  const text = sanitizeText(`${f.summary} ${f.labels || ""}`);
  let ok = false;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const vec = await embedOne(text);
      const hasNaN = vec.some(v => isNaN(v));
      if (hasNaN) {
        if (attempt < 3) continue;
        throw new Error("NaN in embedding");
      }
      updateStmt.run(vectorToBlob(vec), f.id);
      success++;
      ok = true;
      break;
    } catch (e) {
      if (attempt === 3) {
        failed++;
        failures.push({ id: f.id.slice(0, 12), summary: f.summary?.slice(0, 60), error: e.message?.slice(0, 80) });
      }
    }
  }

  if (i % 10 === 0 || i === needsRetry.length - 1) {
    console.log(`  [${i + 1}/${needsRetry.length}] ${success} ok, ${failed} failed`);
  }
  if (i < needsRetry.length - 1) {
    await new Promise(r => setTimeout(r, 50));
  }
}

console.log(`\nDone. ${success} succeeded, ${failed} still failed.`);
if (failures.length > 0) {
  console.log(`\nFailed fragments:`);
  for (const f of failures) {
    console.log(`  ${f.id}: ${f.summary} — ${f.error}`);
  }
}

db.close();
