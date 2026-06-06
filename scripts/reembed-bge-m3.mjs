#!/usr/bin/env node
/**
 * Re-embed all existing fragments with bge-m3 (Ollama).
 * Preserves fragment structure, only updates the vector BLOB column.
 *
 * Usage: node scripts/reembed-bge-m3.mjs [projectId]
 */

import { openDb, getDb } from "../dist/db/connection.js";
import * as fs from "node:fs";

const projectId = process.argv[2] || "C--Users-Administrator";
const BATCH_SIZE = 32;
const BGE_BLOB_SIZE = 1024 * 4;

function loadSettingsEnv() {
  const settingsPaths = [
    `${process.env.HOME || process.env.USERPROFILE}/.claude/settings.json`,
    `${process.env.HOME || process.env.USERPROFILE}/.claude/settings.local.json`,
  ];
  const env = { ...process.env };
  for (const p of settingsPaths) {
    try {
      const content = fs.readFileSync(p, "utf-8");
      const obj = JSON.parse(content);
      if (obj.env) Object.assign(env, obj.env);
    } catch {}
  }
  return env;
}

const settingsEnv = loadSettingsEnv();
const embeddingURL = (settingsEnv.AGENTMEMORY_EMBEDDING_URL || "http://127.0.0.1:11434").replace("localhost", "127.0.0.1");
const embeddingKey = settingsEnv.AGENTMEMORY_API_KEY || "ollama";
const embeddingModel = settingsEnv.AGENTMEMORY_EMBEDDING_MODEL || "bge-m3";

console.log(`Embedding: ${embeddingURL} model=${embeddingModel}`);

function fragmentText(fragment) {
  const labels = fragment.anchors?.map(a => a.label).join(" ") || "";
  return `${fragment.summary} ${labels}`.slice(0, 512);
}

async function embedBatch(texts) {
  const url = `${embeddingURL}/v1/embeddings`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${embeddingKey}` },
    body: JSON.stringify({ model: embeddingModel, input: texts, encoding_format: "float" }),
  });
  if (!response.ok) throw new Error(`API returned ${response.status}`);
  const data = await response.json();
  return data.data.map(d => d.embedding);
}

function normalize(vec) {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm === 0 ? vec : vec.map(v => v / norm);
}

function vectorToBlob(vec) {
  return Buffer.from(new Float32Array(normalize(vec)).buffer);
}

openDb();
const db = getDb();

const fragments = db.prepare(`
  SELECT f.id, f.summary, f.vector
  FROM fragments f
  WHERE f.project_id = ?
  ORDER BY f.created_at
`).all(projectId);

console.log(`Found ${fragments.length} fragments to re-embed.\n`);

// Load anchors for each fragment
const anchorMap = new Map();
const anchors = db.prepare(`
  SELECT fa.fragment_id, fa.label
  FROM fragment_anchors fa
  JOIN fragments f ON f.id = fa.fragment_id
  WHERE f.project_id = ?
  ORDER BY fa.weight DESC
`).all(projectId);
for (const a of anchors) {
  if (!anchorMap.has(a.fragment_id)) anchorMap.set(a.fragment_id, []);
  if (anchorMap.get(a.fragment_id).length < 3) {
    anchorMap.get(a.fragment_id).push(a.label);
  }
}

const enriched = fragments.map(f => ({
  ...f,
  anchors: anchorMap.get(f.id)?.map(l => ({ label: l })) || [],
}));

let hasVector = 0;
for (const f of enriched) {
  if (f.vector && f.vector.length > 10) hasVector++;
}
console.log(`Vector status: ${hasVector} with vector, ${enriched.length - hasVector} without\n`);

let processed = 0, errors = 0, updated = 0;
const startTime = Date.now();
const updateStmt = db.prepare(`UPDATE fragments SET vector = ? WHERE id = ?`);

for (let i = 0; i < enriched.length; i += BATCH_SIZE) {
  const batch = enriched.slice(i, i + BATCH_SIZE);
  const texts = batch.map(f => fragmentText(f));
  const ids = batch.map(f => f.id);

  try {
    const vectors = await embedBatch(texts);
    const tx = db.transaction(() => {
      for (let j = 0; j < vectors.length; j++) {
        updateStmt.run(vectorToBlob(vectors[j]), ids[j]);
        updated++;
      }
    });
    tx();
    processed += batch.length;
  } catch (e) {
    console.error(`  Batch ${Math.floor(i / BATCH_SIZE) + 1} error: ${e.message?.slice(0, 120)}`);
    errors += batch.length;
    processed += batch.length;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const pct = ((processed / enriched.length) * 100).toFixed(1);
  console.log(`  [${processed}/${enriched.length}] ${pct}% | ${elapsed}s | ${updated} updated | ${errors} errors`);

  if (i + BATCH_SIZE < enriched.length) {
    await new Promise(r => setTimeout(r, 200));
  }
}

const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\nDone. ${updated} fragments re-embedded in ${totalTime}s. ${errors} errors.`);
db.close();
