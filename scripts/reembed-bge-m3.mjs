#!/usr/bin/env node
/**
 * Re-embed all fragments with bge-m3 (Ollama OpenAI-compatible endpoint).
 * Preserves fragment structure, only updates the vector BLOB column.
 *
 * Usage: node scripts/reembed-bge-m3.mjs [projectId] [--dry-run]
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
  console.error("Usage: node scripts/reembed-bge-m3.mjs <projectId> [--dry-run]");
  process.exit(1);
}

const BATCH_SIZE = 32;
const BGE_BLOB_SIZE = 1024 * 4;
const TARGET_MODEL = "bge-m3";

function loadSettingsEnv() {
  const paths = [
    `${process.env.HOME || process.env.USERPROFILE}/.claude/settings.json`,
    `${process.env.HOME || process.env.USERPROFILE}/.claude/settings.local.json`,
  ];
  const env = { ...process.env };
  for (const p of paths) {
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
const embeddingModel = settingsEnv.AGENTMEMORY_EMBEDDING_MODEL || TARGET_MODEL;

console.log(`Project: ${projectId}  |  Embedding: ${embeddingURL}  |  Model: ${embeddingModel}${dryRun ? "  |  DRY RUN" : ""}\n`);

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

async function embedOne(text) {
  return (await embedBatch([text]))[0];
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

// Load all fragments with anchors
const fragments = db.prepare(`
  SELECT f.id, f.summary, f.vector, f.vector_model
  FROM fragments f
  WHERE f.project_id = ?
  ORDER BY f.created_at
`).all(projectId);

// Load anchors
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

// Skip fragments already embedded with the target model
const toEmbed = enriched.filter(f => {
  if (f.vector_model === TARGET_MODEL && f.vector && f.vector.length === BGE_BLOB_SIZE) return false;
  return true;
});

const skipped = enriched.length - toEmbed.length;
console.log(`Total: ${enriched.length}  |  Already ${TARGET_MODEL}: ${skipped}  |  To re-embed: ${toEmbed.length}\n`);
if (skipped > 0) console.log(`Skipping ${skipped} fragments already marked as ${TARGET_MODEL}.\n`);

if (toEmbed.length === 0) {
  console.log("Nothing to do.");
  db.close();
  process.exit(0);
}

if (dryRun) {
  console.log("[DRY RUN] Would re-embed the above fragments. No changes made.");
  db.close();
  process.exit(0);
}

// ── Re-embed ──────────────────────────────────────────────────────

const updateStmt = db.prepare(`UPDATE fragments SET vector = ?, vector_model = ? WHERE id = ?`);
let processed = 0, errors = 0, updated = 0;
const startTime = Date.now();

// Determine sleep: skip for local Ollama
const isLocal = embeddingURL.includes("127.0.0.1") || embeddingURL.includes("localhost") || embeddingURL.includes("0.0.0.0");

for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
  const batch = toEmbed.slice(i, i + BATCH_SIZE);
  const texts = batch.map(f => fragmentText(f));
  const ids = batch.map(f => f.id);

  try {
    const vectors = await embedBatch(texts);
    const tx = db.transaction(() => {
      for (let j = 0; j < vectors.length; j++) {
        updateStmt.run(vectorToBlob(vectors[j]), TARGET_MODEL, ids[j]);
        updated++;
      }
    });
    tx();
    processed += batch.length;
  } catch (batchErr) {
    // Batch failed — fall back to one-by-one
    console.error(`  Batch failed: ${batchErr.message?.slice(0, 80)} — retrying one-by-one...`);
    for (let j = 0; j < batch.length; j++) {
      let ok = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const vec = await embedOne(texts[j]);
          updateStmt.run(vectorToBlob(vec), TARGET_MODEL, ids[j]);
          updated++;
          ok = true;
          break;
        } catch (e) {
          if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
          else {
            errors++;
            console.error(`    Fragment ${ids[j].slice(0, 8)} failed after 3 attempts: ${e.message?.slice(0, 60)}`);
          }
        }
      }
      processed++;
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const pct = ((processed / toEmbed.length) * 100).toFixed(1);
  console.log(`  [${processed}/${toEmbed.length}] ${pct}% | ${elapsed}s | ${updated} updated | ${errors} errors`);

  if (i + BATCH_SIZE < toEmbed.length && !isLocal) {
    await new Promise(r => setTimeout(r, 200));
  }
}

const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\nDone. ${updated} fragments re-embedded in ${totalTime}s. ${errors} errors.`);
db.close();
