// UserPromptSubmit hook: reads hook event JSON from stdin, extracts user message, searches L1

import { openDb } from "../db/connection.js";
import { explicitSearch } from "../core/retriever.js";
import { getDb } from "../db/connection.js";
import * as fs from "node:fs";

async function main() {
  const projectId = process.env.AGENTMEMORY_PROJECT || "claude-auto-memory";

  // Read hook input from stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const rawInput = Buffer.concat(chunks).toString("utf-8").trim();
  if (!rawInput) return;

  // DEBUG: save hook input to file so we can inspect the actual format
  try {
    const home = process.env.HOME || process.env.USERPROFILE || ".";
    const debugDir = home + "/.agentmemory";
    fs.mkdirSync(debugDir, { recursive: true });
    fs.appendFileSync(debugDir + "/hook-debug.log", JSON.stringify({ time: new Date().toISOString(), input: rawInput }) + "\n");
  } catch {}

  // Try to extract the actual user message from whatever format Claude Code sends
  let userMessage = rawInput;
  try {
    const obj = JSON.parse(rawInput);
    // Claude Code UserPromptSubmit passes the prompt text. Try common field names.
    const candidates = ["prompt", "text", "message", "user_message", "content", "prompt_text", "input", "query"];
    let found = false;
    for (const key of candidates) {
      const val = (obj as any)[key];
      if (typeof val === "string" && val.trim().length > 0 && !val.startsWith("{")) {
        userMessage = val;
        found = true;
        break;
      }
    }
    if (!found) {
      // Try to guess: use the longest string field in the object
      let longest = "";
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string" && v.length > longest.length && !v.startsWith("{")) {
          longest = v;
        }
      }
      if (longest) userMessage = longest;
    }
  } catch {}

  if (!userMessage || userMessage === rawInput) return;

  openDb();

  // Ensure session record
  try {
    const obj = JSON.parse(rawInput);
    const sessionId = obj.session_id || obj.sessionId || "unknown";
    getDb().prepare(`INSERT OR REPLACE INTO sessions (id, project_id, started_at, pending_fragmentation) VALUES (?, ?, ?, 0)`).run(
      sessionId, projectId, Date.now()
    );
  } catch {}

  const results = await explicitSearch(userMessage, projectId, 0.35, 5);

  if (results.length > 0) {
    const lines = results.slice(0, 3).map((r) => {
      const ch = r.fragment.anchors[0]?.channel ?? "?";
      return `[${ch}] ${r.fragment.summary}`;
    });
    console.log(`[AgentMemory] ${results.length} 条相关记忆:\n${lines.join("\n")}`);
  }
}

main().catch(() => {});
