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

export function updateActiveContext(projectId: string): void {
  const db = getDb();

  // 1. Load existing active_context
  let ctx: ActiveContext = { decisions: [], todos: [], preferences: [] };
  const row = db.prepare("SELECT active_context FROM projects WHERE id = ?").get(projectId) as { active_context: string | null } | undefined;
  if (row?.active_context) {
    try {
      const parsed = JSON.parse(row.active_context);
      ctx.decisions = parsed.decisions ?? [];
      ctx.todos = parsed.todos ?? [];
      ctx.preferences = parsed.preferences ?? [];
      ctx.care = parsed.care;
      ctx.alerts = parsed.alerts;
    } catch {
      // Corrupt JSON — start fresh
    }
  }

  // Build hash set from existing entries for dedup
  const existingHashes = new Set<string>();
  for (const cat of ["decisions", "todos", "preferences"] as const) {
    for (const entry of ctx[cat]) {
      existingHashes.add(`${cat}:${entry.text}`);
    }
  }

  // 2. Query tagged fragments
  const taggedFrags = db.prepare(`
    SELECT session_id, summary, subtype, created_at
    FROM fragments
    WHERE project_id = ? AND subtype IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 200
  `).all(projectId) as Array<{ session_id: string; summary: string; subtype: string; created_at: number }>;

  if (taggedFrags.length === 0) return;

  // 3. Merge
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
        ctx.decisions[dupIdx] = entry; // replace older
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

  // 4. Truncate per-category cap
  for (const cat of ["decisions", "todos", "preferences"] as const) {
    if (ctx[cat].length > MAX_ENTRIES_PER_CATEGORY) {
      ctx[cat] = ctx[cat].slice(-MAX_ENTRIES_PER_CATEGORY);
    }
  }

  // 5. Global char truncation — preference-weighted removal order:
  //    todos first (stale fastest), then decisions, preferences last (user identity)
  const REMOVAL_ORDER: Array<"decisions" | "todos" | "preferences"> = ["todos", "decisions", "preferences"];
  let serialized = JSON.stringify(ctx);
  let safety = 50;
  while (serialized.length > MAX_CONTEXT_CHARS && safety > 0) {
    let removed = false;
    // Try each category in removal-priority order
    for (const cat of REMOVAL_ORDER) {
      if (ctx[cat].length === 0) continue;
      // Remove the oldest entry in this category
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
        break; // One removal per iteration, re-check size
      }
    }
    if (!removed) break; // All categories empty
    serialized = JSON.stringify(ctx);
    safety--;
  }

  // 6. Persist
  db.prepare("UPDATE projects SET active_context = ? WHERE id = ?").run(serialized, projectId);
}

/** Inject a proactive care message into active_context (called from dreaming worker) */
export function injectCareMessage(projectId: string, care: { message: string; level: string; triggers: string[] }): void {
  const db = getDb();
  let ctx: ActiveContext = { decisions: [], todos: [], preferences: [] };
  const row = db.prepare("SELECT active_context FROM projects WHERE id = ?").get(projectId) as { active_context: string | null } | undefined;
  if (row?.active_context) {
    try { const parsed = JSON.parse(row.active_context); ctx = { ...ctx, ...parsed }; } catch {}
  }
  // Priority gate: don't overwrite a higher-level care that's still fresh (< 24h)
  if (ctx.care && ctx.care.at > Date.now() - 24 * 60 * 60 * 1000) {
    const levelRank: Record<string, number> = { suggestion: 1, gentle_nudge: 2, active_concern: 3 };
    if ((levelRank[care.level] || 0) < (levelRank[ctx.care.level] || 0)) return;
  }
  ctx.care = { ...care, at: Date.now() };
  db.prepare("UPDATE projects SET active_context = ? WHERE id = ?").run(JSON.stringify(ctx), projectId);
}

/** Inject alerts into active_context (called from dreaming worker) */
export function injectAlerts(projectId: string, alerts: Array<{ type: string; severity: string; message: string }>): void {
  const db = getDb();
  let ctx: ActiveContext = { decisions: [], todos: [], preferences: [] };
  const row = db.prepare("SELECT active_context FROM projects WHERE id = ?").get(projectId) as { active_context: string | null } | undefined;
  if (row?.active_context) {
    try { const parsed = JSON.parse(row.active_context); ctx = { ...ctx, ...parsed }; } catch {}
  }
  ctx.alerts = alerts.map(a => ({ ...a, at: Date.now() }));
  db.prepare("UPDATE projects SET active_context = ? WHERE id = ?").run(JSON.stringify(ctx), projectId);
}
