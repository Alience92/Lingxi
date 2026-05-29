export const CONSTITUTIONAL_WEIGHT_THRESHOLD = 80;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
const ONE_EIGHTY_DAYS_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * Novelty factor: 1.0 (brand new) → 0.0 (mature, 30+ days).
 * All learning thresholds scale with this factor so the system learns
 * aggressively in the first few days (when user churn risk is highest)
 * and gradually settles to a maintenance cadence.
 *
 * Retention logic:
 *   Day 1-3   → nf=0.8-1.0   "用户最敏感，3天没提升就卸载"
 *   Day 4-7   → nf=0.5       "一周内期望看到变化"
 *   Day 8-14  → nf=0.3       "两周后感知减弱"
 *   Day 15-30 → nf=0.1       "月后进入稳态"
 *   Day 30+   → nf=0.0       "成熟系统，标准阈值"
 */
export function noveltyFactor(systemAgeDays: number): number {
  if (systemAgeDays <= 0) return 1.0;
  if (systemAgeDays <= 1) return 1.0;
  if (systemAgeDays <= 3) return 0.8;
  if (systemAgeDays <= 7) return 0.5;
  if (systemAgeDays <= 14) return 0.3;
  if (systemAgeDays <= 30) return 0.1;
  return 0;
}

/** Compute system age in days from the timestamp of the oldest fragment. */
export function calcSystemAgeDays(firstFragmentAt: number | null): number {
  if (!firstFragmentAt) return 0;
  return (Date.now() - firstFragmentAt) / 86_400_000;
}

/** Apply novelty factor to a threshold: mature value when nf=0, accelerated when nf=1. */
export function applyNovelty(matureValue: number, nf: number, acceleration: number = 0.8): number {
  return Math.max(1, Math.round(matureValue * (1 - nf * acceleration)));
}

export interface DecayResult {
  score: number;
  retrievalState: "active" | "warm" | "archived" | "cold";
}

// Anchor weight slows down decay — higher weight = slower aging.
// Constitutional fragments (weight ≥ 80) are protected at the engine level
// and should never be archived. This function applies weighted decay for
// non-constitutional fragments (weight < 80).
function weightMultiplier(anchorWeight: number): number {
  if (anchorWeight >= 80) return 1.0;  // constitutional — no decay, protected upstream
  if (anchorWeight >= 50) return 0.5;  // important — half speed
  if (anchorWeight >= 30) return 0.8;  // normal — slight slowdown
  return 1.0;                          // default — full speed
}

export function computeDecayScore(
  createdAt: number,
  lastRecalledAt: number | null,
  recalledCount: number,
  anchorWeight: number = 10,
  noveltyFactor: number = 0,
): DecayResult {
  const now = Date.now();

  if (lastRecalledAt) {
    const hoursSinceRecall = (now - lastRecalledAt) / (60 * 60 * 1000);
    if (hoursSinceRecall < 24) return { score: 1.0, retrievalState: "active" };
  }

  const age = now - createdAt;
  const wm = weightMultiplier(anchorWeight);

  // Novelty-adjusted decay window: brand-new systems (nf=1) decay at ~1 day,
  // mature systems (nf=0) use the standard 7-day window.
  const effectiveDecayMs = SEVEN_DAYS_MS * (1 - noveltyFactor * 0.85);

  if (age < effectiveDecayMs) return { score: 1.0, retrievalState: "active" };

  const recalledMultiplier = recalledCount === 0 ? 0.8 : 1.0;

  if (age < THIRTY_DAYS_MS) return { score: Math.max(0.1, 0.7 * recalledMultiplier * (1 - wm * 0.5)), retrievalState: "warm" };
  if (age < SIXTY_DAYS_MS) return { score: Math.max(0.1, 0.3 * recalledMultiplier * (1 - wm * 0.7)), retrievalState: "warm" };

  // 60-180 days: archived — still in DB, searchable by explicit query only
  if (age < ONE_EIGHTY_DAYS_MS) return { score: 0, retrievalState: "archived" };

  // 180+ days: cold — skipped by normal queries, only L1_archive recall
  return { score: 0, retrievalState: "cold" };
}

export function boostDecayScore(fragment: {
  decayScore: number;
  recalledCount: number;
  lastRecalledAt: number | null;
}): void {
  fragment.decayScore = 1.0;
  fragment.recalledCount += 1;
  fragment.lastRecalledAt = Date.now();
}
