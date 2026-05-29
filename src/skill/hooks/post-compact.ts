// PostCompact: mark session for fragmentation + spawn background worker
import { openDb, getDb } from "../../db/connection.js";
import * as path from "node:path";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

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

  // Lazy fragmentation: claim + spawn background worker
  const claimed = db.prepare(
    `UPDATE sessions SET pending_fragmentation = 2, locked_at = ? WHERE id = ? AND pending_fragmentation = 1`
  ).run(Date.now(), sessionId);

  if (claimed.changes > 0) {
    const workerPath = path.join(__dirname, "auto-fragment.js");
    const logDir = path.join(homeDir(), ".claude", "projects", projectId);
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "auto-fragment.log");
    const logFd = fs.openSync(logFile, "a");
    spawn("node", [workerPath, `--project=${projectId}`, `--sessions=${sessionId}`], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    }).unref();
    console.error(`[AgentMemory] 后台碎片化已启动: ${sessionId.slice(0, 8)}`);
  }

  console.log(`[AgentMemory] Session ${sessionId.slice(0, 8)} flagged.`);
}

main().catch((e: unknown) => { console.error("[AgentMemory] hook failed:", (e as Error).message?.slice(0, 120)); });
