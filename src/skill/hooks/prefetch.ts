// UserPromptSubmit hook: reads hook event JSON from stdin, extracts user message,
// runs prefetch across ALL known projects, outputs relevant memories to stdout

import { openDb, getDb } from "../../db/connection.js";
import { prefetch, getLastPrefetchTiming } from "../../core/retriever.js";
import { extractSignals, persistLightweightSignals } from "../../core/lightweight-extractor.js";

const HOOK_TIMING = process.env.AGENTMEMORY_PERF_TIMING === "1";

/** Search distilled L0 rules for keywords matching the user query. */
function searchDistilledRules(db: ReturnType<typeof getDb>, query: string, projectId: string): string[] {
  const tokens = query.split(/[\s,，。！？、]+/).filter(t => t.length >= 2);
  if (tokens.length === 0) return [];

  const results: Array<{ text: string; weight: number }> = [];
  const seen = new Set<string>();

  for (const token of tokens.slice(0, 8)) {
    const rows = db.prepare(`
      SELECT DISTINCT dr.text, dr.weight FROM distilled_rules dr
      JOIN rule_sources rs ON rs.rule_id = dr.id
      WHERE rs.project_id = ? AND dr.text LIKE ? AND dr.superseded_by IS NULL
      ORDER BY dr.weight DESC LIMIT 3
    `).all(projectId, `%${token}%`) as Array<{ text: string; weight: number }>;

    for (const r of rows) {
      if (!seen.has(r.text)) {
        seen.add(r.text);
        results.push(r);
      }
    }
  }

  // Only return rules with weight ≥ 0.25 — filter out low-quality noise
  return results
    .filter(r => r.weight >= 0.25)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 4)
    .map(r => `${r.text} (权重${r.weight.toFixed(2)})`);
}

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

  // L0 distilled rules lookup — keyword match against high-weight rules
  const mainProject = process.env.AGENTMEMORY_PROJECT || projectIds[0] || "claude-auto-memory";
  let ruleLines: string[] = [];
  try {
    ruleLines = searchDistilledRules(db, userMessage, mainProject);
    if (ruleLines.length > 0 && bestBlock) {
      bestBlock = bestBlock + "\n**相关规则（蒸馏知识）:**\n" + ruleLines.map(l => `- ${l}`).join("\n");
    } else if (ruleLines.length > 0) {
      bestBlock = "**相关规则（蒸馏知识）:**\n" + ruleLines.map(l => `- ${l}`).join("\n");
      bestConfidence = Math.max(bestConfidence, 0.3);
    }
  } catch {}

  // Lightweight signal extraction — runs per user message, < 50ms
  try {
    const signals = extractSignals(userMessage);
    if (signals.length > 0) {
      persistLightweightSignals(mainProject, sessionId, signals);

      // Correction event retrieval: when user corrects agent,
      // search past 30 days for similar corrections as quick reference.
      const hasCorrection = signals.some(s => s.signalType === "correction");
      if (hasCorrection) {
        const pastCorrections = db.prepare(`
          SELECT f.id, f.summary, f.created_at FROM fragments f
          JOIN fragment_anchors fa ON fa.fragment_id = f.id
          WHERE f.project_id = ? AND fa.channel = 'FEEL' AND fa.weight >= 80
            AND f.created_at > ? AND f.asset_state != 'user_deleted'
          ORDER BY fa.weight DESC, f.created_at DESC LIMIT 5
        `).all(mainProject, Date.now() - 30 * 24 * 60 * 60 * 1000) as Array<{ id: string; summary: string; created_at: number }>;

        if (pastCorrections.length > 0) {
          const lines = pastCorrections.slice(0, 2).map(f =>
            `  · ${f.summary} (${new Date(f.created_at).toLocaleDateString("zh-CN")})`
          );
          const correctionBlock = "相关历史: 过去30天内被纠正过类似问题:\n" + lines.join("\n");
          if (bestBlock) {
            bestBlock = bestBlock + "\n" + correctionBlock;
          } else {
            bestBlock = correctionBlock;
            bestConfidence = Math.max(bestConfidence, 0.25);
          }
        }
      }
    }
  } catch {}

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
