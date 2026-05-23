// PostCompact hook: marks the compacted session for later fragmentation.
// SessionStart will detect pending_fragmentation=1 and output a reminder.
// Full auto-fragmentation requires the compacted transcript which may not
// be available via stdin — the hook event JSON may not include full content.

import { openDb, getDb } from "../db/connection.js";

async function main() {
  const projectId = process.env.AGENTMEMORY_PROJECT || "claude-auto-memory";

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const rawInput = Buffer.concat(chunks).toString("utf-8").trim();

  openDb();
  const db = getDb();

  let sessionId = `compact-${Date.now()}`;
  try {
    const obj = JSON.parse(rawInput);
    sessionId = obj.session_id || obj.sessionId || sessionId;
  } catch {}

  // Mark session for fragmentation
  db.prepare(`INSERT OR REPLACE INTO sessions (id, project_id, started_at, pending_fragmentation) VALUES (?, ?, ?, 1)`).run(
    sessionId, projectId, Date.now()
  );

  console.log(`[AgentMemory] Session ${sessionId.slice(0, 8)} flagged for fragmentation.`);
}

main().catch(() => {});
