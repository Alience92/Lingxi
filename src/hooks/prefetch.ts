// UserPromptSubmit hook: reads hook event JSON from stdin, extracts user message, searches L1

import { openDb, getDb } from "../db/connection.js";
import { prefetch } from "../core/retriever.js";

async function main() {
  const projectId = process.env.AGENTMEMORY_PROJECT || "claude-auto-memory";

  // Read hook input from stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const rawInput = Buffer.concat(chunks).toString("utf-8").trim();
  if (!rawInput) return;

  // Extract the actual user message from whatever format Claude Code sends
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

  // Use unified P2 prefetch (anchor-weighted + clustered + MMR)
  const pre = await prefetch([{ role: "user", text: userMessage }], projectId);

  if (pre.confidence > 0 && pre.contextBlock) {
    console.log(`[AgentMemory] 相关记忆:\n${pre.contextBlock}`);
  }
}

main().catch(() => {});
