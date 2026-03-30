/**
 * Risk Router — calculates risk scores and determines routing level.
 *
 * TDD §6: weighted sum with normalization + A6 guardrails.
 * Phase 0 computes and logs; Phase 1 Orchestrator uses for actual routing.
 */
import type { RiskFactors, RoutingDecision, RoutingLevel } from "../orchestrator/types.ts";

// ── Weights per TDD §6 ──────────────────────────────────────────

const WEIGHTS = {
  blastRadius: 0.25,
  dependencyDepth: 0.10,
  testCoverage: 0.15,
  fileVolatility: 0.10,
  irreversibility: 0.20,
  security: 0.10,
  production: 0.10,
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
export function detectEnvironment(): "development" | "staging" | "production" {
  const env = process.env.NODE_ENV ?? process.env.VINYAN_ENV ?? "";
  if (env === "production" || env === "prod") return "production";
  if (env === "staging" || env === "stage") return "staging";
  return "development";
}

// ── Core risk scoring ────────────────────────────────────────────

export function calculateRiskScore(factors: RiskFactors): number {
  const normBlast = Math.min(1.0, factors.blastRadius / NORM.blastRadius);
  const normDepth = Math.min(1.0, factors.dependencyDepth / NORM.dependencyDepth);
  const normVolatility = Math.min(1.0, factors.fileVolatility / NORM.fileVolatility);

  const base =
    normBlast * WEIGHTS.blastRadius +
    normDepth * WEIGHTS.dependencyDepth +
    (1 - factors.testCoverage) * WEIGHTS.testCoverage +
    normVolatility * WEIGHTS.fileVolatility +
    factors.irreversibility * WEIGHTS.irreversibility +
    (factors.hasSecurityImplication ? WEIGHTS.security : 0) +
    (factors.environmentType === "production" ? WEIGHTS.production : 0);

  // A6 Guardrail: production + high irreversibility → floor at 0.9
  if (factors.environmentType === "production" && factors.irreversibility > 0.5) {
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
): RoutingDecision {
  let level: RoutingLevel;

  if (riskScore <= thresholds.l0_max_risk) level = 0;
  else if (riskScore <= thresholds.l1_max_risk) level = 1;
  else if (riskScore <= thresholds.l2_max_risk) level = 2;
  else level = 3;

  // Hard floor: blast radius > 1 file → minimum L1
  if (blastRadius > 1 && level < 1) {
    level = 1;
  }

  // Map level to model + budget (latency budgets sized for remote LLM APIs)
  const LEVEL_CONFIG: Record<RoutingLevel, { model: string | null; budgetTokens: number; latencyBudget_ms: number }> = {
    0: { model: null, budgetTokens: 0, latencyBudget_ms: 100 },
    1: { model: "claude-haiku", budgetTokens: 10_000, latencyBudget_ms: 15_000 },
    2: { model: "claude-sonnet", budgetTokens: 50_000, latencyBudget_ms: 30_000 },
    3: { model: "claude-opus", budgetTokens: 100_000, latencyBudget_ms: 120_000 },
  };

  return {
    level,
    ...LEVEL_CONFIG[level],
  };
}
