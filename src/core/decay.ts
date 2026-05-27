export const CONSTITUTIONAL_WEIGHT_THRESHOLD = 80;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
const ONE_EIGHTY_DAYS_MS = 180 * 24 * 60 * 60 * 1000;

export interface DecayResult {
  score: number;
  status: "active" | "archived" | "deleted";
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
  anchorWeight: number = 10
): DecayResult {
  const now = Date.now();

  if (lastRecalledAt) {
    const hoursSinceRecall = (now - lastRecalledAt) / (60 * 60 * 1000);
    if (hoursSinceRecall < 24) return { score: 1.0, status: "active" };
  }

  const age = now - createdAt;
  const wm = weightMultiplier(anchorWeight);

  if (age < SEVEN_DAYS_MS) return { score: 1.0, status: "active" };

  const recalledMultiplier = recalledCount === 0 ? 0.8 : 1.0;

  if (age < THIRTY_DAYS_MS) return { score: Math.max(0.1, 0.7 * recalledMultiplier * (1 - wm * 0.5)), status: "active" };
  if (age < SIXTY_DAYS_MS) return { score: Math.max(0.1, 0.3 * recalledMultiplier * (1 - wm * 0.7)), status: "active" };

  if (age < ONE_EIGHTY_DAYS_MS) return { score: 0, status: "archived" };

  return { score: 0, status: "deleted" };
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
