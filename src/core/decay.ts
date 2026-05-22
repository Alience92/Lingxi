const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
const ONE_EIGHTY_DAYS_MS = 180 * 24 * 60 * 60 * 1000;

export interface DecayResult {
  score: number;
  status: "active" | "archived" | "deleted";
}

export function computeDecayScore(
  createdAt: number,
  lastRecalledAt: number | null,
  recalledCount: number
): DecayResult {
  const now = Date.now();

  if (lastRecalledAt) {
    const hoursSinceRecall = (now - lastRecalledAt) / (60 * 60 * 1000);
    if (hoursSinceRecall < 24) return { score: 1.0, status: "active" };
  }

  const age = now - createdAt;

  if (age < SEVEN_DAYS_MS) return { score: 1.0, status: "active" };

  const multiplier = recalledCount === 0 ? 0.8 : 1.0;

  if (age < THIRTY_DAYS_MS) return { score: 0.7 * multiplier, status: "active" };
  if (age < SIXTY_DAYS_MS) return { score: 0.3 * multiplier, status: "active" };

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
