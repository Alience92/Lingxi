// PostCompact: mark session for fragmentation, store compact_summary + task_brief
import { openDb, getDb } from "../../db/connection.js";

async function main() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const rawInput = Buffer.concat(chunks).toString("utf-8").trim();

  openDb();
  const db = getDb();

  let sessionId = `compact-${Date.now()}`, compactSummary = "", compactedAt = Date.now();
  try {
    const obj = JSON.parse(rawInput);
    sessionId = obj.session_id || obj.sessionId || sessionId;
    compactSummary = obj.compact_summary || obj.compactSummary || obj.summary || "";
    compactedAt = obj.compacted_at || obj.compactedAt || compactedAt;
  } catch {}

  // Extract task-oriented sections from compact summary
  let taskBrief = "";
  const re = /\d+\.\s*(?:Pending Tasks|Current Work|Optional Next Step)[：:]\s*([\s\S]*?)(?=\n\d+\.\s|\n<\/summary>|$)/gi;
  let m: RegExpExecArray | null;
  const parts: string[] = [];
  while ((m = re.exec(compactSummary)) !== null) {
    const content = m[1]?.trim();
    if (content) parts.push(content.replace(/\n/g, " "));
  }
  if (parts.length > 0) taskBrief = parts.join(" | ").slice(0, 800);

  const existing = db.prepare("SELECT started_at FROM sessions WHERE id = ?").get(sessionId) as { started_at: number } | undefined;
  const projectId = process.env.AGENTMEMORY_PROJECT || "claude-auto-memory";

  db.prepare(`
    INSERT INTO sessions (id, project_id, started_at, pending_fragmentation, compact_summary, task_brief, compacted_at)
    VALUES (?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      compact_summary = excluded.compact_summary,
      task_brief = excluded.task_brief,
      compacted_at = excluded.compacted_at,
      pending_fragmentation = excluded.pending_fragmentation
  `).run(sessionId, projectId, existing?.started_at ?? compactedAt, compactSummary, taskBrief, compactedAt);

  console.log(`[AgentMemory] Session ${sessionId.slice(0, 8)} flagged.`);
}

main().catch(() => {});
