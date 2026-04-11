/**
 * Historical Profiler — SelfModel + trace history integration (STU Layer 1).
 *
 * Deterministic, reads from TraceStore only. No LLM, A3-safe.
 * Detects recurring issues, ranks common failure oracles, computes historical metrics.
 */
import type { TraceStore } from '../../db/trace-store.ts';
import { computeTaskSignature } from '../prediction/self-model.ts';
import type { HistoricalProfile, TaskInput } from '../types.ts';

/** Threshold for recurring issue detection: same file + verb seen N+ times. */
const RECURRING_THRESHOLD = 3;

/** Maximum traces to query for profiling. */
const MAX_TRACE_QUERY = 50;

/** Top N failure oracles to report. */
const TOP_FAILURE_ORACLES = 3;

/**
 * Profile historical task performance for a given task input.
 * Queries trace store for prior observations with the same task type signature.
 */
export function profileHistory(input: TaskInput, traceStore: TraceStore): HistoricalProfile {
  const signature = computeTaskSignature(input);
  const traces = traceStore.findByTaskType(signature, MAX_TRACE_QUERY);

  // Recurring detection: same file + verb ≥ RECURRING_THRESHOLD times
  const targetFile = input.targetFiles?.[0];
  const sameFileTraces = targetFile ? traces.filter((t) => t.affectedFiles.includes(targetFile)) : [];
  const isRecurring = sameFileTraces.length >= RECURRING_THRESHOLD;

  // Common failure oracles — top 3 by frequency
  const failedTraces = traces.filter((t) => t.outcome === 'failure');
  const oracleFailCounts = new Map<string, number>();
  for (const t of failedTraces) {
    for (const [oracle, passed] of Object.entries(t.oracleVerdicts)) {
      if (!passed) {
        oracleFailCounts.set(oracle, (oracleFailCounts.get(oracle) ?? 0) + 1);
      }
    }
  }
  const commonFailureOracles = [...oracleFailCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_FAILURE_ORACLES)
    .map(([name]) => name);

  // Compute aggregate metrics
  const observationCount = traces.length;
  const failRate = observationCount > 0 ? failedTraces.length / observationCount : 0;

  const tracesWithDuration = traces.filter((t) => t.durationMs > 0 && t.affectedFiles.length > 0);
  const avgDurationPerFile =
    tracesWithDuration.length > 0
      ? tracesWithDuration.reduce((sum, t) => sum + t.durationMs / t.affectedFiles.length, 0) /
        tracesWithDuration.length
      : 0;

  // Infer basis from observation count
  let basis: HistoricalProfile['basis'];
  if (observationCount >= 30) {
    basis = 'trace-calibrated';
  } else if (observationCount >= 5) {
    basis = 'hybrid';
  } else {
    basis = 'static-heuristic';
  }

  return {
    signature,
    observationCount,
    failRate,
    commonFailureOracles,
    avgDurationPerFile,
    basis,
    isRecurring,
    priorAttemptCount: sameFileTraces.length,
  };
}
