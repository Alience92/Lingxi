// SessionStart hook: auto-detect pending transcripts + inject L0 distilled rules
// Outputs [AgentMemory] directives for Claude Code to inject into system prompt

import { openDb, getDb } from "../db/connection.js";
import * as fs from "node:fs";
import * as path from "node:path";

function scanProject(projectId: string, workspaceDir: string): string[] {
  const db = getDb();
  const unprocessed: string[] = [];

  if (!workspaceDir || !fs.existsSync(workspaceDir)) return unprocessed;

  // Check sessions table for previously flagged pending work
  const pendingSessions = db.prepare(`
    SELECT id FROM sessions WHERE project_id = ? AND pending_fragmentation = 1
    ORDER BY started_at ASC
  `).all(projectId) as Array<{ id: string }>;

  for (const ps of pendingSessions) {
    const jsonlPath = path.join(workspaceDir, `${ps.id}.jsonl`);
    if (fs.existsSync(jsonlPath)) {
      const content = fs.readFileSync(jsonlPath, "utf-8");
      if (content.trim().length > 100) unprocessed.push(jsonlPath);
    }
  }

  // Also scan for .jsonl files not yet in the sessions table
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
      const stat = fs.statSync(fullPath);
      if (stat.size < 200) continue; // skip tiny/empty files
      unprocessed.push(fullPath);
      db.prepare(`INSERT OR REPLACE INTO sessions (id, project_id, started_at, pending_fragmentation) VALUES (?, ?, ?, 1)`).run(
        candidateId, projectId, Date.now()
      );
    } catch { /* skip unreadable */ }
  }

  return unprocessed;
}

async function main() {
  const specifiedProject = process.env.AGENTMEMORY_PROJECT || "";
  const defaultProjectId = specifiedProject || "claude-auto-memory";

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
  try {
    const obj = JSON.parse(rawInput);
    sessionId = obj.session_id || obj.sessionId || "unknown";
  } catch {}

  // Determine which projects to scan: specified project, or ALL known projects
  const projectIds: string[] = [];
  if (specifiedProject) {
    projectIds.push(specifiedProject);
  } else {
    const allProjects = db.prepare("SELECT id FROM projects").all() as Array<{ id: string }>;
    projectIds.push(...allProjects.map((p) => p.id));
    if (projectIds.length === 0) projectIds.push(defaultProjectId);
  }

  // ── Scan each project for unprocessed transcripts ──────────────────

  const allUnprocessed: Array<{ projectId: string; files: string[]; workspaceDir: string }> = [];

  for (const pid of projectIds) {
    // Ensure project record exists
    db.prepare(`INSERT OR IGNORE INTO projects (id, name, workspace_dir, created_at) VALUES (?, ?, '', ?)`).run(
      pid, pid, Date.now()
    );

    const project = db.prepare("SELECT workspace_dir FROM projects WHERE id = ?").get(pid) as { workspace_dir: string } | undefined;
    let workspaceDir = project?.workspace_dir || "";

    // If workspace_dir is empty, try to infer from the project ID path convention
    if (!workspaceDir || !fs.existsSync(workspaceDir)) {
      const inferred = path.join(
        process.env.HOME || process.env.USERPROFILE || ".",
        ".claude", "projects", pid
      );
      if (fs.existsSync(inferred)) {
        workspaceDir = inferred;
        db.prepare("UPDATE projects SET workspace_dir = ? WHERE id = ?").run(workspaceDir, pid);
      }
    }

    const unprocessed = scanProject(pid, workspaceDir);
    if (unprocessed.length > 0) {
      allUnprocessed.push({ projectId: pid, files: unprocessed, workspaceDir });
    }
  }

  // Record current session (under the primary project).
  // Use INSERT OR IGNORE to avoid overwriting pending_fragmentation=1
  // that may have been set by compactSession() in a previous run.
  db.prepare(`INSERT OR IGNORE INTO sessions (id, project_id, started_at, pending_fragmentation) VALUES (?, ?, ?, 0)`).run(
    sessionId, projectIds[0] || defaultProjectId, Date.now()
  );
  // If the row already existed, make sure started_at is refreshed
  db.prepare(`UPDATE sessions SET started_at = ? WHERE id = ?`).run(Date.now(), sessionId);

  // ── Output ────────────────────────────────────────────────────────

  for (const up of allUnprocessed) {
    const fileList = up.files.map((f) => path.basename(f)).join(", ");
    console.log(
      `[AgentMemory] ⚡ 项目 ${up.projectId} 发现 ${up.files.length} 个未处理的会话转录（${fileList}）。\n` +
      `请调用 memory_bootstrap(workspaceDir="${up.workspaceDir}", projectId="${up.projectId}") 重新扫描，` +
      `或对单个转录调用 memory_remember 进行碎片化。`
    );
  }

  // ── Load L0 distilled rules from primary project ───────────────────

  const primaryProject = projectIds[0] || defaultProjectId;
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
  `).all(primaryProject) as Array<{ text: string; weight: number; source_count: number }>;

  if (rules.length > 0) {
    const ruleLines = rules.map((r) => `- ${r.text} (×${r.source_count})`);
    console.log(`[AgentMemory] L0 蒸馏规则:\n${ruleLines.join("\n")}`);
  }
}

main().catch(() => {});
