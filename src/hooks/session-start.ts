// SessionStart hook: auto-detect pending transcripts + inject L0 distilled rules
// Outputs [AgentMemory] directives for Claude Code to inject into system prompt

import { openDb, getDb } from "../db/connection.js";
import * as fs from "node:fs";
import * as path from "node:path";

async function main() {
  const projectId = process.env.AGENTMEMORY_PROJECT || "claude-auto-memory";

  // Read hook event JSON from stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const rawInput = Buffer.concat(chunks).toString("utf-8").trim();

  openDb();
  const db = getDb();

  // ── Current session ───────────────────────────────────────────────

  let sessionId = "unknown";
  let workspaceDir = "";
  try {
    const obj = JSON.parse(rawInput);
    sessionId = obj.session_id || obj.sessionId || "unknown";
    workspaceDir = obj.workspace_dir || obj.workspaceDir || "";
  } catch {}

  // Fallback: look up workspace_dir from project record
  if (!workspaceDir) {
    const project = db.prepare("SELECT workspace_dir FROM projects WHERE id = ?").get(projectId) as { workspace_dir: string } | undefined;
    if (project?.workspace_dir) workspaceDir = project.workspace_dir;
  }

  db.prepare(`INSERT OR REPLACE INTO sessions (id, project_id, started_at, pending_fragmentation) VALUES (?, ?, ?, 0)`).run(
    sessionId, projectId, Date.now()
  );

  // ── Scan for unprocessed transcripts ───────────────────────────────

  const transcriptDir = path.join(workspaceDir || path.dirname(workspaceDir || "."), "");
  const unprocessed: string[] = [];

  // Check sessions table for previously flagged pending work
  const pendingSessions = db.prepare(`
    SELECT id FROM sessions
    WHERE project_id = ? AND pending_fragmentation = 1 AND id != ?
    ORDER BY started_at ASC
  `).all(projectId, sessionId) as Array<{ id: string }>;

  if (pendingSessions.length > 0) {
    for (const ps of pendingSessions) {
      // Try to find the transcript file (Claude Code stores them as <sessionId>.jsonl)
      const jsonlPath = path.join(workspaceDir, `${ps.id}.jsonl`);
      if (fs.existsSync(jsonlPath)) {
        const content = fs.readFileSync(jsonlPath, "utf-8");
        if (content.trim().length > 100) {
          unprocessed.push(jsonlPath);
        }
      }
    }
  }

  // If no pending flag, scan for .jsonl files that aren't in the sessions table
  if (unprocessed.length === 0 && workspaceDir && fs.existsSync(workspaceDir)) {
    const entries = fs.readdirSync(workspaceDir);
    const knownIds = new Set(
      (db.prepare("SELECT id FROM sessions WHERE project_id = ?").all(projectId) as Array<{ id: string }>)
        .map((s) => s.id)
    );
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const candidateId = entry.replace(".jsonl", "");
      if (knownIds.has(candidateId)) continue;
      const fullPath = path.join(workspaceDir, entry);
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        if (content.trim().length > 100) {
          unprocessed.push(fullPath);
          // Register this session so we don't re-process it
          db.prepare(`INSERT OR REPLACE INTO sessions (id, project_id, started_at, pending_fragmentation) VALUES (?, ?, ?, 1)`).run(
            candidateId, projectId, Date.now()
          );
        }
      } catch { /* skip unreadable */ }
    }
  }

  // ── Output ────────────────────────────────────────────────────────

  if (unprocessed.length > 0) {
    const fileList = unprocessed.map((f) => path.basename(f)).join(", ");
    console.log(
      `[AgentMemory] ⚡ 发现 ${unprocessed.length} 个未处理的会话转录（${fileList}）。\n` +
      `请调用 memory_bootstrap(workspaceDir="${workspaceDir}", projectId="${projectId}") 重新扫描，` +
      `或对单个转录调用 memory_remember 进行碎片化。`
    );
  }

  // ── Load L0 distilled rules ────────────────────────────────────────

  const rules = db.prepare(`
    SELECT dr.text, dr.weight, COUNT(rs.fragment_id) as source_count
    FROM distilled_rules dr
    JOIN rule_sources rs ON rs.rule_id = dr.id
    WHERE rs.project_id = ? OR rs.project_id IN (
      SELECT DISTINCT project_id FROM rule_sources WHERE rule_id = dr.id
    )
    GROUP BY dr.id
    ORDER BY dr.weight DESC, source_count DESC
    LIMIT 10
  `).all(projectId) as Array<{ text: string; weight: number; source_count: number }>;

  if (rules.length > 0) {
    const ruleLines = rules.map((r) => `- ${r.text} (×${r.source_count})`);
    console.log(`[AgentMemory] L0 蒸馏规则:\n${ruleLines.join("\n")}`);
  }
}

main().catch(() => {});
