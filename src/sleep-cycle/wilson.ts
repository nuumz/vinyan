/**
 * Wilson Score Confidence Interval — statistical significance for Sleep Cycle patterns.
 *
 * Used to determine if observed failure/success rates are statistically significant,
 * not just noise from small sample sizes. TDD §12B requires Wilson lower bound
 * for anti-pattern (≥0.6) and success pattern (≥0.15) thresholds.
 *
 * Source of truth: spec/tdd.md §12B (Sleep Cycle Algorithm)
 */

/**
 * Compute the lower bound of the Wilson score confidence interval.
 *
 * @param successes - Number of "successes" (failures for anti-patterns, wins for success patterns)
 * @param total - Total number of observations
 * @param z - Z-score for confidence level (default: 1.96 for 95% CI)
 * @returns Lower bound of confidence interval [0, 1]
 */
export function wilsonLowerBound(successes: number, total: number, z = 1.96): number {
  if (total === 0) return 0;

  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);

  return Math.max(0, (centre - spread) / denominator);
}

/**
 * Compute the upper bound of the Wilson score confidence interval.
 */
export function wilsonUpperBound(successes: number, total: number, z = 1.96): number {
  if (total === 0) return 0;

  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);

  return Math.min(1, (centre + spread) / denominator);
}
