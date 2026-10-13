// Active context engine: merges tagged fragments (decision/todo/preference) into
// a persistent JSON working-memory blob on the projects table.
// Called after fragmentation completes; SessionStart reads it at Recency position.

import { getDb } from "../db/connection.js";

interface ActiveContextEntry {
  text: string;
  session: string;
  at: number;
}

interface ActiveContext {
  decisions: ActiveContextEntry[];
  todos: ActiveContextEntry[];
  preferences: ActiveContextEntry[];
  care?: { message: string; level: string; at: number; triggers: string[] };
  alerts?: Array<{ type: string; severity: string; message: string; at: number }>;
}

const MAX_CONTEXT_CHARS = 3000;
const MAX_ENTRIES_PER_CATEGORY = 15;

function parseActiveContext(raw: string | null | undefined): ActiveContext {
  if (!raw) return { decisions: [], todos: [], preferences: [] };
  try {
    const parsed = JSON.parse(raw);
    return {
      decisions: parsed.decisions ?? [],
      todos: parsed.todos ?? [],
      preferences: parsed.preferences ?? [],
      care: parsed.care,
      alerts: parsed.alerts,
    };
  } catch {
    return { decisions: [], todos: [], preferences: [] };
  }
}

function withLockedActiveContext(projectId: string, updater: (ctx: ActiveContext) => void): void {
  const db = getDb();
  db.prepare("BEGIN IMMEDIATE").run();
  try {
    const row = db.prepare("SELECT active_context FROM projects WHERE id = ?").get(projectId) as { active_context: string | null } | undefined;
    const ctx = parseActiveContext(row?.active_context);
    updater(ctx);
    db.prepare("UPDATE projects SET active_context = ? WHERE id = ?").run(JSON.stringify(ctx), projectId);
    db.prepare("COMMIT").run();
  } catch (error) {
    try {
      db.prepare("ROLLBACK").run();
    } catch {}
    throw error;
  }
}

export function updateActiveContext(projectId: string): void {
  const db = getDb();

  // 2. Query tagged fragments
  const taggedFrags = db.prepare(`
    SELECT session_id, summary, subtype, created_at
    FROM fragments
    WHERE project_id = ? AND subtype IS NOT NULL
      AND retrieval_state IN ('active','warm')
      AND asset_state != 'user_deleted'
    ORDER BY created_at DESC
    LIMIT 200
  `).all(projectId) as Array<{ session_id: string; summary: string; subtype: string; created_at: number }>;

  if (taggedFrags.length === 0) return;

  withLockedActiveContext(projectId, (ctx) => {
    const existingHashes = new Set<string>();
    for (const cat of ["decisions", "todos", "preferences"] as const) {
      for (const entry of ctx[cat]) {
        existingHashes.add(`${cat}:${entry.text}`);
      }
    }

    for (const frag of taggedFrags) {
      const hash = `${frag.subtype}:${frag.summary}`;
      if (existingHashes.has(hash)) continue;

      const entry: ActiveContextEntry = {
        text: frag.summary,
        session: frag.session_id.slice(0, 8),
        at: frag.created_at,
      };

      if (frag.subtype === "decision") {
        const dupIdx = ctx.decisions.findIndex(d => d.text.slice(0, 50) === entry.text.slice(0, 50));
        if (dupIdx >= 0) {
          ctx.decisions[dupIdx] = entry;
        } else {
          ctx.decisions.push(entry);
        }
      } else if (frag.subtype === "todo") {
        const dupIdx = ctx.todos.findIndex(t => t.text.slice(0, 20) === entry.text.slice(0, 20));
        if (dupIdx >= 0) {
          ctx.todos[dupIdx] = entry;
        } else {
          ctx.todos.push(entry);
        }
      } else if (frag.subtype === "preference") {
        const dupIdx = ctx.preferences.findIndex(p => p.text.slice(0, 15) === entry.text.slice(0, 15));
        if (dupIdx >= 0) {
          ctx.preferences[dupIdx] = entry;
        } else {
          ctx.preferences.push(entry);
        }
      }

      existingHashes.add(hash);
    }

    for (const cat of ["decisions", "todos", "preferences"] as const) {
      if (ctx[cat].length > MAX_ENTRIES_PER_CATEGORY) {
        ctx[cat] = ctx[cat].slice(-MAX_ENTRIES_PER_CATEGORY);
      }
    }

    const removalOrder: Array<"decisions" | "todos" | "preferences"> = ["todos", "decisions", "preferences"];
    let serialized = JSON.stringify(ctx);
    let safety = 50;
    while (serialized.length > MAX_CONTEXT_CHARS && safety > 0) {
      let removed = false;
      for (const cat of removalOrder) {
        if (ctx[cat].length === 0) continue;
        let oldestAt = Infinity;
        let oldestIdx = -1;
        for (let i = 0; i < ctx[cat].length; i++) {
          if (ctx[cat][i]!.at < oldestAt) {
            oldestAt = ctx[cat][i]!.at;
            oldestIdx = i;
          }
        }
        if (oldestIdx >= 0) {
          ctx[cat].splice(oldestIdx, 1);
          removed = true;
          break;
        }
      }
      if (!removed) break;
      serialized = JSON.stringify(ctx);
      safety--;
    }
  });
}

/** Inject a proactive care message into active_context (called from dreaming worker) */
export function injectCareMessage(projectId: string, care: { message: string; level: string; triggers: string[] }): void {
  withLockedActiveContext(projectId, (ctx) => {
    if (ctx.care && ctx.care.at > Date.now() - 24 * 60 * 60 * 1000) {
      const levelRank: Record<string, number> = { suggestion: 1, gentle_nudge: 2, active_concern: 3 };
      if ((levelRank[care.level] || 0) < (levelRank[ctx.care.level] || 0)) return;
    }
    ctx.care = { ...care, at: Date.now() };
  });
}

/** Inject alerts into active_context (called from dreaming worker) */
export function injectAlerts(projectId: string, alerts: Array<{ type: string; severity: string; message: string }>): void {
  withLockedActiveContext(projectId, (ctx) => {
    ctx.alerts = alerts.map(a => ({ ...a, at: Date.now() }));
  });
}
