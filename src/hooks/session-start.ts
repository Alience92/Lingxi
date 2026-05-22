// SessionStart hook: injects L0 distilled rules into system prompt
// Outputs [AgentMemory] rule block for Claude Code to inject

import { openDb, getDb } from "../db/connection.js";

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

  // Create session record
  let sessionId = "unknown";
  try {
    const obj = JSON.parse(rawInput);
    sessionId = obj.session_id || obj.sessionId || "unknown";
  } catch {}

  db.prepare(`INSERT OR REPLACE INTO sessions (id, project_id, started_at, pending_fragmentation) VALUES (?, ?, ?, 0)`).run(
    sessionId, projectId, Date.now()
  );

  // Check for pending fragmentation from previous session
  const pending = db.prepare(`
    SELECT id FROM sessions WHERE project_id = ? AND pending_fragmentation = 1 AND id != ? LIMIT 1
  `).get(projectId, sessionId) as { id: string } | undefined;

  if (pending) {
    console.log(`[AgentMemory] ⚠️ 上一个 session (${pending.id.slice(0, 8)}) 的碎片化未完成，建议运行 memory_remember 处理未归档的对话。`);
  }

  // Load L0 distilled rules
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
