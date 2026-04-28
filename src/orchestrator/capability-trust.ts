/**
 * Capability trust — unified scoring across the canonical 5-tier ConfidenceTier
 * ladder, evidence provenance, and Wilson lower bound on real-world outcomes.
 *
 * Axiom anchors:
 *   - A5 Tiered Trust: deterministic > heuristic > pragmatic > probabilistic > speculative.
 *     ConfidenceTier weight comes from `src/core/confidence-tier.ts`.
 *   - A2 First-Class Uncertainty: a sparse `'evolved'` claim (n<10) reports
 *     neutral 0.5 instead of pretending to a strong Wilson LB it cannot earn.
 *   - A3 Deterministic Governance: `effectiveTrust` is a pure function. No LLM
 *     in the routing/scoring path.
 *
 * Replaces the prior implicit ordering where `evidence:'builtin'` claims with
 * confidence 0.85–0.95 outranked `evidence:'evolved'` Wilson LB. The new rule:
 *   mature evolved (n≥10) > curated builtin > sparse evolved (n<10) ≈ synthesized > inferred.
 */
import type { ConfidenceTier } from '../core/confidence-tier.ts';
import { TIER_WEIGHT } from '../core/confidence-tier.ts';
import { wilsonLowerBound } from '../sleep-cycle/wilson.ts';
import type { CapabilityClaim, CapabilityEvidence } from './types.ts';

/**
 * Minimum sample size before a Wilson LB on outcomes can outrank the cold-start
 * neutral. Mirrors the auction `accuracyPremium` cold-start at
 * `src/economy/market/auction-engine.ts:44` (≥10 settled bids → use EMA).
 */
export const WILSON_FLOOR_MIN_TRIALS = 10;

/** Cold-start neutral value when there are insufficient outcomes. */
export const WILSON_COLD_START = 0.5;

/**
 * Provenance weight per evidence source. Multiplies the Wilson LB to enforce
 * A5 ordering. `evolved` carries the highest provenance weight because it
 * descends from real-world outcomes; `inferred` is the weakest because it is
 * a routing-hint synthesis with no confirmation.
 */
export const EVIDENCE_WEIGHT: Record<CapabilityEvidence, number> = {
  evolved: 1.0,
  builtin: 0.7,
  synthesized: 0.5,
  inferred: 0.4,
};

/**
 * Optional per-claim outcome counts. Callers that have wired Wilson outcome
 * tracking (sleep-cycle, agent-proposal-store) supply `successes` and `total`
 * so cold-start can be detected. Callers without outcome data omit the field
 * and rely on the claim's static `confidence` instead.
 */
export interface ClaimOutcomes {
  successes: number;
  total: number;
}

/**
 * Compute the Wilson lower bound, with a cold-start floor when sample size is
 * below `WILSON_FLOOR_MIN_TRIALS`. Returns `WILSON_COLD_START` rather than 0
 * to preserve A2: "we don't know yet" is not the same as "we know it's bad."
 */
export function wilsonLBFloor(outcomes: ClaimOutcomes | null | undefined): number {
  if (!outcomes || outcomes.total < WILSON_FLOOR_MIN_TRIALS) return WILSON_COLD_START;
  return wilsonLowerBound(outcomes.successes, outcomes.total);
}

/**
 * Effective trust score for a capability claim, in [0, 1].
 *
 *     effectiveTrust = TIER_WEIGHT[skillTier] × wilsonLBFloor(outcomes) × EVIDENCE_WEIGHT[evidence]
 *
 * `skillTier` defaults to `'speculative'` when the claim does not carry one
 * (e.g. legacy `'inferred'` claims with no skill backing). When `outcomes`
 * is omitted, the formula uses the claim's static `confidence` clamped to
 * the cold-start neutral — this lets curated `'builtin'` claims contribute
 * without inventing fake outcome data.
 *
 * Example orderings:
 *   - mature evolved (deterministic skill, 50/50 success): 1.0 × wilsonLB(50,50) × 1.0 ≈ 0.93
 *   - curated builtin (heuristic, no outcomes):           0.7 × 0.5             × 0.7 ≈ 0.245
 *   - sparse evolved (probabilistic, 3/3 success):        0.4 × 0.5             × 1.0 ≈ 0.2
 *   - synthesized claim (no tier, no outcomes):           0.15 × 0.5            × 0.5 ≈ 0.038
 *   - inferred claim (no tier, no outcomes):              0.15 × 0.5            × 0.4 ≈ 0.030
 *
 * See test fixture `tests/orchestrator/capability-trust.test.ts` for the full
 * ordering invariants.
 */
export function effectiveTrust(
  claim: CapabilityClaim,
  outcomes?: ClaimOutcomes | null,
  skillTier?: ConfidenceTier,
): number {
  const tier: ConfidenceTier = skillTier ?? 'speculative';
  const tierWeight = TIER_WEIGHT[tier];
  const provenanceWeight = EVIDENCE_WEIGHT[claim.evidence];
  // When outcomes are supplied, the Wilson LB drives the score. When absent,
  // we fall back to the static `confidence` clamped at the cold-start floor —
  // a curated builtin claim with confidence 0.95 still earns its declared
  // confidence through provenance/tier weighting, not by faking outcomes.
  const wilson = outcomes ? wilsonLBFloor(outcomes) : Math.max(WILSON_COLD_START, claim.confidence);
  return tierWeight * wilson * provenanceWeight;
}
