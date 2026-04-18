/**
 * Monitoring — Drift detector.
 *
 * Pure function over (SelfModel prediction, ExecutionTrace) that reports
 * whether the actual outcome diverges materially from what was predicted.
 * "Material" is operationalised as a relative delta exceeding a threshold
 * on any of the dimensions the SelfModel actually predicts: testResults,
 * blastRadius, duration, qualityScore, oracleConfidence.
 *
 * Stateless on purpose — drift detection is a per-trace decision, not an
 * accumulator. Callers (phase-learn, future regression-monitor) can
 * aggregate the per-trace verdicts however they like (rolling counter,
 * windowed mean, etc.) without having to coordinate state with this
 * module.
 *
 * Source of truth: docs/design/ecp-system-design.md §12 (drift
 * recovery algorithm — predicted vs actual outcome delta).
 */
import type { ExecutionTrace, SelfModelPrediction } from '../types.ts';

/**
 * Default per-dimension relative-delta threshold. The doc doesn't give a
 * specific number; the design report recommends 0.25 as a starting point
 * (loud enough to catch real drift, quiet enough to avoid alerting on
 * noise). Override per call if a test or a future router needs to tune.
 */
export const DEFAULT_DRIFT_RELATIVE_THRESHOLD = 0.25;

/**
 * Quality-score is already in [0,1] so a relative threshold of 25% is
 * brittle near zero. Use an absolute threshold of 0.2 (one-fifth of the
 * full range) — wide enough to catch a genuine collapse but narrow
 * enough to flag a meaningful regression.
 */
export const DEFAULT_DRIFT_QUALITY_ABSOLUTE_THRESHOLD = 0.2;

export interface DriftDimension {
  name: 'testResults' | 'blastRadius' | 'duration' | 'qualityScore';
  predicted: number | string;
  actual: number | string;
  /** Absolute delta. For testResults this is 0 (match) or 1 (mismatch). */
  absDelta: number;
  /** Relative delta — `|actual - predicted| / max(1, predicted)`. */
  relDelta: number;
  triggered: boolean;
}

export interface DriftReport {
  drift: boolean;
  dimensions: DriftDimension[];
  /** Highest per-dimension relative delta seen — useful for ordering. */
  maxRelDelta: number;
  /** Names of dimensions that crossed their threshold. */
  triggeredDimensions: string[];
}

export interface DriftThresholds {
  relative?: number;
  qualityAbsolute?: number;
}

/**
 * Detect drift between a SelfModel prediction and the trace that resulted
 * from running the task. Returns a structured report — never throws and
 * never mutates either input. `drift = true` iff at least one dimension
 * exceeded its threshold.
 */
export function detectDrift(
  prediction: SelfModelPrediction,
  trace: ExecutionTrace,
  thresholds: DriftThresholds = {},
): DriftReport {
  const relThreshold = thresholds.relative ?? DEFAULT_DRIFT_RELATIVE_THRESHOLD;
  const qualityAbsThreshold = thresholds.qualityAbsolute ?? DEFAULT_DRIFT_QUALITY_ABSOLUTE_THRESHOLD;

  // testResults — categorical: pass/fail/partial. Treat as binary match/no.
  const actualTestResult: 'pass' | 'fail' | 'partial' =
    trace.outcome === 'success' ? 'pass' : trace.outcome === 'failure' ? 'fail' : 'partial';
  const testResultMatch = prediction.expectedTestResults === actualTestResult;
  const testDim: DriftDimension = {
    name: 'testResults',
    predicted: prediction.expectedTestResults,
    actual: actualTestResult,
    absDelta: testResultMatch ? 0 : 1,
    relDelta: testResultMatch ? 0 : 1,
    triggered: !testResultMatch,
  };

  const blastDim = continuousDimension(
    'blastRadius',
    prediction.expectedBlastRadius,
    trace.affectedFiles.length,
    relThreshold,
  );
  const durationDim = continuousDimension(
    'duration',
    prediction.expectedDuration,
    trace.durationMs,
    relThreshold,
  );

  // qualityScore uses absolute threshold per the docstring rationale.
  const actualQuality =
    trace.qualityScore != null && !Number.isNaN(trace.qualityScore.composite)
      ? trace.qualityScore.composite
      : 0.5;
  const qualityAbsDelta = Math.abs(actualQuality - prediction.expectedQualityScore);
  const qualityDim: DriftDimension = {
    name: 'qualityScore',
    predicted: prediction.expectedQualityScore,
    actual: actualQuality,
    absDelta: qualityAbsDelta,
    relDelta: qualityAbsDelta / Math.max(1e-6, prediction.expectedQualityScore),
    triggered: qualityAbsDelta > qualityAbsThreshold,
  };

  const dimensions: DriftDimension[] = [testDim, blastDim, durationDim, qualityDim];
  const triggered = dimensions.filter((d) => d.triggered);
  const maxRelDelta = dimensions.reduce((acc, d) => Math.max(acc, d.relDelta), 0);

  return {
    drift: triggered.length > 0,
    dimensions,
    maxRelDelta,
    triggeredDimensions: triggered.map((d) => d.name),
  };
}

function continuousDimension(
  name: 'blastRadius' | 'duration',
  predicted: number,
  actual: number,
  relThreshold: number,
): DriftDimension {
  const absDelta = Math.abs(actual - predicted);
  const relDelta = absDelta / Math.max(1, predicted);
  return {
    name,
    predicted,
    actual,
    absDelta,
    relDelta,
    triggered: relDelta > relThreshold,
  };
}
