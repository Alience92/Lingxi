// UserPromptSubmit hook: reads hook event JSON from stdin, extracts user message, searches L1
// Claude Code passes a JSON object: { session_id, transcript_path, prompt, ... }
// Outputs [AgentMemory] context block for injection into system prompt

import { openDb } from "../db/connection.js";
import { explicitSearch } from "../core/retriever.js";
import { getDb } from "../db/connection.js";

async function main() {
  const projectId = process.env.AGENTMEMORY_PROJECT || "claude-auto-memory";

  // Read hook input from stdin (Claude Code passes JSON event)
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const rawInput = Buffer.concat(chunks).toString("utf-8").trim();
  if (!rawInput) return;

  // Parse hook JSON to extract the actual user prompt
  let userMessage = rawInput;
  try {
    const hookEvent = JSON.parse(rawInput);
    // UserPromptSubmit hook has the prompt in various fields
    userMessage = hookEvent.prompt || hookEvent.text || hookEvent.message ||
                  hookEvent.user_message || hookEvent.content || "";
    if (typeof userMessage !== "string") userMessage = rawInput;
    if (!userMessage.trim()) return;
  } catch {
    // Not JSON, use raw text directly
  }

  openDb();

  // Ensure session record exists
  try {
    const hookEvent = JSON.parse(rawInput);
    const sessionId = hookEvent.session_id || "unknown";
    const db = getDb();
    db.prepare(`INSERT OR REPLACE INTO sessions (id, project_id, started_at, pending_fragmentation) VALUES (?, ?, ?, 0)`).run(
      sessionId, projectId, Date.now()
    );
  } catch { /* best effort */ }

  const results = await explicitSearch(userMessage, projectId, 0.35, 5);

  if (results.length > 0) {
    const lines = results.slice(0, 3).map((r) => {
      const ch = r.fragment.anchors[0]?.channel ?? "?";
      return `[${ch}] ${r.fragment.summary}`;
    });
    console.log(`[AgentMemory] 找到 ${results.length} 条相关记忆:\n${lines.join("\n")}`);
  }
  // Silent on empty = no injection
}

main().catch(() => {
  // Hook failures must never block the Agent
});
