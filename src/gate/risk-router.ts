/**
 * Risk Router — calculates risk scores and determines routing level.
 *
 * TDD §6: weighted sum with normalization + A6 guardrails.
 * Phase 0 computes and logs; Phase 1 Orchestrator uses for actual routing.
 */
import type { EpistemicAdjustment, RiskFactors, RoutingDecision, RoutingLevel, ThinkingConfig } from '../orchestrator/types.ts';
import type { OutcomePrediction } from '../orchestrator/forward-predictor-types.ts';

// ── Weights per TDD §6 ──────────────────────────────────────────

const WEIGHTS = {
  blastRadius: 0.25,
  dependencyDepth: 0.1,
  testCoverage: 0.15,
  fileVolatility: 0.1,
  irreversibility: 0.2,
  security: 0.1,
  production: 0.1,
} as const;

// ── Normalization bounds ─────────────────────────────────────────

const NORM = {
  blastRadius: 50,
  dependencyDepth: 10,
  fileVolatility: 30,
} as const;

// ── Irreversibility scoring table (TDD §6) ──────────────────────

const IRREVERSIBILITY_TABLE: Record<string, number> = {
  // File mutations
  write_file: 0.0,
  create_file: 0.0,
  replace_in_file: 0.0,
  insert_in_file: 0.0,
  apply_diff: 0.0,
  // Riskier operations
  delete_file: 0.3,
  rename_file: 0.3,
  // Config changes
  config_change: 0.3,
  // External effects
  api_call: 0.7,
  db_schema: 0.8,
  deployment: 0.9,
  db_data_delete: 0.95,
  // Shell
  run_terminal_command: 0.5,
};

/** Get irreversibility score for a tool name. Unknown → 0.5 (conservative). */
export function getIrreversibilityScore(toolName: string): number {
  return IRREVERSIBILITY_TABLE[toolName] ?? 0.5;
}

/** Detect execution environment from NODE_ENV or CI markers. */
export function detectEnvironment(): 'development' | 'staging' | 'production' {
  const env = process.env.NODE_ENV ?? process.env.VINYAN_ENV ?? '';
  if (env === 'production' || env === 'prod') return 'production';
  if (env === 'staging' || env === 'stg') return 'staging';
  return 'development';
}

/**
 * Sealed environment — read once at module init, immutable for the process lifetime.
 * Prevents runtime manipulation of NODE_ENV from downgrading production guardrails.
 */
export const SEALED_ENVIRONMENT = detectEnvironment();

// ── Core risk scoring ────────────────────────────────────────────

export function calculateRiskScore(factors: RiskFactors): number {
  const normBlast = Math.min(1.0, factors.blastRadius / NORM.blastRadius);
  const normDepth = Math.min(1.0, factors.dependencyDepth / NORM.dependencyDepth);
  const normVolatility = Math.min(1.0, factors.fileVolatility / NORM.fileVolatility);

  let base =
    normBlast * WEIGHTS.blastRadius +
    normDepth * WEIGHTS.dependencyDepth +
    (1 - factors.testCoverage) * WEIGHTS.testCoverage +
    normVolatility * WEIGHTS.fileVolatility +
    factors.irreversibility * WEIGHTS.irreversibility +
    (factors.hasSecurityImplication ? WEIGHTS.security : 0) +
    (factors.environmentType === 'production' ? WEIGHTS.production : 0);

  // Tier reliability adjustment: high reliability reduces risk, low increases it
  // Neutral point at 0.7 (heuristic tier boundary)
  // Range: -0.045 (deterministic, 1.0) to +0.06 (low probabilistic, 0.3)
  if (factors.avgTierReliability != null) {
    const adjustment = (0.7 - factors.avgTierReliability) * 0.15;
    base = Math.max(0, base + adjustment);
  }

  // A6 Guardrail: production + high irreversibility → floor at 0.9
  if (factors.environmentType === 'production' && factors.irreversibility > 0.5) {
    return Math.max(0.9, Math.min(1.0, base));
  }

  return Math.min(1.0, base);
}

// ── Routing ──────────────────────────────────────────────────────

export interface RoutingThresholds {
  l0_max_risk: number; // default 0.2
  l1_max_risk: number; // default 0.4
  l2_max_risk: number; // default 0.7
}

const DEFAULT_THRESHOLDS: RoutingThresholds = {
  l0_max_risk: 0.2,
  l1_max_risk: 0.4,
  l2_max_risk: 0.7,
};

export function routeByRisk(
  riskScore: number,
  blastRadius: number,
  thresholds: RoutingThresholds = DEFAULT_THRESHOLDS,
  environmentType?: string,
  epistemicAdjustment?: EpistemicAdjustment,
): RoutingDecision {
  let level: RoutingLevel;

  if (riskScore <= thresholds.l0_max_risk) level = 0;
  else if (riskScore <= thresholds.l1_max_risk) level = 1;
  else if (riskScore <= thresholds.l2_max_risk) level = 2;
  else level = 3;

  // Epistemic de-escalation: if oracle confidence is calibrated and high, allow -1 level
  // G4: tier_reliability guard — low reliability (<0.5) prevents de-escalation
  let epistemicDeescalated = false;
  if (
    epistemicAdjustment &&
    epistemicAdjustment.basis === 'calibrated' &&
    epistemicAdjustment.avgOracleConfidence >= 0.85 &&
    (epistemicAdjustment.avgTierReliability === undefined || epistemicAdjustment.avgTierReliability >= 0.5) &&
    level > 0
  ) {
    level = (level - 1) as RoutingLevel;
    epistemicDeescalated = true;
  }

  // Hard floor: blast radius > 1 file → minimum L1
  if (blastRadius > 1 && level < 1) {
    level = 1;
    if (epistemicDeescalated) epistemicDeescalated = false; // floor overrode de-escalation
  }

  // Production boundary: minimum L2 (TDD §7)
  if (environmentType === 'production' && level < 2) {
    level = 2;
    if (epistemicDeescalated) epistemicDeescalated = false; // floor overrode de-escalation
  }

  return {
    level,
    ...LEVEL_CONFIG[level],
    ...(epistemicDeescalated ? { epistemicDeescalated } : {}),
  };
}

/** R3: Canonical model/budget config for a routing level. Exported for adjustment layers. */
export const LEVEL_CONFIG: Record<RoutingLevel, { model: string | null; budgetTokens: number; latencyBudgetMs: number; thinkingConfig: ThinkingConfig }> = {
  0: { model: null, budgetTokens: 0, latencyBudgetMs: 100, thinkingConfig: { type: 'disabled' } },
  1: { model: 'claude-haiku', budgetTokens: 10_000, latencyBudgetMs: 15_000, thinkingConfig: { type: 'disabled' } },
  2: { model: 'claude-sonnet', budgetTokens: 50_000, latencyBudgetMs: 90_000, thinkingConfig: { type: 'adaptive', effort: 'medium', display: 'omitted' } },
  3: { model: 'claude-opus', budgetTokens: 100_000, latencyBudgetMs: 120_000, thinkingConfig: { type: 'adaptive', effort: 'high', display: 'summarized' } },
};

/**
 * Re-target a routing decision at a different level, refreshing the budget /
 * model fields from `LEVEL_CONFIG[targetLevel]`. Use this whenever a code
 * path moves a routing decision to a new level — `{ ...routing, level: X }`
 * alone keeps the previous level's `latencyBudgetMs` and `budgetTokens`,
 * which silently caps the agent's wall-clock and token budget at the lower
 * level's value (see L1→L2: agent inherited 15s instead of 90s, timing out
 * before the first turn ever returned).
 */
export function withLevel(routing: RoutingDecision, targetLevel: RoutingLevel): RoutingDecision {
  if (routing.level === targetLevel) return routing;
  const cfg = LEVEL_CONFIG[targetLevel];
  return {
    ...routing,
    level: targetLevel,
    model: cfg.model,
    budgetTokens: cfg.budgetTokens,
    latencyBudgetMs: cfg.latencyBudgetMs,
  };
}

// ── Prediction-based escalation ──────────────────────────────────

/**
 * Apply ForwardPredictor causal risk to escalate routing level.
 * Pure function — does not modify the original routing decision.
 * Returns a new RoutingDecision with potentially escalated level.
 */
export function applyPredictionEscalation(
  routing: RoutingDecision,
  forwardPrediction: OutcomePrediction,
): RoutingDecision {
  let level = routing.level;

  // If top causal risk file has >50% break probability → minimum L2
  const topRisk = forwardPrediction.causalRiskFiles[0];
  if (topRisk && topRisk.breakProbability > 0.5 && level < 2) {
    level = 2 as RoutingLevel;
  }

  // If aggregate risk across all causal files > 0.7 → escalate to L3
  if (forwardPrediction.causalRiskFiles.length > 0) {
    const aggregateRisk = 1 - forwardPrediction.causalRiskFiles.reduce(
      (product, r) => product * (1 - r.breakProbability), 1,
    );
    if (aggregateRisk > 0.7 && level < 3) {
      level = 3 as RoutingLevel;
    }
  }

  if (level === routing.level) return routing;
  return withLevel(routing, level);
}
