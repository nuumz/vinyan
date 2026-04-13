import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_DRIFT_QUALITY_ABSOLUTE_THRESHOLD,
  DEFAULT_DRIFT_RELATIVE_THRESHOLD,
  detectDrift,
} from '../../../src/orchestrator/phase7/drift-detector.ts';
import type { ExecutionTrace, SelfModelPrediction } from '../../../src/orchestrator/types.ts';

function makePrediction(overrides: Partial<SelfModelPrediction> = {}): SelfModelPrediction {
  return {
    taskId: 't1',
    timestamp: Date.now(),
    expectedTestResults: 'pass',
    expectedBlastRadius: 4,
    expectedDuration: 10_000,
    expectedQualityScore: 0.7,
    uncertainAreas: [],
    confidence: 0.7,
    metaConfidence: 0.5,
    basis: 'hybrid',
    calibrationDataPoints: 50,
    ...overrides,
  };
}

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: 'trace-t1',
    taskId: 't1',
    timestamp: Date.now(),
    routingLevel: 2,
    approach: 'direct-edit',
    oracleVerdicts: { ast: true, type: true },
    modelUsed: 'mock/sonnet',
    tokensConsumed: 1000,
    durationMs: 10_000,
    outcome: 'success',
    affectedFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
    qualityScore: {
      architecturalCompliance: 0.7,
      efficiency: 0.7,
      composite: 0.7,
      dimensionsAvailable: 2,
      phase: 'phase0',
    },
    ...overrides,
  };
}

describe('detectDrift', () => {
  test('matched prediction → no drift', () => {
    const r = detectDrift(makePrediction(), makeTrace());
    expect(r.drift).toBe(false);
    expect(r.triggeredDimensions).toEqual([]);
    expect(r.maxRelDelta).toBeCloseTo(0, 5);
  });

  test('blastRadius doubled triggers drift', () => {
    const r = detectDrift(
      makePrediction({ expectedBlastRadius: 4 }),
      makeTrace({ affectedFiles: Array.from({ length: 10 }, (_, i) => `f${i}.ts`) }),
    );
    expect(r.drift).toBe(true);
    expect(r.triggeredDimensions).toContain('blastRadius');
  });

  test('duration 50% over predicted triggers drift', () => {
    const r = detectDrift(
      makePrediction({ expectedDuration: 10_000 }),
      makeTrace({ durationMs: 16_000 }), // 60% over
    );
    expect(r.drift).toBe(true);
    expect(r.triggeredDimensions).toContain('duration');
  });

  test('qualityScore drop > absolute threshold triggers drift even when relative would not', () => {
    // Prediction was 0.9, actual 0.65 — relative delta is only ~28% but
    // absolute is 0.25, comfortably above the 0.2 absolute threshold.
    const r = detectDrift(
      makePrediction({ expectedQualityScore: 0.9 }),
      makeTrace({
        qualityScore: {
          architecturalCompliance: 0.65,
          efficiency: 0.65,
          composite: 0.65,
          dimensionsAvailable: 2,
          phase: 'phase0',
        },
      }),
    );
    expect(r.drift).toBe(true);
    expect(r.triggeredDimensions).toContain('qualityScore');
  });

  test('failed task with predicted=pass triggers testResults dimension', () => {
    const r = detectDrift(makePrediction(), makeTrace({ outcome: 'failure' }));
    expect(r.drift).toBe(true);
    expect(r.triggeredDimensions).toContain('testResults');
  });

  test('thresholds can be overridden per call', () => {
    // Same situation as the duration test, but tighten the relative
    // threshold to 0.05 — every dimension should now trigger.
    const r = detectDrift(makePrediction(), makeTrace({ durationMs: 11_000 }), { relative: 0.05 });
    expect(r.triggeredDimensions).toContain('duration');
  });

  test('NaN composite quality is treated as 0.5 (matches phase-learn fallback)', () => {
    const r = detectDrift(
      makePrediction({ expectedQualityScore: 0.5 }),
      makeTrace({
        qualityScore: {
          architecturalCompliance: 0.5,
          efficiency: 0.5,
          composite: NaN,
          dimensionsAvailable: 2,
          phase: 'phase0',
        },
      }),
    );
    expect(r.drift).toBe(false);
  });

  test('default thresholds match documented constants', () => {
    expect(DEFAULT_DRIFT_RELATIVE_THRESHOLD).toBe(0.25);
    expect(DEFAULT_DRIFT_QUALITY_ABSOLUTE_THRESHOLD).toBe(0.2);
  });
});
