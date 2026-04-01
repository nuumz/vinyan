/**
 * Decay Experiment — PH3.5 A/B test between exponential and power-law decay.
 *
 * Runs side-by-side for `evaluationThreshold` cycles, then locks in the winner
 * based on cumulative pattern survival quality (backtest pass rate under each model).
 *
 * Source of truth: design/implementation-plan.md §PH3.5
 */

// ── Types ──────────────────────────────────────────────────────────────

export type DecayFunction = "exponential" | "power-law";

export interface DecayExperimentState {
  currentWinner: DecayFunction;
  exponentialScore: number;
  powerLawScore: number;
  cyclesRun: number;
  evaluationThreshold: number;
  locked: boolean;
}

// ── Decay Computation ──────────────────────────────────────────────────

/**
 * Compute decay weight using the specified function.
 *
 * Exponential: 0.5 ^ (ageCycles / halfLife) — fast initial decay, slows over time
 * Power-law:   1 / (1 + ageCycles / halfLife) — slower decay, longer tail
 */
export function computeDecay(fn: DecayFunction, ageCycles: number, halfLife: number): number {
  if (ageCycles <= 0) return 1.0;
  if (halfLife <= 0) return 0;

  if (fn === "exponential") {
    return Math.pow(0.5, ageCycles / halfLife);
  }
  // power-law
  return 1 / (1 + ageCycles / halfLife);
}

// ── Experiment Lifecycle ───────────────────────────────────────────────

/** Create a fresh experiment state. */
export function createExperimentState(evaluationThreshold = 5): DecayExperimentState {
  return {
    currentWinner: "exponential",
    exponentialScore: 0,
    powerLawScore: 0,
    cyclesRun: 0,
    evaluationThreshold,
    locked: false,
  };
}

/**
 * Record one cycle's scores for both decay functions.
 * Score = average backtest pass rate of patterns surviving under that decay model.
 * Returns updated state (does not mutate input).
 */
export function recordCycleScore(
  state: DecayExperimentState,
  exponentialScore: number,
  powerLawScore: number,
): DecayExperimentState {
  if (state.locked) return state;

  const next: DecayExperimentState = {
    ...state,
    exponentialScore: state.exponentialScore + exponentialScore,
    powerLawScore: state.powerLawScore + powerLawScore,
    cyclesRun: state.cyclesRun + 1,
    locked: false,
  };

  // Evaluate after threshold cycles
  if (next.cyclesRun >= next.evaluationThreshold) {
    next.currentWinner = next.exponentialScore >= next.powerLawScore
      ? "exponential"
      : "power-law";
    next.locked = true;
  }

  return next;
}

/**
 * Get the current winning decay function.
 * Before evaluation completes, returns "exponential" (the incumbent).
 */
export function getActiveDecayFunction(state: DecayExperimentState): DecayFunction {
  return state.currentWinner;
}
