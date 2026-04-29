/**
 * Auction Engine — Modified Vickrey (sealed-bid, second-price) with trust weighting.
 *
 * A3 compliant: deterministic sort + select, no LLM.
 * Truthful bidding is dominant strategy in Vickrey auctions.
 *
 * Phase-3 added the `skillMatch` factor so a persona-aware bid is rewarded
 * for advertising capabilities the task actually needs. Tier-awareness is NOT
 * folded into skillMatch — tier already enters the score through
 * `capability²` (claim confidence is tier-clamped) and `trust²` (Wilson LB on
 * empirical outcomes). Adding tier here would double-count.
 *
 * Source of truth: Economy OS plan §E3
 */
import { wilsonLowerBound } from '../../sleep-cycle/wilson.ts';
import type { AuctionResult, BidAccuracyRecord, EngineBid, MarketPhase } from './schemas.ts';

export interface BidderContext {
  successes: number;
  failures: number;
  capabilityScore: number;
  bidAccuracy: BidAccuracyRecord | null;
  /**
   * Phase-12 — multiplicative attenuator from `PersonaOverclaimTracker`,
   * looked up by `bid.personaId`. Defaults to 1.0 (no penalty) when the
   * caller hasn't supplied it, when `bid.personaId` is unset (legacy bid),
   * or when the persona is still in cold-start (< 10 observations). Range
   * is `[1 - MAX_PENALTY_DEPTH, 1.0]` = `[0.5, 1.0]`.
   */
  personaOverclaimPenalty?: number;
}

export interface ScoredBid {
  bid: EngineBid;
  score: number;
}

/**
 * One required-capability the task is judged to need. Phase-3 auctions accept
 * this list and weight bids by how many of these capability ids the bid's
 * `declaredCapabilityIds` covers. The shape mirrors `CapabilityRequirement`
 * (`src/orchestrator/types.ts`) but the auction layer only needs `id` + `weight`.
 */
export interface RequiredCapability {
  id: string;
  /** [0, 1] importance — same convention as `CapabilityRequirement.weight`. */
  weight: number;
}

/**
 * Compute the weighted-coverage of required capabilities by what a bid
 * declares it can do. Returns 1.0 when the task has no capability requirements
 * (legacy / non-persona path) so legacy bids are never penalised.
 *
 * Match model: binary. Either the bid covers the required cap id or it
 * doesn't. Tier strength enters the overall score elsewhere — see scoreBid
 * doc comment.
 */
export function computeSkillMatch(
  declaredCapabilityIds: readonly string[] | undefined,
  required: readonly RequiredCapability[] | undefined,
): number {
  if (!required || required.length === 0) return 1.0;
  const provided = new Set(declaredCapabilityIds ?? []);
  let totalWeight = 0;
  let weightedCovered = 0;
  for (const req of required) {
    totalWeight += req.weight;
    if (provided.has(req.id)) weightedCovered += req.weight;
  }
  if (totalWeight === 0) return 1.0;
  return weightedCovered / totalWeight;
}

/**
 * Score a single bid. A3: deterministic formula.
 *
 * score = trust² × capability² × costEfficiency^0.5 × accuracyPremium
 *       × skillMatch × overclaimPenalty × remotePenalty
 *
 * `skillMatch` is the Phase-3 addition: required-capability coverage as a
 * multiplicative attenuator. A bid that misses every required capability
 * scores 0 (skillMatch=0), regardless of trust/capability/cost.
 *
 * `overclaimPenalty` is the Phase-12 addition: persona-keyed attenuator
 * driven by `PersonaOverclaimTracker`. Defaults to 1.0 when the caller
 * doesn't inject a value (legacy bids, cold-start, no persona). Closes the
 * Phase-11 producer/consumer loop on `bid:overclaim_detected`.
 */
export function scoreBid(
  bid: EngineBid,
  context: BidderContext,
  taskBudgetTokens: number,
  requiredCapabilities?: readonly RequiredCapability[],
): number {
  // Trust: Wilson LB of (successes / total)
  const total = context.successes + context.failures;
  const trust = total > 0 ? wilsonLowerBound(context.successes, total) : 0.1;

  // Capability match (from external CapabilityModel)
  const capability = Math.max(0.1, context.capabilityScore);

  // Cost efficiency. Skill-card prompt overhead is included so a heavily-
  // loaded persona is not silently disadvantaged on cost — and so the budget
  // cap below funds the actual prompt size, not the bare task tokens.
  const estimatedTokens = bid.estimatedTokensInput + bid.estimatedTokensOutput + (bid.skillTokenOverhead ?? 0);
  const costRatio = taskBudgetTokens > 0 ? Math.min(estimatedTokens / taskBudgetTokens, 1.0) : 0;
  const costEfficiency = Math.max(0.1, 1 - costRatio);

  // Accuracy premium from bid history
  let accuracyPremium: number;
  if (!context.bidAccuracy || context.bidAccuracy.total_settled_bids < 10) {
    accuracyPremium = 0.5; // cold-start neutral
  } else {
    accuracyPremium = Math.max(0.3, context.bidAccuracy.accuracy_ema);
    // Penalty multiplier if active
    if (context.bidAccuracy.penalty_active) {
      accuracyPremium *= 0.5;
    }
  }

  // Phase-3: skill-match attenuator. Multiplicative so a persona that doesn't
  // advertise the required capabilities cannot win on trust+cost alone.
  const skillMatch = computeSkillMatch(bid.declaredCapabilityIds, requiredCapabilities);

  // Phase-12: persona overclaim penalty. Default 1.0 keeps legacy callers /
  // cold-start personas neutral. Past cold-start, ratios above 0 chip away
  // up to `1 - MAX_PENALTY_DEPTH` = 0.5x.
  const overclaimPenalty = context.personaOverclaimPenalty ?? 1.0;

  // Remote bidders get a trust penalty (A5: prefer local evidence)
  const remotePenalty = bid.bidderType === 'remote' ? 0.9 : 1.0;

  return (
    trust ** 2 *
    capability ** 2 *
    costEfficiency ** 0.5 *
    accuracyPremium *
    skillMatch *
    overclaimPenalty *
    remotePenalty
  );
}

/**
 * Run a Vickrey auction: score all bids, select winner, compute budget cap.
 *
 * Phase-3 accepts an optional `requiredCapabilities` list; bids whose
 * `declaredCapabilityIds` cover the requirements score higher through the
 * `skillMatch` factor in `scoreBid`. Legacy callers (no requirements) get the
 * pre-Phase-3 behaviour because skillMatch defaults to 1.0.
 */
export function runAuction(
  auctionId: string,
  taskId: string,
  bids: EngineBid[],
  contexts: Map<string, BidderContext>,
  taskBudgetTokens: number,
  phase: MarketPhase,
  requiredCapabilities?: readonly RequiredCapability[],
): AuctionResult | null {
  if (bids.length === 0) return null;

  // Score and sort
  const scored: ScoredBid[] = bids
    .map((bid) => {
      const ctx = contexts.get(bid.bidderId) ?? { successes: 0, failures: 0, capabilityScore: 0.5, bidAccuracy: null };
      return { bid, score: scoreBid(bid, ctx, taskBudgetTokens, requiredCapabilities) };
    })
    .sort((a, b) => b.score - a.score);

  const winner = scored[0]!;
  const second = scored.length >= 2 ? scored[1]! : null;

  // Vickrey budget cap: bound by second-price estimate. Skill-card prompt
  // overhead is folded in on both sides so the cap does not strand a
  // skill-loaded winner just because the second-price bidder loaded nothing
  // (risk L4 mitigation).
  let budgetCap: number | null = null;
  if (second) {
    const winnerTokens =
      winner.bid.estimatedTokensInput + winner.bid.estimatedTokensOutput + (winner.bid.skillTokenOverhead ?? 0);
    const secondTokens =
      second.bid.estimatedTokensInput + second.bid.estimatedTokensOutput + (second.bid.skillTokenOverhead ?? 0);
    budgetCap = Math.max(winnerTokens, Math.ceil(secondTokens * 1.1));
  }

  return {
    auctionId,
    taskId,
    winnerId: winner.bid.bidderId,
    winnerScore: winner.score,
    secondScore: second?.score ?? null,
    budgetCap,
    bidderCount: bids.length,
    phase,
    completedAt: Date.now(),
  };
}
