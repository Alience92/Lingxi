// Dreaming trigger: multi-signal independent checks, not dependent on compact.
// Three trigger conditions, any one met → dreaming should run.

import { getDb } from "../db/connection.js";

export interface TriggerCheck {
  shouldTrigger: boolean;
  reason: string | null;
  signalCount: number;
}

const DREAMING_THRESHOLD = 100; // fragments
const SIGNAL_THRESHOLD = 50;    // lightweight signals (condition A)
const TIME_THRESHOLD_MS = 12 * 60 * 60 * 1000; // 12 hours (condition B)
const MIN_SIGNALS_FOR_TIME = 10; // minimum signals for time-based trigger

/** Check all dreaming trigger conditions. Returns the first satisfied condition. */
export function checkDreamingTrigger(projectId: string): TriggerCheck {
  const db = getDb();

  const lastDreaming = db.prepare("SELECT last_dreaming_at FROM projects WHERE id = ?").get(projectId) as { last_dreaming_at: number | null } | undefined;
  const lastAt = lastDreaming?.last_dreaming_at ?? 0;
  const now = Date.now();
  const hoursSince = lastAt > 0 ? Math.round((now - lastAt) / 3600000 * 10) / 10 : Infinity;

  // Condition A: Signal count — ≥ 50 unconsumed lightweight signals
  const sigCount = db.prepare(
    "SELECT COUNT(*) as cnt FROM lightweight_signals WHERE project_id = ? AND consumed = 0"
  ).get(projectId) as { cnt: number };

  if (sigCount.cnt >= SIGNAL_THRESHOLD) {
    return { shouldTrigger: true, reason: `轻量信号积累 ${sigCount.cnt} 条 (阈值 ${SIGNAL_THRESHOLD})`, signalCount: sigCount.cnt };
  }

  // Condition B: Time-based — ≥ 12h since last dreaming AND ≥ 10 signals
  if (now - lastAt >= TIME_THRESHOLD_MS && sigCount.cnt >= MIN_SIGNALS_FOR_TIME) {
    return { shouldTrigger: true, reason: `距上次 dreaming ${hoursSince}h (阈值 12h) + ${sigCount.cnt} 条信号`, signalCount: sigCount.cnt };
  }

  // Condition C: Fragment-based (original) — ≥ 100 new fragments
  const fragCount = db.prepare(
    "SELECT COUNT(*) as cnt FROM fragments WHERE project_id = ? AND created_at > ? AND retrieval_state IN ('active','warm') AND asset_state != 'user_deleted'"
  ).get(projectId, lastAt) as { cnt: number };

  if (fragCount.cnt >= DREAMING_THRESHOLD) {
    return { shouldTrigger: true, reason: `新碎片 ${fragCount.cnt} 条 (阈值 ${DREAMING_THRESHOLD})`, signalCount: sigCount.cnt };
  }

  return { shouldTrigger: false, reason: null, signalCount: sigCount.cnt };
}

/** Mark lightweight signals as consumed after dreaming runs. */
export function consumeLightweightSignals(projectId: string): number {
  const db = getDb();
  const result = db.prepare(
    "UPDATE lightweight_signals SET consumed = 1 WHERE project_id = ? AND consumed = 0"
  ).run(projectId);
  return result.changes;
}
