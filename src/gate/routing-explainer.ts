/**
 * Routing Explainer — turns Vinyan's internal routing decision into a
 * user-visible, machine-readable explanation.
 *
 * Flagship differentiator #4: Observable Routing. Every risk-routing
 * decision is accompanied by a deterministic, rule-based projection of the
 * factors that produced it (A3 Deterministic Governance). Surface format
 * is stable across repeated calls with identical inputs — no LLM in the
 * explanation path.
 *
 * The produced `RoutingExplanation` is the same payload embedded in the
 * ECP-enriched trajectory row (see `src/trajectory/ecp-enriched.ts`) and
 * returned by the `routing-explain` API/CLI, so consumers share one shape.
 *
 * A2 surface: when any OracleVerdict reported `type: 'unknown'` we emit
 * `confidenceSource: 'unknown'` — we do not silently default to a tier.
 * A5 weakest-link: otherwise the weakest confidence tier represented by
 * the verdicts wins.
 */
import type { ConfidenceTier } from '../core/confidence-tier.ts';
import { weakerOf } from '../core/confidence-tier.ts';
import type { OracleVerdict } from '../core/types.ts';
import type { RiskFactors, RoutingDecision } from '../orchestrator/types.ts';

// ── Weights (cited from src/gate/risk-router.ts — keep in sync) ─────
// We replicate the constants here because risk-router does not export
// them. If/when risk-router promotes these to `export const WEIGHTS`,
// swap to an import — this block exists purely to avoid adding a public
// export surface to a file we are explicitly not allowed to modify.
const WEIGHTS = {
  blastRadius: 0.25,
  dependencyDepth: 0.1,
  testCoverage: 0.15,
  fileVolatility: 0.1,
  irreversibility: 0.2,
  security: 0.1,
  production: 0.1,
} as const;

const NORM = {
  blastRadius: 50,
  dependencyDepth: 10,
  fileVolatility: 30,
} as const;

// ── Public shapes ────────────────────────────────────────────────

export interface RoutingFactorContribution {
  readonly label: string;
  readonly rawValue: number | string;
  readonly weightedContribution: number;
}

export type RoutingVerdictStatus = 'verified' | 'falsified' | 'uncertain' | 'unknown' | 'contradictory';

export interface RoutingOracleSummary {
  readonly name: string;
  readonly verdict: RoutingVerdictStatus;
  readonly confidence: number;
}

export interface RoutingExplanation {
  readonly taskId: string;
  readonly level: 0 | 1 | 2 | 3;
  readonly summary: string;
  readonly factors: readonly RoutingFactorContribution[];
  readonly oraclesPlanned: readonly string[];
  readonly oraclesActual?: readonly RoutingOracleSummary[];
  readonly confidenceSource: ConfidenceTier | 'unknown';
  readonly escalationReason?: string;
  readonly deescalationReason?: string;
  readonly mappingLossWarnings?: readonly string[];
}

export interface ExplainRoutingInput {
  readonly taskId: string;
  readonly decision: RoutingDecision;
  readonly factors: RiskFactors;
  readonly verdicts?: readonly OracleVerdict[];
}

// ── Mapping: OracleVerdict.type → ECP status ─────────────────────
// OracleVerdict.type is restricted to
// 'known' | 'unknown' | 'uncertain' | 'contradictory'. We map:
//   - 'known' + verified=true  → 'verified'
//   - 'known' + verified=false → 'falsified'
//   - 'uncertain'              → 'uncertain'
//   - 'unknown'                → 'unknown'
//   - 'contradictory'          → 'contradictory'
export function mapVerdictStatus(v: OracleVerdict): RoutingVerdictStatus {
  switch (v.type) {
    case 'known':
      return v.verified ? 'verified' : 'falsified';
    case 'uncertain':
      return 'uncertain';
    case 'unknown':
      return 'unknown';
    case 'contradictory':
      return 'contradictory';
    default:
      return 'unknown';
  }
}

// ── Factor labelling ─────────────────────────────────────────────

const FACTOR_LABELS = {
  blastRadius: 'cross-module blast radius',
  dependencyDepth: 'dependency depth',
  testCoverage: 'missing test coverage',
  fileVolatility: 'file volatility',
  irreversibility: 'irreversible operation',
  security: 'security implication',
  production: 'production environment',
  tierReliability: 'low tier reliability',
} as const;

// ── Oracle planning by routing level (cited from risk-router level behavior) ──
// L0: none; L1: structural; L2: structural + tests; L3: all + shadow
function planOraclesForLevel(level: 0 | 1 | 2 | 3): string[] {
  switch (level) {
    case 0:
      return [];
    case 1:
      return ['AST', 'Type', 'Dep', 'Lint'];
    case 2:
      return ['AST', 'Type', 'Dep', 'Lint', 'Test'];
    case 3:
      return ['AST', 'Type', 'Dep', 'Lint', 'Test', 'Shadow'];
  }
}

// ── Confidence source derivation ─────────────────────────────────

const TIER_FROM_CONFIDENCE = (confidence: number): ConfidenceTier => {
  // Map numeric confidence to the 4-tier vocabulary (concept §2).
  // Boundaries picked to match TIER_CONFIDENCE_CEILING in core/confidence-tier.
  if (confidence >= 0.95) return 'deterministic';
  if (confidence >= 0.8) return 'heuristic';
  if (confidence >= 0.5) return 'probabilistic';
  return 'speculative';
};

function deriveConfidenceSource(verdicts: readonly OracleVerdict[] | undefined): ConfidenceTier | 'unknown' {
  if (!verdicts || verdicts.length === 0) {
    return 'unknown';
  }
  // A2: any 'unknown' verdict → surface 'unknown' explicitly.
  if (verdicts.some((v) => v.type === 'unknown')) {
    return 'unknown';
  }
  // A5: weakest tier represented wins.
  let weakest: ConfidenceTier | null = null;
  for (const v of verdicts) {
    const tier = TIER_FROM_CONFIDENCE(v.confidence);
    weakest = weakest === null ? tier : weakerOf(weakest, tier);
  }
  return weakest ?? 'unknown';
}

// ── Factor extraction ────────────────────────────────────────────

function buildFactorContributions(factors: RiskFactors): RoutingFactorContribution[] {
  const contributions: RoutingFactorContribution[] = [];

  const normBlast = Math.min(1.0, factors.blastRadius / NORM.blastRadius);
  if (normBlast > 0) {
    contributions.push({
      label: FACTOR_LABELS.blastRadius,
      rawValue: factors.blastRadius,
      weightedContribution: normBlast * WEIGHTS.blastRadius,
    });
  }

  const normDepth = Math.min(1.0, factors.dependencyDepth / NORM.dependencyDepth);
  if (normDepth > 0) {
    contributions.push({
      label: FACTOR_LABELS.dependencyDepth,
      rawValue: factors.dependencyDepth,
      weightedContribution: normDepth * WEIGHTS.dependencyDepth,
    });
  }

  // Test coverage is inverted — low coverage increases risk.
  const coverageGap = 1 - factors.testCoverage;
  if (coverageGap > 0) {
    contributions.push({
      label: FACTOR_LABELS.testCoverage,
      rawValue: factors.testCoverage,
      weightedContribution: coverageGap * WEIGHTS.testCoverage,
    });
  }

  const normVol = Math.min(1.0, factors.fileVolatility / NORM.fileVolatility);
  if (normVol > 0) {
    contributions.push({
      label: FACTOR_LABELS.fileVolatility,
      rawValue: factors.fileVolatility,
      weightedContribution: normVol * WEIGHTS.fileVolatility,
    });
  }

  if (factors.irreversibility > 0) {
    contributions.push({
      label: FACTOR_LABELS.irreversibility,
      rawValue: factors.irreversibility,
      weightedContribution: factors.irreversibility * WEIGHTS.irreversibility,
    });
  }

  if (factors.hasSecurityImplication) {
    contributions.push({
      label: FACTOR_LABELS.security,
      rawValue: 'true',
      weightedContribution: WEIGHTS.security,
    });
  }

  if (factors.environmentType === 'production') {
    contributions.push({
      label: FACTOR_LABELS.production,
      rawValue: factors.environmentType,
      weightedContribution: WEIGHTS.production,
    });
  }

  if (factors.avgTierReliability != null && factors.avgTierReliability < 0.5) {
    // Tier reliability adjustment from risk-router; low reliability penalizes.
    const adjustment = (0.7 - factors.avgTierReliability) * 0.15;
    if (adjustment > 0) {
      contributions.push({
        label: FACTOR_LABELS.tierReliability,
        rawValue: factors.avgTierReliability,
        weightedContribution: adjustment,
      });
    }
  }

  // Rank by weightedContribution descending for stable top-N surfacing.
  contributions.sort((a, b) => b.weightedContribution - a.weightedContribution);
  return contributions;
}

// ── Summary rendering ────────────────────────────────────────────

function renderSummary(
  level: 0 | 1 | 2 | 3,
  factors: readonly RoutingFactorContribution[],
  oraclesPlanned: readonly string[],
  confidenceSource: ConfidenceTier | 'unknown',
): string {
  const topFactors = factors.slice(0, 3);
  let reason: string;
  if (topFactors.length === 0) {
    reason = 'no significant risk factors detected';
  } else {
    const parts = topFactors.map((f) => {
      // Numeric factors get a fixed-point display, strings render as-is.
      const raw = typeof f.rawValue === 'number' ? f.rawValue.toFixed(2) : f.rawValue;
      return `${f.label} (${raw})`;
    });
    reason = parts.join(' + ');
  }

  const oracleList = oraclesPlanned.length > 0 ? oraclesPlanned.join(', ') : 'none';
  return `Task routed to L${level} because: ${reason}. Oracles planned: ${oracleList}. Confidence: ${confidenceSource}.`;
}

// ── Public entry point ───────────────────────────────────────────

export function explainRouting(input: ExplainRoutingInput): RoutingExplanation {
  const level = input.decision.level as 0 | 1 | 2 | 3;
  const factors = buildFactorContributions(input.factors);
  const oraclesPlanned = Array.from(
    new Set([...planOraclesForLevel(level), ...(input.decision.mandatoryOracles ?? [])]),
  );

  const confidenceSource = deriveConfidenceSource(input.verdicts);

  const oraclesActual: RoutingOracleSummary[] | undefined =
    input.verdicts && input.verdicts.length > 0
      ? input.verdicts.map((v) => ({
          name: v.oracleName ?? 'anonymous',
          verdict: mapVerdictStatus(v),
          confidence: v.confidence,
        }))
      : undefined;

  const summary = renderSummary(level, factors, oraclesPlanned, confidenceSource);

  const deescalationReason = input.decision.epistemicDeescalated
    ? 'high calibrated oracle confidence permitted level reduction'
    : undefined;
  const escalationReason = input.decision.isEscalated
    ? 'escalated from a lower routing level by verification failure'
    : undefined;

  // mappingLossWarnings: flag factors that couldn't be labeled cleanly.
  // Today every RiskFactors field has a label; kept for forward-compatibility
  // so ACP adapters that ingest RoutingExplanation can surface drift if a
  // future RiskFactors gains a field we haven't labelled here.
  const mappingLossWarnings: string[] = [];

  return {
    taskId: input.taskId,
    level,
    summary,
    factors,
    oraclesPlanned,
    ...(oraclesActual ? { oraclesActual } : {}),
    confidenceSource,
    ...(escalationReason ? { escalationReason } : {}),
    ...(deescalationReason ? { deescalationReason } : {}),
    ...(mappingLossWarnings.length > 0 ? { mappingLossWarnings } : {}),
  };
}
