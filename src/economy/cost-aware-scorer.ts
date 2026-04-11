/**
 * Cost-Aware Scorer — integrates cost efficiency into worker selection scoring.
 *
 * Extends the existing WorkerSelector formula:
 *   capability^2 × quality × costEfficiency^0.5 × staleness
 *
 * When economy is active, replaces the naive `1 - (avgTokenCost / budget)`
 * with predicted USD cost + budget pressure signals.
 *
 * A3 compliant: deterministic formula, no LLM.
 *
 * Source of truth: Economy OS plan §E2.2
 */

import type { BudgetStatus } from './budget-enforcer.ts';
import type { CostPrediction } from './cost-predictor.ts';

/**
 * Compute cost-aware efficiency score, replacing the naive costEfficiency.
 *
 * @param costPrediction — predicted cost for this task type
 * @param p95Budget — 95th percentile budget in USD for this task type (ceiling)
 * @param budgetStatuses — current global budget utilization
 * @returns score in [0.1, 1.0] — higher = more cost-efficient
 */
export function costAwareScore(
  costPrediction: CostPrediction | null,
  p95Budget: number,
  budgetStatuses: BudgetStatus[],
): number {
  // Fallback when no prediction available
  if (!costPrediction || p95Budget <= 0) {
    return 0.5; // neutral
  }

  // Base cost efficiency: how much of the budget ceiling this engine uses
  const ratio = Math.min(costPrediction.predicted_usd / p95Budget, 1.0);
  const costEfficiency = Math.max(0.1, Math.min(1.0, 1 - ratio));

  // Budget pressure: squeeze score when global budget is tight
  const maxUtilization = budgetStatuses.reduce((max, s) => Math.max(max, s.utilization_pct / 100), 0);
  const budgetPressure = Math.max(0.5, 1 - maxUtilization);

  // Combined: costEfficiency × budgetPressure, clamped
  return Math.max(0.1, Math.min(1.0, costEfficiency * budgetPressure));
}

/**
 * Compute the full worker score with cost awareness.
 * Same formula as WorkerSelector but with economy-enhanced cost term.
 */
export function costAwareWorkerScore(
  capability: number,
  quality: number,
  stalenessPenalty: number,
  costPrediction: CostPrediction | null,
  p95Budget: number,
  budgetStatuses: BudgetStatus[],
): number {
  const costScore = costAwareScore(costPrediction, p95Budget, budgetStatuses);
  return capability ** 2 * quality ** 1 * costScore ** 0.5 * stalenessPenalty;
}
