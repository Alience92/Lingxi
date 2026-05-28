// UserPromptSubmit hook: reads hook event JSON from stdin, extracts user message,
// runs prefetch across ALL known projects, outputs relevant memories to stdout

import { openDb, getDb } from "../../db/connection.js";
import { prefetch, getLastPrefetchTiming } from "../../core/retriever.js";

const HOOK_TIMING = process.env.AGENTMEMORY_PERF_TIMING === "1";

async function main() {
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
  const db = getDb();

  // Record session under every known project
  let sessionId = "unknown";
  try {
    const obj = JSON.parse(rawInput);
    sessionId = obj.session_id || obj.sessionId || "unknown";
  } catch {}

  const projectIds = (db.prepare("SELECT id FROM projects").all() as Array<{ id: string }>).map((p) => p.id);
  if (projectIds.length === 0) {
    projectIds.push(process.env.AGENTMEMORY_PROJECT || "claude-auto-memory");
  }

  for (const pid of projectIds) {
    db.prepare(`INSERT OR IGNORE INTO sessions (id, project_id, started_at, pending_fragmentation) VALUES (?, ?, ?, 0)`).run(
      sessionId, pid, Date.now()
    );
  }

  // Run prefetch across all projects, collect the best results
  let bestBlock = "";
  let bestConfidence = 0;

  const tHookStart = Date.now();

  for (const pid of projectIds) {
    try {
      const pre = await prefetch([{ role: "user", text: userMessage }], pid);
      if (pre.confidence > bestConfidence && pre.contextBlock) {
        bestConfidence = pre.confidence;
        bestBlock = pre.contextBlock;
      }
    } catch (e) {
      console.error(`[AgentMemory] prefetch error for project ${pid}:`, (e as Error).message?.slice(0, 120) || e);
    }
  }

  const tHookTotal = Date.now() - tHookStart;

  if (HOOK_TIMING) {
    const t = getLastPrefetchTiming();
    if (t) {
      console.error(`[AgentMemory] timing: hook=${tHookTotal}ms prefetch(embed=${t.embedMs}ms search=${t.vectorSearchMs}ms mmr=${t.mmrMs}ms total=${t.totalMs}ms) cache(hits=${t.cacheHits} misses=${t.cacheMisses}) candidates=${t.candidatesFound}→${t.selectedCount}`);
    } else {
      console.error(`[AgentMemory] timing: hook=${tHookTotal}ms (no detail)`);
    }
  }

  if (bestConfidence > 0 && bestBlock) {
    console.log(`[AgentMemory] 相关记忆:\n${bestBlock}`);
  } else {
    console.log(`[AgentMemory] 未找到相关记忆（查询了 ${projectIds.length} 个项目）`);
  }
}

main().catch((e: unknown) => { console.error("[AgentMemory] hook failed:", (e as Error).message?.slice(0, 120)); });
