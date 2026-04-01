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

  // Step 2: Confidence comparison — higher tier wins (A5)
  const passTier = config.oracleTiers[passName] ?? 'heuristic';
  const failTier = config.oracleTiers[failName] ?? 'heuristic';
  const passPriority = getTierPriority(passTier);
  const failPriority = getTierPriority(failTier);

  if (passPriority !== failPriority) {
    const winner = passPriority > failPriority ? passName : failName;
    const loser = winner === passName ? failName : passName;
    return {
      winner,
      loser,
      resolvedAtStep: 2,
      explanation: `Tier comparison: "${winner}" (${winner === passName ? passTier : failTier}) outranks "${loser}" (${loser === passName ? passTier : failTier})`,
    };
  }

  // Step 3: Evidence weight — more evidence items wins
  const passEvidence = passVerdict.evidence.length;
  const failEvidence = failVerdict.evidence.length;

  if (passEvidence !== failEvidence) {
    const winner = passEvidence > failEvidence ? passName : failName;
    const loser = winner === passName ? failName : passName;
    const winnerEvidence = winner === passName ? passEvidence : failEvidence;
    const loserEvidence = loser === passName ? passEvidence : failEvidence;
    return {
      winner,
      loser,
      resolvedAtStep: 3,
      explanation: `Evidence weight: "${winner}" has ${winnerEvidence} evidence items vs "${loser}" with ${loserEvidence}`,
    };
  }

  // Step 4: Historical accuracy — better track record wins
  if (config.oracleAccuracy) {
    const passAcc = config.oracleAccuracy[passName];
    const failAcc = config.oracleAccuracy[failName];

    if (passAcc && failAcc && passAcc.total > 0 && failAcc.total > 0) {
      const passRate = passAcc.correct / passAcc.total;
      const failRate = failAcc.correct / failAcc.total;

      if (Math.abs(passRate - failRate) > 0.05) {
        const winner = passRate > failRate ? passName : failName;
        const loser = winner === passName ? failName : passName;
        const winnerRate = winner === passName ? passRate : failRate;
        const loserRate = loser === passName ? passRate : failRate;
        return {
          winner,
          loser,
          resolvedAtStep: 4,
          explanation: `Historical accuracy: "${winner}" (${(winnerRate * 100).toFixed(1)}%) vs "${loser}" (${(loserRate * 100).toFixed(1)}%)`,
        };
      }
    }
  }

  // Step 5: Escalation — unresolvable, produce contradictory state
  return {
    winner: failName, // Conservative: failure wins when unresolvable
    loser: passName,
    resolvedAtStep: 5,
    explanation: `Unresolved contradiction between "${passName}" (passed) and "${failName}" (failed) — same domain, same tier, same evidence weight, no accuracy differential`,
  };
}
