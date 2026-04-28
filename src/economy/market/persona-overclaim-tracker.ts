/**
 * PersonaOverclaimTracker — Phase-12 consumer for `bid:overclaim_detected`.
 *
 * Phase-11 ships the producer (`SkillUsageTracker` + factory comparator) which
 * emits `bid:overclaim_detected` whenever a persona was loaded with ≥2 skills
 * but used < OVERCLAIM_RATIO_THRESHOLD of them during execution. Phase-12 closes
 * the loop: this tracker accumulates per-persona overclaim signals and surfaces
 * a multiplicative penalty into the auction's `scoreBid`, so a habitually
 * overclaiming persona pays a real cost on its next bid.
 *
 * Key design choice — persona-keyed, NOT provider-keyed:
 *   - The existing `BidAccuracyTracker` is keyed by `bidderId` (provider, e.g.
 *     'anthropic-sonnet-4'). Folding overclaim there would conflate two
 *     orthogonal signals: cost-prediction accuracy (provider) and skill-usage
 *     honesty (persona). A single provider may run many personas; penalising
 *     the provider for one persona's overclaim would starve the others.
 *   - The schema slot `BidAccuracyRecord.overclaim_violations` was reserved in
 *     Phase 1 for this purpose but has been dead since — we leave that field
 *     untouched (free for future provider-level signals) and put persona
 *     overclaim in its own ledger.
 *
 * Cold-start: until a persona has been observed at least
 * `MIN_OBSERVATIONS_FOR_PENALTY` (10) times, the penalty is 1.0 — sparse data
 * cannot be punished (A2: uncertainty represented as no-op). Past cold-start,
 * `penalty = 1 - min(MAX_PENALTY_DEPTH, overclaim_ratio)`. So:
 *   - 0% overclaim → 1.0   (no penalty)
 *   - 25% overclaim → 0.75
 *   - 50%+ overclaim → 0.5 (floor — score halved at worst)
 *
 * The 0.5 floor mirrors the existing `penalty_active` halving in
 * `BidAccuracyTracker` so the scoreBid formula degrades gracefully rather than
 * flooring to zero on a noisy signal.
 *
 * Pure data — no IO, no clock, no LLM. A3 compliant.
 */

/** Minimum task observations before a penalty is computed at all. */
export const MIN_OBSERVATIONS_FOR_PENALTY = 10;

/**
 * Maximum penalty depth — the score multiplier never drops below
 * `1 - MAX_PENALTY_DEPTH`. Mirrors the 0.5x cap on `penalty_active` in
 * `BidAccuracyTracker`. A persona with sustained overclaim still bids; it
 * just bids at half strength.
 */
export const MAX_PENALTY_DEPTH = 0.5;

interface PersonaOverclaimRecord {
  observations: number;
  overclaims: number;
}

export class PersonaOverclaimTracker {
  private readonly records = new Map<string, PersonaOverclaimRecord>();

  /**
   * Record an `bid:overclaim_detected` event for `personaId`. Idempotent only
   * for distinct events — callers must dedupe upstream if the same task could
   * fire twice (the factory comparator clears the per-task entry, so this is
   * not a concern in practice).
   */
  recordOverclaim(personaId: string): void {
    const r = this.ensure(personaId);
    r.overclaims += 1;
  }

  /**
   * Record one task observation — call this on EVERY task completion where
   * the persona was loaded with ≥2 skills (i.e. where overclaim COULD have
   * fired). Without this, `getOverclaimRatio` would compare overclaims to
   * total bid count, which conflates "no overclaim" with "no opportunity to
   * overclaim".
   */
  recordObservation(personaId: string): void {
    const r = this.ensure(personaId);
    r.observations += 1;
  }

  /** Read-only snapshot of a persona's record. Returns null when unknown. */
  getRecord(personaId: string): { observations: number; overclaims: number } | null {
    const r = this.records.get(personaId);
    return r ? { observations: r.observations, overclaims: r.overclaims } : null;
  }

  /**
   * Empirical overclaim ratio. Returns 0 for unknown personas and for those
   * with `observations === 0`. Past cold-start this is `overclaims / observations`,
   * never higher than 1.0.
   */
  getOverclaimRatio(personaId: string): number {
    const r = this.records.get(personaId);
    if (!r || r.observations === 0) return 0;
    return Math.min(1, r.overclaims / r.observations);
  }

  /**
   * Multiplicative attenuator for `scoreBid`. Returns 1.0 when:
   *   - the persona is unknown, OR
   *   - `observations < MIN_OBSERVATIONS_FOR_PENALTY` (cold-start: no penalty).
   * Past cold-start: `1 - min(MAX_PENALTY_DEPTH, ratio)`. Never lower than
   * `1 - MAX_PENALTY_DEPTH` (= 0.5).
   */
  getPenaltyMultiplier(personaId: string): number {
    const r = this.records.get(personaId);
    if (!r || r.observations < MIN_OBSERVATIONS_FOR_PENALTY) return 1;
    const ratio = r.overclaims / r.observations;
    return 1 - Math.min(MAX_PENALTY_DEPTH, ratio);
  }

  /** Wipe all state. Tests use this to isolate fixtures. */
  reset(): void {
    this.records.clear();
  }

  private ensure(personaId: string): PersonaOverclaimRecord {
    let r = this.records.get(personaId);
    if (!r) {
      r = { observations: 0, overclaims: 0 };
      this.records.set(personaId, r);
    }
    return r;
  }
}
