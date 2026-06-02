// Dreaming trigger: multi-signal independent checks, not dependent on compact.
// Three trigger conditions, any one met → dreaming should run.

import { getDb } from "../db/connection.js";
import { noveltyFactor, calcSystemAgeDays, applyNovelty } from "./decay.js";

export interface TriggerCheck {
  shouldTrigger: boolean;
  reason: string | null;
  signalCount: number;
}

const DREAMING_THRESHOLD = 100; // fragments (mature)
const SIGNAL_THRESHOLD = 50;    // lightweight signals (mature)
const TIME_THRESHOLD_MS = 12 * 60 * 60 * 1000; // 12 hours (mature)
const MIN_SIGNALS_FOR_TIME = 10; // minimum signals for time-based trigger
const MAINTENANCE_INTERVAL_MS = 48 * 60 * 60 * 1000; // 48h — pure time trigger, no signal requirement

/** Check all dreaming trigger conditions. Returns the first satisfied condition. */
export function checkDreamingTrigger(projectId: string): TriggerCheck {
  const db = getDb();

  // Compute novelty-adjusted thresholds
  const firstRow = db.prepare(
    "SELECT MIN(created_at) as first FROM fragments WHERE project_id = ?"
  ).get(projectId) as { first: number | null } | undefined;
  const ageDays = calcSystemAgeDays(firstRow?.first ?? null);
  const nf = noveltyFactor(ageDays);

  const signalThreshold = applyNovelty(SIGNAL_THRESHOLD, nf, 0.8);
  const fragmentThreshold = applyNovelty(DREAMING_THRESHOLD, nf, 0.8);
  // Time threshold: 12h mature → ~2.5h for brand-new systems
  const timeThresholdMs = TIME_THRESHOLD_MS * (1 - nf * 0.8);
  const minSignals = applyNovelty(MIN_SIGNALS_FOR_TIME, nf, 0.7);

  const lastDreaming = db.prepare("SELECT last_dreaming_at FROM projects WHERE id = ?").get(projectId) as { last_dreaming_at: number | null } | undefined;
  const lastAt = lastDreaming?.last_dreaming_at ?? 0;
  const now = Date.now();
  const hoursSince = lastAt > 0 ? Math.round((now - lastAt) / 3600000 * 10) / 10 : Infinity;

  // Condition A: Signal count
  const sigCount = db.prepare(
    "SELECT COUNT(*) as cnt FROM lightweight_signals WHERE project_id = ? AND consumed = 0"
  ).get(projectId) as { cnt: number };

  if (sigCount.cnt >= signalThreshold) {
    return { shouldTrigger: true, reason: `轻量信号积累 ${sigCount.cnt} 条 (nf=${nf.toFixed(1)} 阈值 ${signalThreshold})`, signalCount: sigCount.cnt };
  }

  // Condition B: Time-based
  if (now - lastAt >= timeThresholdMs && sigCount.cnt >= minSignals) {
    const thresholdH = Math.round(timeThresholdMs / 3600000 * 10) / 10;
    return { shouldTrigger: true, reason: `距上次 dreaming ${hoursSince}h (nf=${nf.toFixed(1)} 阈值 ${thresholdH}h) + ${sigCount.cnt} 条信号`, signalCount: sigCount.cnt };
  }

  // Condition C: Fragment-based
  const fragCount = db.prepare(
    "SELECT COUNT(*) as cnt FROM fragments WHERE project_id = ? AND created_at > ? AND retrieval_state IN ('active','warm') AND asset_state != 'user_deleted'"
  ).get(projectId, lastAt) as { cnt: number };

  if (fragCount.cnt >= fragmentThreshold) {
    return { shouldTrigger: true, reason: `新碎片 ${fragCount.cnt} 条 (nf=${nf.toFixed(1)} 阈值 ${fragmentThreshold})`, signalCount: sigCount.cnt };
  }

  // Condition D: Maintenance — pure time trigger, no signal requirement.
  // Ensures decay runs even during quiet periods. Novelty-adjusted: 48h → ~10h for new systems.
  const maintenanceInterval = MAINTENANCE_INTERVAL_MS * (1 - nf * 0.8);
  if (lastAt > 0 && now - lastAt >= maintenanceInterval) {
    const thresholdH = Math.round(maintenanceInterval / 3600000 * 10) / 10;
    return { shouldTrigger: true, reason: `维护触发: 距上次 dreaming ${hoursSince}h (nf=${nf.toFixed(1)} 阈值 ${thresholdH}h)`, signalCount: sigCount.cnt };
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
