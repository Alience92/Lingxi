#!/usr/bin/env node
/**
 * Batch transcript processor: reads unprocessed .jsonl transcripts,
 * extracts conversation content, and calls fragmentSession for each.
 *
 * Usage: node batch-process-transcripts.mjs [projectId] [workspaceDir]
 *
 * Env vars needed:
 *   AGENTMEMORY_API_KEY - MiniMax API key for embeddings
 *   DEEPSEEK_API_KEY - DeepSeek API key for fragmentation
 */

import { openDb, getDb } from "../dist/db/connection.js";
import { MemoryEngine } from "../dist/core/engine.js";
import * as fs from "node:fs";
import * as path from "node:path";

const projectId = process.argv[2] || "C--Users-Administrator";
const workspaceDir = process.argv[3] || `${process.env.HOME || process.env.USERPROFILE}/.claude/projects/${projectId}`;

const MAX_TRANSCRIPT_CHARS = 50000; // Split transcripts larger than this
const MSG_TRUNCATE = 800; // Truncate individual messages to this

openDb();
const db = getDb();

const processedIds = new Set(
  db.prepare("SELECT DISTINCT session_id FROM fragments WHERE project_id = ?").all(projectId).map(s => s.session_id)
);

const entries = fs.readdirSync(workspaceDir).filter(e => e.endsWith(".jsonl")).sort((a, b) => {
  // Sort by file size ascending, process small ones first
  try {
    return fs.statSync(path.join(workspaceDir, a)).size - fs.statSync(path.join(workspaceDir, b)).size;
  } catch { return 0; }
});

// Read env vars from Claude Code settings (not available in bare process.env)
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
const apiKey = settingsEnv.AGENTMEMORY_API_KEY || "";
// fragmentationKey: DEEPSEEK_API_KEY → ANTHROPIC_AUTH_TOKEN → apiKey fallback (matches MCP server logic)
const fragmentationKey = settingsEnv.DEEPSEEK_API_KEY || settingsEnv.ANTHROPIC_AUTH_TOKEN || apiKey;
const fragmentationBaseURL = settingsEnv.DEEPSEEK_BASE_URL || "https://api.deepseek.com";

console.log("API keys: embedding=" + (apiKey ? "yes" : "no") + " fragmentation=" + (fragmentationKey ? "yes" : "no"));

const embeddingBaseURL = settingsEnv.AGENTMEMORY_EMBEDDING_URL || "https://api.minimax.chat";

const engine = new MemoryEngine({
  apiKey,
  fragmentationKey,
  fragmentationBaseURL,
  baseURL: embeddingBaseURL,
});

function extractConversation(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  const conversation = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      let text = "";
      if (obj.message?.content) {
        if (Array.isArray(obj.message.content)) {
          text = obj.message.content.filter(c => c.type === "text").map(c => c.text).join(" ");
        } else {
          text = String(obj.message.content);
        }
      }
      if (text.trim()) {
        const role = obj.type === "user" ? "User" : obj.type === "assistant" ? "Assistant" : obj.type;
        conversation.push(`${role}: ${text.slice(0, MSG_TRUNCATE)}`);
      }
    } catch {}
  }
  return conversation;
}

function chunkConversation(conversation, maxChars) {
  const chunks = [];
  let current = [];
  let currentLen = 0;
  for (const msg of conversation) {
    if (currentLen + msg.length > maxChars && current.length > 0) {
      chunks.push(current.join("\n"));
      current = [];
      currentLen = 0;
    }
    current.push(msg);
    currentLen += msg.length;
  }
  if (current.length > 0) chunks.push(current.join("\n"));
  return chunks;
}

async function processTranscript(sessionId, transcript, chunkIndex, totalChunks) {
  const suffix = totalChunks > 1 ? ` [part ${chunkIndex + 1}/${totalChunks}]` : "";
  console.log(`  Fragmenting session ${sessionId.slice(0, 8)}${suffix} (${transcript.length} chars)...`);

  try {
    const fragments = await engine.fragmentSession({
      sessionId,
      projectId,
      transcript,
    });
    console.log(`    -> ${fragments.length} fragments created`);
    return fragments.length;
  } catch (e) {
    console.error(`    -> ERROR: ${e.message?.slice(0, 120)}`);
    return 0;
  }
}

async function main() {
  let unprocessed = [];
  for (const entry of entries) {
    const candidateId = entry.replace(".jsonl", "");
    if (processedIds.has(candidateId)) continue;
    const fullPath = path.join(workspaceDir, entry);
    const stat = fs.statSync(fullPath);
    if (stat.size < 200) continue;
    unprocessed.push({ id: candidateId, file: entry, path: fullPath, sizeMB: (stat.size / (1024 * 1024)).toFixed(2) });
  }

  console.log(`Found ${unprocessed.length} unprocessed transcripts.\n`);

  if (!engine.canFragment()) {
    console.log("ERROR: No fragmentation API key configured (DEEPSEEK_API_KEY).");
    console.log("Set DEEPSEEK_API_KEY env var and retry.");
    process.exit(1);
  }

  let totalFragments = 0;
  let processed = 0;
  let errors = 0;

  for (const item of unprocessed) {
    const sizeMB = parseFloat(item.sizeMB);
    console.log(`[${++processed}/${unprocessed.length}] ${item.id.slice(0, 8)} (${item.sizeMB}MB)`);

    let conversation;
    try {
      conversation = extractConversation(item.path);
    } catch (e) {
      console.error(`  Failed to read: ${e.message?.slice(0, 80)}`);
      errors++;
      continue;
    }

    if (conversation.length === 0) {
      console.log(`  No conversation content, skipping.`);
      continue;
    }

    const fullTranscript = conversation.join("\n");
    const chunks = chunkConversation(conversation, MAX_TRANSCRIPT_CHARS);

    if (chunks.length > 1) {
      console.log(`  Split into ${chunks.length} chunks (${fullTranscript.length} total chars).`);
    }

    for (let i = 0; i < chunks.length; i++) {
      const fragCount = await processTranscript(item.id, chunks[i], i, chunks.length);
      totalFragments += fragCount;
      if (fragCount === 0 && chunks.length === 1) errors++;

      // Small delay between API calls
      if (chunks.length > 1 && i < chunks.length - 1) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // Mark session as processed
    db.prepare(`UPDATE sessions SET pending_fragmentation = 0 WHERE id = ?`).run(item.id);

    // Delay between transcripts
    if (processed < unprocessed.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`\nDone. ${totalFragments} fragments from ${processed} transcripts. ${errors} errors.`);
  db.close();
}

main().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
