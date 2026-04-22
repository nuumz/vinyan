/**
 * Prediction-error rolling window — the A7 trigger substrate for SK4.
 *
 * Pure rule-based computation (no LLM, no IO): given a stream of
 * `PredictionErrorSample`s for one task signature, decide whether the
 * composite error has dropped meaningfully over the last `splitHalf` samples
 * compared to the prior `splitHalf`, AND whether the success rate's Wilson
 * lower bound meets threshold.
 *
 * A7 alignment: a success streak with flat error does NOT qualify. The
 * trigger only fires when there is *calibration-grade evidence* of improved
 * capability — i.e. the system got measurably better at predicting its own
 * outcomes for this signature.
 *
 * Wilson LB: delegated to `src/sleep-cycle/wilson.ts` (same formula used by
 * Sleep Cycle anti-pattern / success-pattern extraction, so determinism is
 * preserved across subsystems).
 */

// Wilson LB source of truth: mirrors `src/sleep-cycle/wilson.ts` so the
// autonomous creator uses the same significance test as Sleep Cycle.
import { wilsonLowerBound } from '../../sleep-cycle/wilson.ts';
import type { PredictionErrorSample, WindowPolicy, WindowState } from './types.ts';

export const DEFAULT_WINDOW_POLICY: WindowPolicy = {
  windowSize: 15,
  splitHalf: 10,
  minReductionDelta: 0.15,
  minSuccessFraction: 0.8,
  minWilsonLB: 0.6,
  cooldownMs: 10 * 60 * 1000, // 10 minutes
};

/**
 * Compute the window state for a task signature given its full observed
 * sample list. Caller is responsible for ordering; we defensively re-sort.
 *
 * Qualification rule (all four must hold):
 *   1. samples.length >= windowSize
 *   2. reductionDelta >= minReductionDelta
 *   3. successFraction >= minSuccessFraction
 *   4. wilsonLB >= minWilsonLB
 *
 * When there aren't yet enough samples for the split-half test we return a
 * stable degenerate state with `qualifies=false` so callers can render the
 * window in dashboards without branching on arity.
 */
export function buildWindowState(
  taskSignature: string,
  samples: readonly PredictionErrorSample[],
  policy: WindowPolicy = DEFAULT_WINDOW_POLICY,
): WindowState {
  // Sort ascending by timestamp; stable even if caller already ordered them.
  const ordered = [...samples].sort((a, b) => a.ts - b.ts);
  const n = ordered.length;

  // Degenerate case: no samples at all.
  if (n === 0) {
    return {
      taskSignature,
      samples: ordered,
      meanRecentError: 0,
      meanPriorError: 0,
      reductionDelta: 0,
      successFraction: 0,
      wilsonLB: 0,
      qualifies: false,
    };
  }

  // Success fraction is computed over the whole observed window (capped at
  // `windowSize` trailing samples so old noise doesn't leak into the gate).
  const tail = ordered.slice(-policy.windowSize);
  const successes = tail.filter((s) => s.outcome === 'success').length;
  const successFraction = successes / tail.length;
  const wilsonLB = wilsonLowerBound(successes, tail.length);

  // Split-half drop detection. Need 2 × splitHalf samples to compare halves.
  const needed = policy.splitHalf * 2;
  let meanRecentError = 0;
  let meanPriorError = 0;
  let reductionDelta = 0;
  if (ordered.length >= needed) {
    const recent = ordered.slice(-policy.splitHalf);
    const prior = ordered.slice(-needed, -policy.splitHalf);
    meanRecentError = mean(recent.map((s) => s.compositeError));
    meanPriorError = mean(prior.map((s) => s.compositeError));
    reductionDelta = meanPriorError - meanRecentError;
  }

  const qualifies =
    ordered.length >= policy.windowSize &&
    reductionDelta >= policy.minReductionDelta &&
    successFraction >= policy.minSuccessFraction &&
    wilsonLB >= policy.minWilsonLB;

  return {
    taskSignature,
    samples: ordered,
    meanRecentError,
    meanPriorError,
    reductionDelta,
    successFraction,
    wilsonLB,
    qualifies,
  };
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}
