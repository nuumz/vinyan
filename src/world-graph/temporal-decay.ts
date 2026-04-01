/**
 * Temporal context decay — ECP spec §3.6.
 * Computes current effective confidence based on verdict age and decay model.
 *
 * Decay models:
 * - "none": constant until valid_until, then 0
 * - "step": constant until valid_until, then 50% of original
 * - "linear": decreases linearly from valid_from to valid_until, then 0
 *
 * Source of truth: vinyan-ecp-spec.md §3.6
 */

/**
 * Compute decayed confidence at a given point in time.
 */
export function computeDecayedConfidence(
  originalConfidence: number,
  verifiedAt: number,
  validUntil: number | undefined,
  decayModel: "linear" | "step" | "none" | undefined,
  now: number = Date.now(),
): number {
  if (!validUntil || !decayModel) return originalConfidence;

  if (decayModel === "none") {
    return now < validUntil ? originalConfidence : 0;
  }

  if (decayModel === "step") {
    return now < validUntil ? originalConfidence : originalConfidence * 0.5;
  }

  // "linear": decreases linearly from verifiedAt to validUntil
  const total = validUntil - verifiedAt;
  if (total <= 0) return 0;
  const elapsed = now - verifiedAt;
  if (elapsed <= 0) return originalConfidence;
  if (elapsed >= total) return 0;
  const remaining = 1 - elapsed / total;
  return originalConfidence * remaining;
}

/**
 * Check if a fact with temporal context is fully expired (confidence = 0).
 * Step-decay never fully expires (drops to 50%, per ECP spec §3.6).
 */
export function isFullyExpired(
  validUntil: number | undefined,
  decayModel: "linear" | "step" | "none" | undefined,
  now: number = Date.now(),
): boolean {
  if (!validUntil) return false;
  if (decayModel === "step") return false;
  return now >= validUntil;
}
