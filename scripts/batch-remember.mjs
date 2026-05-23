#!/usr/bin/env node
/**
 * Batch transcript processor: extracts conversation content from .jsonl files
 * and outputs a list of unprocessed transcripts with their summaries.
 *
 * Usage: node batch-remember.mjs [projectId] [workspaceDir]
 */
import { openDb, getDb } from "../dist/db/connection.js";
import * as fs from "node:fs";
import * as path from "node:path";

const projectId = process.argv[2] || "C--Users-Administrator";
const workspaceDir = process.argv[3] || `${process.env.HOME || process.env.USERPROFILE}/.claude/projects/${projectId}`;

openDb();
const db = getDb();

// A session is "processed" if it has fragments in the fragments table
const processedIds = new Set(
  db.prepare("SELECT DISTINCT session_id FROM fragments WHERE project_id = ?").all(projectId).map(s => s.session_id)
);

const entries = fs.readdirSync(workspaceDir).filter(e => e.endsWith(".jsonl"));
let unprocessed = 0;
const batches = [];
let currentBatch = [];
let currentChars = 0;
const MAX_CHARS_PER_BATCH = 3000;

for (const entry of entries) {
  const candidateId = entry.replace(".jsonl", "");
  if (processedIds.has(candidateId)) continue;

  const fullPath = path.join(workspaceDir, entry);
  try {
    const stat = fs.statSync(fullPath);
    if (stat.size < 500) continue; // skip tiny

    // Skip already-batch-processed sessions (tracked in DB)
    if (processedIds.has(candidateId)) continue;

    const lines = fs.readFileSync(fullPath, "utf-8").split("\n").filter(Boolean);
    const conversation = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === "user" && obj.message?.content) {
          const texts = Array.isArray(obj.message.content)
            ? obj.message.content.filter(c => c.type === "text").map(c => c.text).join(" ")
            : String(obj.message.content);
          if (texts.trim()) conversation.push(`User: ${texts.slice(0, 300)}`);
        } else if (obj.type === "assistant" && obj.message?.content) {
          const texts = Array.isArray(obj.message.content)
            ? obj.message.content.filter(c => c.type === "text").map(c => c.text).join(" ")
            : String(obj.message.content);
          if (texts.trim()) conversation.push(`Assistant: ${texts.slice(0, 300)}`);
        }
      } catch {}
    }

    if (conversation.length === 0) continue;

    const summary = `[${entry.slice(0, 8)}] (${conversation.length} turns)`;
    const content = `Session ${candidateId.slice(0, 8)}:\n${conversation.join("\n")}`;

    if (currentChars + content.length > MAX_CHARS_PER_BATCH) {
      batches.push({ files: currentBatch, text: currentBatch.map(b => b.text).join("\n\n---\n\n") });
      currentBatch = [];
      currentChars = 0;
    }
    currentBatch.push({ id: candidateId, file: entry, text: content, summary });
    currentChars += content.length;
    unprocessed++;
  } catch (e) {
    console.error(`Error reading ${entry}:`, e.message?.slice(0, 80));
  }
}

if (currentBatch.length > 0) {
  batches.push({ files: currentBatch, text: currentBatch.map(b => b.text).join("\n\n---\n\n") });
}

console.log(`Found ${unprocessed} unprocessed transcripts in ${batches.length} batches.`);

// Output first batch summary for review
if (batches.length > 0) {
  console.log(`\n--- Batch 1 (${batches[0].files.length} files) ---`);
  for (const f of batches[0].files) {
    console.log(f.summary);
  }
  console.log(`\nCall memory_remember with transcript = batches[0].text`);
  console.log(`Batch text length: ${batches[0].text.length} chars`);
}
