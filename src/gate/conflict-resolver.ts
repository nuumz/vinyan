/**
 * Conflict Resolver — 5-step deterministic contradiction resolution (concept §3.2).
 *
 * When oracles disagree (some pass, some fail), this replaces the naive
 * "any-fail = block" aggregation with a tiered resolution algorithm:
 *
 *   Step 1: Domain separation — cross-domain "conflicts" are both valid
 *   Step 2: Confidence comparison — higher tier wins (A5: deterministic > heuristic > probabilistic)
 *   Step 3: Evidence weight — more evidence items wins
 *   Step 4: Historical accuracy — oracle with better track record wins
 *   Step 5: Escalation — produce type: 'contradictory', emit event
 *
 * Axiom compliance: A5 (Tiered Trust), A3 (Deterministic Governance — rule-based, no LLM).
 */
import {
  computeConflictReport,
  cumulativeFusion,
  fromScalar,
  isValid,
  projectedProbability,
  temporalDecay,
} from '../core/subjective-opinion.ts';
import type { SubjectiveOpinion } from '../core/subjective-opinion.ts';
import type { OracleAbstention, OracleVerdict } from '../core/types.ts';

// ── Types ───────────────────────────────────────────────────────

export interface ConflictResolution {
  /** The winning verdict in this conflict pair. */
  winner: string;
  /** The losing verdict (overridden). */
  loser: string;
  /** Which step resolved it (1-5). Step 5 = unresolved escalation. */
  resolvedAtStep: 1 | 2 | 3 | 4 | 5;
  /** Human-readable explanation of why this oracle won. */
  explanation: string;
  /** Phase 4.8: Josang conflict mass K [0,1]. Present when SL-based resolution was attempted. */
  conflictK?: number;
  /** Phase 4.8: projectedProbability of fused SL opinion. Present when K ≤ 0.5 (fused at Step 2). */
  fusedProbability?: number;
}

export interface ResolvedGateResult {
  /** Final aggregated decision. */
  decision: 'allow' | 'block';
  /** Reasons for blocking (empty if allow). */
  reasons: string[];
  /** Resolution details for any conflicts that were resolved. */
  resolutions: ConflictResolution[];
  /** True if any conflict escalated to step 5 (unresolvable). */
  hasContradiction: boolean;
}

/**
 * @deprecated Historical accuracy tracking replaced by SL-based conflict resolution (Phase 4.8).
 * Kept for backward-compat; fields are no longer used in resolution logic.
 */
export interface OracleAccuracyRecord {
  /** Total verdicts issued by this oracle. */
  total: number;
  /** Verdicts later confirmed correct (e.g., by test results or human review). */
  correct: number;
}

export interface ResolverConfig {
  /** Oracle tiers from config — maps oracle name to tier string. */
  oracleTiers: Record<string, string>;
  /** Historical accuracy data — optional, for step 4. */
  oracleAccuracy?: Record<string, OracleAccuracyRecord>;
  /** Oracles that are informational-only (never block). */
  informationalOracles: Set<string>;
}

// ── Domain classification ───────────────────────────────────────

/** Oracle domain groups — same-domain conflicts need resolution, cross-domain don't. */
type OracleDomain = 'structural' | 'quality' | 'functional';

const ORACLE_DOMAINS: Record<string, OracleDomain> = {
  ast: 'structural',
  type: 'structural',
  dep: 'structural',
  lint: 'quality',
  test: 'functional',
};

function getOracleDomain(name: string): OracleDomain {
  return ORACLE_DOMAINS[name] ?? 'structural';
}

// ── Tier ranking ────────────────────────────────────────────────

/** Tier priority — higher number = higher trust. */
const TIER_PRIORITY: Record<string, number> = {
  deterministic: 4,
  heuristic: 3,
  probabilistic: 2,
  speculative: 1,
};

function getTierPriority(tier: string): number {
  return TIER_PRIORITY[tier] ?? 2;
}

// ── Resolver ────────────────────────────────────────────────────

/**
 * Resolve oracle conflicts using the 5-step deterministic tree.
 *
 * @param oracleResults - Map of oracle name → verdict (from gate pipeline)
 * @param config - Resolver configuration (tiers, accuracy, informational set)
 * @param abstentions - Abstaining oracles (excluded from resolution, surfaced for observability)
 * @returns Resolved gate result with decision, reasons, and resolution details
 */
export function resolveConflicts(
  oracleResults: Record<string, OracleVerdict>,
  config: ResolverConfig,
  abstentions?: Record<string, OracleAbstention>,
): ResolvedGateResult {
  // Abstaining oracles are NOT in oracleResults — they're passed separately.
  // They have no opinion to conflict with and are excluded from all resolution steps.
  // (See OracleAbstention in core/types.ts)
  const reasons: string[] = [];
  const resolutions: ConflictResolution[] = [];
  let hasContradiction = false;

  // Separate passed and failed oracles (excluding informational)
  const passed: string[] = [];
  const failed: string[] = [];

  for (const [name, verdict] of Object.entries(oracleResults)) {
    if (config.informationalOracles.has(name)) continue;
    if (verdict.verified) {
      passed.push(name);
    } else {
      failed.push(name);
    }
  }

  // No conflict — unanimous pass or unanimous fail
  if (passed.length === 0 || failed.length === 0) {
    for (const name of failed) {
      const verdict = oracleResults[name]!;
      reasons.push(`Oracle "${name}" rejected: ${verdict.reason ?? 'no reason given'}`);
    }
    return {
      decision: reasons.length > 0 ? 'block' : 'allow',
      reasons,
      resolutions: [],
      hasContradiction: false,
    };
  }

  // Conflict detected — resolve each failed oracle against each passed oracle
  const overridden = new Set<string>();

  for (const failName of failed) {
    let overriddenByAny = false;

    for (const passName of passed) {
      const resolution = resolveConflictPair(passName, failName, oracleResults, config);
      resolutions.push(resolution);

      if (resolution.resolvedAtStep < 5 && resolution.winner === passName) {
        // Passed oracle overrides the failed one
        overriddenByAny = true;
      }

      if (resolution.resolvedAtStep === 5) {
        hasContradiction = true;
      }
    }

    if (overriddenByAny) {
      overridden.add(failName);
    }
  }

  // Failed oracles not overridden still contribute block reasons
  for (const name of failed) {
    if (overridden.has(name)) continue;
    const verdict = oracleResults[name]!;
    reasons.push(`Oracle "${name}" rejected: ${verdict.reason ?? 'no reason given'}`);
  }

  // If all failures were overridden by higher-trust passes, allow
  // If any contradiction escalated (step 5), block conservatively
  if (hasContradiction) {
    reasons.push('Unresolved oracle contradiction — escalated to contradictory state');
  }

  return {
    decision: reasons.length > 0 ? 'block' : 'allow',
    reasons,
    resolutions,
    hasContradiction,
  };
}

/**
 * Convert an OracleVerdict to a SubjectiveOpinion oriented toward the proposition
 * "the code/hypothesis is correct."
 *
 * - verified=true:  confidence → belief   (oracle says "it's correct")
 * - verified=false: confidence → disbelief (oracle says "it's wrong")
 * If the verdict carries a native opinion, use it directly (assumed correctly oriented).
 */
function verdictToOpinion(verdict: OracleVerdict): SubjectiveOpinion {
  let opinion: SubjectiveOpinion;
  if (verdict.opinion && isValid(verdict.opinion)) {
    opinion = verdict.opinion;
  } else {
    opinion = verdict.verified
      ? fromScalar(verdict.confidence)
      : fromScalar(1 - verdict.confidence);
  }

  // Apply temporal decay if the verdict carries temporal context
  if (verdict.temporalContext && verdict.temporalContext.decayModel !== 'none') {
    const elapsed = Date.now() - verdict.temporalContext.validFrom;
    const halfLife = verdict.temporalContext.halfLife ?? (verdict.temporalContext.validUntil - verdict.temporalContext.validFrom) / 2;
    opinion = temporalDecay(opinion, elapsed, halfLife, verdict.temporalContext.decayModel);
  }

  return opinion;
}

/**
 * Resolve a single conflict between a passing and failing oracle.
 * Returns which oracle wins and at which step.
 */
function resolveConflictPair(
  passName: string,
  failName: string,
  oracleResults: Record<string, OracleVerdict>,
  config: ResolverConfig,
): ConflictResolution {
  const passVerdict = oracleResults[passName]!;
  const failVerdict = oracleResults[failName]!;

  // Step 1: Domain separation — cross-domain conflicts are not real conflicts
  const passDomain = getOracleDomain(passName);
  const failDomain = getOracleDomain(failName);

  if (passDomain !== failDomain) {
    // Cross-domain: the failing oracle's domain concern stands independently
    return {
      winner: failName,
      loser: passName,
      resolvedAtStep: 1,
      explanation: `Cross-domain: "${failName}" (${failDomain}) and "${passName}" (${passDomain}) assess different concerns — both valid`,
    };
  }

  // Step 2: Phase 4.8 — SL-based conflict resolution using Josang conflict constant K.
  // Cross-domain pair (Step 1) already returned above, so this is always same-domain.
  // Three zones: K > 0.7 → escalate, 0.3 ≤ K ≤ 0.7 → ambiguous (accuracy tiebreaker), K < 0.3 → fuse.
  const passOpinion = verdictToOpinion(passVerdict);
  const failOpinion = verdictToOpinion(failVerdict);
  const conflictReport = computeConflictReport(passOpinion, failOpinion);
  const K = conflictReport.K;

  if (K > 0.7) {
    // High conflict mass — oracles fundamentally disagree, escalate.
    return {
      winner: failName, // Conservative: failure wins when contradictory
      loser: passName,
      resolvedAtStep: 5,
      conflictK: K,
      explanation: `SL contradiction: K=${K.toFixed(3)} > 0.7 — "${passName}" (passed) and "${failName}" (failed) have irreconcilable opinions`,
    };
  }

  // Ambiguous zone (0.3 ≤ K ≤ 0.7) — use historical accuracy as tiebreaker if available
  if (K >= 0.3 && K <= 0.7 && config.oracleAccuracy) {
    const passAccuracy = config.oracleAccuracy[passName];
    const failAccuracy = config.oracleAccuracy[failName];
    if (passAccuracy && failAccuracy && passAccuracy.total >= 10 && failAccuracy.total >= 10) {
      const passRate = passAccuracy.correct / passAccuracy.total;
      const failRate = failAccuracy.correct / failAccuracy.total;
      if (Math.abs(passRate - failRate) > 0.1) {
        // Significant accuracy difference — trust the more accurate oracle
        const winner = passRate > failRate ? passName : failName;
        const loser = winner === passName ? failName : passName;
        return {
          winner,
          loser,
          resolvedAtStep: 4,
          conflictK: K,
          explanation: `Accuracy tiebreaker: "${winner}" (${(Math.max(passRate, failRate) * 100).toFixed(0)}%) vs "${loser}" (${(Math.min(passRate, failRate) * 100).toFixed(0)}%) in ambiguous K=${K.toFixed(3)} zone`,
        };
      }
    }
  }

  // K ≤ 0.7 without accuracy tiebreaker — fuse via cumulative fusion
  const fused = cumulativeFusion(passOpinion, failOpinion);
  const fusedP = projectedProbability(fused);
  // fusedP >= 0.5 → net opinion favors correctness → pass wins; else fail wins
  const winner = fusedP >= 0.5 ? passName : failName;
  const loser = winner === passName ? failName : passName;
  return {
    winner,
    loser,
    resolvedAtStep: 2,
    conflictK: K,
    fusedProbability: fusedP,
    explanation: `SL fusion: K=${K.toFixed(3)}, P(fused)=${fusedP.toFixed(3)} — "${winner}" wins (${fusedP >= 0.5 ? 'net belief favors correctness' : 'net belief favors failure'})`,
  };

  // Step 5: Escalation — reached via K > 0.7 path above (unreachable here, kept for clarity).
}
