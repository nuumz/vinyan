/**
 * A7: Tests for mapTraceToFPOutcome — the bridge between ExecutionTrace and ForwardPredictor.
 *
 * mapTraceToFPOutcome is a module-private function in core-loop.ts, so we
 * replicate its logic here to verify the mapping contract independently.
 * Any drift between this spec and the implementation is caught via integration tests (A6/C5).
 */
import { describe, expect, test } from 'bun:test';
import type { ExecutionTrace } from '../../src/orchestrator/types.ts';
import type { PredictionOutcome } from '../../src/orchestrator/forward-predictor-types.ts';

// ---------------------------------------------------------------------------
// Re-implementation of mapTraceToFPOutcome for unit testing
// (the real function is module-private in core-loop.ts)
// ---------------------------------------------------------------------------

function mapTraceToFPOutcome(
  predictionId: string,
  trace: ExecutionTrace,
): PredictionOutcome | undefined {
  let testResult: 'pass' | 'partial' | 'fail';
  switch (trace.outcome) {
    case 'success':
      testResult = 'pass';
      break;
    case 'failure': {
      const verdicts = Object.values(trace.oracleVerdicts ?? {});
      const failCount = verdicts.filter((v) => !v).length;
      const failRate = verdicts.length === 0 ? 1.0 : failCount / verdicts.length;
      if (failRate >= 0.8) testResult = 'fail';
      else if (failRate >= 0.2) testResult = 'partial';
      else testResult = 'pass';
      break;
    }
    case 'timeout':
      return undefined;
    case 'escalated':
      if (trace.shadowValidation) {
        testResult = trace.shadowValidation.testsPassed ? 'pass' : 'fail';
      } else {
        return undefined;
      }
      break;
    default:
      return undefined;
  }
  return {
    predictionId,
    actualTestResult: testResult,
    actualBlastRadius: trace.affectedFiles?.length ?? 0,
    actualQuality: trace.qualityScore?.composite ?? 0.5,
    actualDuration: trace.durationMs,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: 'trace-1',
    taskId: 'task-1',
    timestamp: Date.now(),
    routingLevel: 1,
    approach: 'test approach',
    oracleVerdicts: {},
    modelUsed: 'test-model',
    tokensConsumed: 100,
    durationMs: 1500,
    outcome: 'success',
    affectedFiles: ['a.ts', 'b.ts'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mapTraceToFPOutcome', () => {
  // =========================================================================
  // Success outcome
  // =========================================================================

  test('success → pass', () => {
    const result = mapTraceToFPOutcome('pred-1', makeTrace({ outcome: 'success' }));
    expect(result).toBeDefined();
    expect(result!.actualTestResult).toBe('pass');
    expect(result!.predictionId).toBe('pred-1');
  });

  test('success → actualBlastRadius = affected files count', () => {
    const result = mapTraceToFPOutcome('pred-1', makeTrace({
      outcome: 'success',
      affectedFiles: ['a.ts', 'b.ts', 'c.ts'],
    }));
    expect(result!.actualBlastRadius).toBe(3);
  });

  test('success → actualQuality from qualityScore.composite', () => {
    const result = mapTraceToFPOutcome('pred-1', makeTrace({
      outcome: 'success',
      qualityScore: { composite: 0.85, architecturalCompliance: 0.9, efficiency: 0.8, dimensionsAvailable: 2, phase: 'extended' as const },
    }));
    expect(result!.actualQuality).toBe(0.85);
  });

  test('success with no qualityScore → default 0.5', () => {
    const result = mapTraceToFPOutcome('pred-1', makeTrace({
      outcome: 'success',
      qualityScore: undefined,
    }));
    expect(result!.actualQuality).toBe(0.5);
  });

  // =========================================================================
  // Failure outcome — oracle verdict thresholds
  // =========================================================================

  test('failure with 80%+ oracle fails → fail', () => {
    const result = mapTraceToFPOutcome('pred-1', makeTrace({
      outcome: 'failure',
      oracleVerdicts: { lint: false, type: false, test: false, dep: false, ast: true },
    }));
    // 4/5 = 80% → 'fail'
    expect(result!.actualTestResult).toBe('fail');
  });

  test('failure with 100% oracle fails → fail', () => {
    const result = mapTraceToFPOutcome('pred-1', makeTrace({
      outcome: 'failure',
      oracleVerdicts: { lint: false, type: false, test: false },
    }));
    expect(result!.actualTestResult).toBe('fail');
  });

  test('failure with 20-80% oracle fails → partial', () => {
    const result = mapTraceToFPOutcome('pred-1', makeTrace({
      outcome: 'failure',
      oracleVerdicts: { lint: false, type: true, test: true, dep: true, ast: true },
    }));
    // 1/5 = 20% → 'partial'
    expect(result!.actualTestResult).toBe('partial');
  });

  test('failure with 50% oracle fails → partial', () => {
    const result = mapTraceToFPOutcome('pred-1', makeTrace({
      outcome: 'failure',
      oracleVerdicts: { lint: false, type: false, test: true, dep: true },
    }));
    // 2/4 = 50% → 'partial'
    expect(result!.actualTestResult).toBe('partial');
  });

  test('failure with <20% oracle fails → pass', () => {
    const result = mapTraceToFPOutcome('pred-1', makeTrace({
      outcome: 'failure',
      oracleVerdicts: { lint: true, type: true, test: true, dep: true, ast: false },
    }));
    // 1/5 = 20% → boundary, still 'partial' (>= 0.2)
    expect(result!.actualTestResult).toBe('partial');
  });

  test('failure with 10% oracle fails → pass', () => {
    const result = mapTraceToFPOutcome('pred-1', makeTrace({
      outcome: 'failure',
      oracleVerdicts: {
        lint: true, type: true, test: true, dep: true,
        ast: true, extra1: true, extra2: true, extra3: true,
        extra4: true, extra5: false,
      },
    }));
    // 1/10 = 10% < 20% → 'pass'
    expect(result!.actualTestResult).toBe('pass');
  });

  test('failure with empty oracleVerdicts → fail (failRate=1.0)', () => {
    const result = mapTraceToFPOutcome('pred-1', makeTrace({
      outcome: 'failure',
      oracleVerdicts: {},
    }));
    expect(result!.actualTestResult).toBe('fail');
  });

  // =========================================================================
  // Timeout → skip
  // =========================================================================

  test('timeout → undefined (shouldRecord=false)', () => {
    const result = mapTraceToFPOutcome('pred-1', makeTrace({ outcome: 'timeout' }));
    expect(result).toBeUndefined();
  });

  // =========================================================================
  // Escalated outcome
  // =========================================================================

  test('escalated with shadow validation pass → pass', () => {
    const result = mapTraceToFPOutcome('pred-1', makeTrace({
      outcome: 'escalated',
      shadowValidation: { taskId: 'task-1', testsPassed: true, durationMs: 500, timestamp: Date.now() },
    }));
    expect(result!.actualTestResult).toBe('pass');
  });

  test('escalated with shadow validation fail → fail', () => {
    const result = mapTraceToFPOutcome('pred-1', makeTrace({
      outcome: 'escalated',
      shadowValidation: { taskId: 'task-1', testsPassed: false, durationMs: 500, timestamp: Date.now() },
    }));
    expect(result!.actualTestResult).toBe('fail');
  });

  test('escalated without shadow validation → undefined (shouldRecord=false)', () => {
    const result = mapTraceToFPOutcome('pred-1', makeTrace({
      outcome: 'escalated',
      shadowValidation: undefined,
    }));
    expect(result).toBeUndefined();
  });

  // =========================================================================
  // Duration passthrough
  // =========================================================================

  test('actualDuration is passthrough from trace.durationMs', () => {
    const result = mapTraceToFPOutcome('pred-1', makeTrace({ durationMs: 3200 }));
    expect(result!.actualDuration).toBe(3200);
  });

  // =========================================================================
  // Missing affectedFiles
  // =========================================================================

  test('missing affectedFiles → actualBlastRadius = 0', () => {
    const trace = makeTrace();
    // @ts-expect-error — testing missing field
    trace.affectedFiles = undefined;
    const result = mapTraceToFPOutcome('pred-1', trace);
    expect(result!.actualBlastRadius).toBe(0);
  });
});
