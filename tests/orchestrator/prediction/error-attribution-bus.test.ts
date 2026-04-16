/**
 * ErrorAttributionBus — behavior tests proving A7 learning loop closure.
 *
 * Each test proves a specific signal → correction path:
 * 1. selfmodel:systematic_miscalibration → onSelfModelReset called
 * 2. prediction:miscalibrated → onPredictionRecalibrate called
 * 3. hms:risk_scored (above threshold) → onHMSFailureInject called
 * 4. attributeError dispatches dominant error source correctly
 * 5. HMS risk below threshold is ignored
 */
import { describe, expect, it } from 'bun:test';
import { createBus } from '../../../src/core/bus.ts';
import { ErrorAttributionBus } from '../../../src/orchestrator/prediction/error-attribution-bus.ts';
import type { ExecutionTrace, PredictionError, SelfModelPrediction } from '../../../src/orchestrator/types.ts';

function makePrediction(): SelfModelPrediction {
  return {
    taskId: 'task-1',
    timestamp: Date.now(),
    expectedTestResults: 'pass',
    expectedBlastRadius: 3,
    expectedDuration: 5000,
    expectedQualityScore: 0.8,
    uncertainAreas: [],
    confidence: 0.7,
    metaConfidence: 0.3,
    basis: 'trace-calibrated',
    calibrationDataPoints: 20,
  };
}

function makeTrace(): ExecutionTrace {
  return {
    id: 'trace-1',
    taskId: 'task-1',
    timestamp: Date.now(),
    routingLevel: 2,
    approach: 'test-approach',
    oracleVerdicts: {},
    modelUsed: 'claude-sonnet',
    tokensConsumed: 1000,
    durationMs: 5000,
    outcome: 'failure',
    affectedFiles: ['src/a.ts'],
    taskTypeSignature: 'fix::ts::small',
  };
}

function makePredictionError(compositeOverride = 0.5): PredictionError {
  return {
    taskId: 'task-1',
    predicted: makePrediction(),
    actual: {
      testResults: 'fail',
      blastRadius: 5,
      duration: 10000,
      qualityScore: 0.4,
    },
    error: {
      testResultMatch: false,
      blastRadiusDelta: 2,
      durationDelta: 5000,
      qualityScoreDelta: -0.4,
      composite: compositeOverride,
    },
  };
}

describe('ErrorAttributionBus — bus event consumers', () => {
  it('selfmodel:systematic_miscalibration triggers onSelfModelReset', () => {
    const bus = createBus();
    const calls: string[] = [];
    const eab = new ErrorAttributionBus({
      bus,
      onSelfModelReset: (sig, level) => calls.push(`reset:${sig}:${level}`),
    });
    eab.start();

    bus.emit('selfmodel:systematic_miscalibration', {
      taskId: 'task-1',
      biasDirection: 'over',
      magnitude: 0.35,
      windowSize: 20,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('reset:');
    expect(eab.getCorrections()).toHaveLength(1);
    expect(eab.getCorrections()[0]!.correctionType).toBe('selfmodel-reset');
    eab.stop();
  });

  it('prediction:miscalibrated triggers onPredictionRecalibrate', () => {
    const bus = createBus();
    const calls: Array<{ taskId: string; brier: number }> = [];
    const eab = new ErrorAttributionBus({
      bus,
      onPredictionRecalibrate: (taskId, brier) => calls.push({ taskId, brier }),
    });
    eab.start();

    bus.emit('prediction:miscalibrated', { taskId: 'task-2', brierScore: 1.2, threshold: 1.0 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.brier).toBe(1.2);
    expect(eab.getCorrections()[0]!.correctionType).toBe('prediction-recalibrate');
    eab.stop();
  });

  it('hms:risk_scored above threshold triggers onHMSFailureInject', () => {
    const bus = createBus();
    const calls: string[] = [];
    const eab = new ErrorAttributionBus({
      bus,
      onHMSFailureInject: (taskId, risk, signal) => calls.push(`${taskId}:${risk}:${signal}`),
    });
    eab.start();

    bus.emit('hms:risk_scored', { taskId: 'task-3', risk: 0.85, primary_signal: 'grounding' });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('grounding');
    eab.stop();
  });

  it('hms:risk_scored below threshold is ignored', () => {
    const bus = createBus();
    const calls: string[] = [];
    const eab = new ErrorAttributionBus({
      bus,
      onHMSFailureInject: (taskId) => calls.push(taskId),
    });
    eab.start();

    bus.emit('hms:risk_scored', { taskId: 'task-4', risk: 0.3, primary_signal: 'overconfidence' });

    expect(calls).toHaveLength(0);
    eab.stop();
  });
});

describe('ErrorAttributionBus — attributeError', () => {
  it('dispatches to onSelfModelReset when quality delta dominates', () => {
    const bus = createBus();
    const calls: string[] = [];
    const eab = new ErrorAttributionBus({
      bus,
      onSelfModelReset: (sig) => calls.push(`reset:${sig}`),
    });

    const error = makePredictionError(0.5);
    error.error.qualityScoreDelta = -0.6;
    error.error.durationDelta = 0.1;
    error.error.blastRadiusDelta = 0.1;

    const result = eab.attributeError(error, makeTrace());
    expect(result).not.toBeNull();
    expect(result!.correctionType).toBe('selfmodel-reset');
    expect(result!.applied).toBe(true);
  });

  it('returns null when composite error is below threshold', () => {
    const bus = createBus();
    const eab = new ErrorAttributionBus({ bus });
    const result = eab.attributeError(makePredictionError(0.1), makeTrace());
    expect(result).toBeNull();
  });

  it('emits learning:error_attributed bus event', () => {
    const bus = createBus();
    const events: unknown[] = [];
    bus.on('learning:error_attributed', (p) => events.push(p));
    const eab = new ErrorAttributionBus({ bus, onSelfModelReset: () => {} });

    eab.attributeError(makePredictionError(0.5), makeTrace());
    expect(events).toHaveLength(1);
  });

  it('stop() unsubscribes from all bus events', () => {
    const bus = createBus();
    const calls: string[] = [];
    const eab = new ErrorAttributionBus({
      bus,
      onSelfModelReset: () => calls.push('called'),
    });
    eab.start();
    eab.stop();

    bus.emit('selfmodel:systematic_miscalibration', {
      taskId: 'task-5',
      biasDirection: 'under',
      magnitude: 0.4,
      windowSize: 20,
    });
    expect(calls).toHaveLength(0);
  });
});
