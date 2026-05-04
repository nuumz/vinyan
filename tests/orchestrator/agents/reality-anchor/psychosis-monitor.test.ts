/**
 * Tests for `PsychosisMonitor` — Phase C3 reality-anchor.
 *
 * Behavior-only: every assertion drives the monitor with synthetic
 * traces and verifies the documented contract on `psychosis:trigger`
 * emissions.
 *
 * Coverage:
 *   - traces without agentId are skipped
 *   - warmup gate: no trigger before minObservations
 *   - delusion signal: rolling mean above ceiling fires once + window size
 *   - prediction_error signal: composite error mean above ceiling fires
 *   - contradiction signal: failed-oracle ratio mean above ceiling fires
 *   - cooldown: subsequent breaches in cooldown are silenced
 *   - cooldown expiry: trigger re-arms after cooldown traces
 *   - per-persona isolation: persona A breach doesn't cool down persona B
 *   - fallback ceilings: tests can override defaults without ParameterStore
 *   - "one trigger per trace": only one signal fires when multiple breach
 */
import { describe, expect, test } from 'bun:test';
import { createBus, type VinyanBus } from '../../../../src/core/bus.ts';
import { PsychosisMonitor } from '../../../../src/orchestrator/agents/reality-anchor/psychosis-monitor.ts';
import type { ExecutionTrace, PredictionError } from '../../../../src/orchestrator/types.ts';

interface CapturedTrigger {
  personaId: string;
  signal: 'prediction_error' | 'contradiction' | 'goal_drift' | 'delusion';
  value: number;
  ceiling: number;
  windowSize: number;
}

function capturedTriggers(bus: VinyanBus): { events: CapturedTrigger[]; unsub: () => void } {
  const events: CapturedTrigger[] = [];
  const unsub = bus.on('psychosis:trigger', (e) => {
    events.push(e as CapturedTrigger);
  });
  return { events, unsub };
}

function predictionError(composite: number): PredictionError {
  return {
    taskId: 't',
    predicted: {
      taskId: 't',
      timestamp: 0,
      expectedTestResults: 'pass',
      expectedBlastRadius: 0,
      expectedDuration: 0,
      expectedQualityScore: 0,
      uncertainAreas: [],
      confidence: 0.5,
      metaConfidence: 0.5,
      basis: 'static-heuristic',
      calibrationDataPoints: 0,
    },
    actual: { testResults: 'pass', blastRadius: 0, duration: 0, qualityScore: 0 },
    error: {
      testResultMatch: true,
      blastRadiusDelta: 0,
      durationDelta: 0,
      qualityScoreDelta: 0,
      composite,
    },
  };
}

function trace(overrides: Omit<Partial<ExecutionTrace>, 'agentId'> & { agentId?: string }): ExecutionTrace {
  return {
    id: `t-${Math.random().toString(36).slice(2, 8)}`,
    taskId: 'task',
    timestamp: Date.now(),
    routingLevel: 1,
    approach: 'a',
    oracleVerdicts: { ast: true },
    modelUsed: 'mock',
    tokensConsumed: 0,
    durationMs: 0,
    outcome: 'success',
    affectedFiles: [],
    ...overrides,
  } as ExecutionTrace;
}

function makeBus(): VinyanBus {
  // Each test gets a fresh bus; listeners are GC'd with the bus reference.
  return createBus();
}

describe('PsychosisMonitor — gates', () => {
  test('trace without agentId is silently skipped', () => {
    const bus = makeBus();
    const { events } = capturedTriggers(bus);
    const monitor = new PsychosisMonitor({ bus, minObservations: 1 });
    monitor.onTraceRecord(trace({ delusionResult: { kind: 'delusion', falsifiedCount: 5, delusionRate: 0.9 } }));
    expect(events).toHaveLength(0);
    // and nothing buffered
    expect(monitor.windowSizeFor('researcher')).toBe(0);
  });

  test('warmup: no trigger before minObservations even if signal breached', () => {
    const bus = makeBus();
    const { events } = capturedTriggers(bus);
    const monitor = new PsychosisMonitor({ bus, minObservations: 5 });
    for (let i = 0; i < 4; i++) {
      monitor.onTraceRecord(
        trace({
          agentId: 'researcher',
          delusionResult: { kind: 'delusion', falsifiedCount: 1, delusionRate: 1.0 },
        }),
      );
    }
    expect(events).toHaveLength(0);
    expect(monitor.windowSizeFor('researcher')).toBe(4);
  });
});

describe('PsychosisMonitor — signal triggers', () => {
  test('delusion: 10 traces with high delusionRate fires trigger once', () => {
    const bus = makeBus();
    const { events } = capturedTriggers(bus);
    const monitor = new PsychosisMonitor({
      bus,
      minObservations: 10,
      windowSize: 20,
      cooldownTraces: 20,
      fallbackCeilings: { delusion: 0.15 },
    });
    for (let i = 0; i < 10; i++) {
      monitor.onTraceRecord(
        trace({
          agentId: 'researcher',
          delusionResult: { kind: 'delusion', falsifiedCount: 1, delusionRate: 0.5 },
        }),
      );
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.signal).toBe('delusion');
    expect(events[0]?.personaId).toBe('researcher');
    expect(events[0]?.value).toBeCloseTo(0.5, 5);
    expect(events[0]?.ceiling).toBe(0.15);
    expect(events[0]?.windowSize).toBe(10);
  });

  test('prediction_error: composite mean over ceiling fires', () => {
    const bus = makeBus();
    const { events } = capturedTriggers(bus);
    const monitor = new PsychosisMonitor({
      bus,
      minObservations: 5,
      fallbackCeilings: { prediction_error: 0.4, delusion: 1.0, contradiction: 1.0 },
    });
    for (let i = 0; i < 5; i++) {
      monitor.onTraceRecord(trace({ agentId: 'p', predictionError: predictionError(0.6) }));
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.signal).toBe('prediction_error');
    expect(events[0]?.value).toBeCloseTo(0.6, 5);
  });

  test('contradiction: failed-oracle ratio mean over ceiling fires', () => {
    const bus = makeBus();
    const { events } = capturedTriggers(bus);
    const monitor = new PsychosisMonitor({
      bus,
      minObservations: 5,
      fallbackCeilings: { contradiction: 0.2, delusion: 1.0, prediction_error: 1.0 },
    });
    for (let i = 0; i < 5; i++) {
      monitor.onTraceRecord(trace({ agentId: 'p', oracleVerdicts: { a: false, b: false, c: true } }));
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.signal).toBe('contradiction');
    expect(events[0]?.value).toBeCloseTo(2 / 3, 5);
  });

  test('signal at or below ceiling does NOT fire (strict greater-than)', () => {
    const bus = makeBus();
    const { events } = capturedTriggers(bus);
    const monitor = new PsychosisMonitor({
      bus,
      minObservations: 5,
      fallbackCeilings: { delusion: 0.5 },
    });
    for (let i = 0; i < 5; i++) {
      monitor.onTraceRecord(
        trace({
          agentId: 'p',
          delusionResult: { kind: 'delusion', falsifiedCount: 1, delusionRate: 0.5 }, // == ceiling
        }),
      );
    }
    expect(events).toHaveLength(0);
  });
});

describe('PsychosisMonitor — cooldown', () => {
  test('cooldown silences subsequent triggers', () => {
    const bus = makeBus();
    const { events } = capturedTriggers(bus);
    const monitor = new PsychosisMonitor({
      bus,
      minObservations: 3,
      cooldownTraces: 5,
      fallbackCeilings: { delusion: 0.15 },
    });
    // 3 high-rate traces → trigger fires
    for (let i = 0; i < 3; i++) {
      monitor.onTraceRecord(
        trace({
          agentId: 'p',
          delusionResult: { kind: 'delusion', falsifiedCount: 1, delusionRate: 0.5 },
        }),
      );
    }
    expect(events).toHaveLength(1);
    // Next 5 traces in cooldown — no further triggers even though signals stay breached
    for (let i = 0; i < 5; i++) {
      monitor.onTraceRecord(
        trace({
          agentId: 'p',
          delusionResult: { kind: 'delusion', falsifiedCount: 1, delusionRate: 0.5 },
        }),
      );
    }
    expect(events).toHaveLength(1);
  });

  test('cooldown re-arms after N traces', () => {
    const bus = makeBus();
    const { events } = capturedTriggers(bus);
    const monitor = new PsychosisMonitor({
      bus,
      minObservations: 3,
      cooldownTraces: 3,
      fallbackCeilings: { delusion: 0.15 },
    });
    const breach = trace({
      agentId: 'p',
      delusionResult: { kind: 'delusion', falsifiedCount: 1, delusionRate: 0.5 },
    });
    // First trigger
    for (let i = 0; i < 3; i++) monitor.onTraceRecord(breach);
    expect(events).toHaveLength(1);
    // Burn through cooldown
    for (let i = 0; i < 3; i++) monitor.onTraceRecord(breach);
    expect(events).toHaveLength(1);
    // One more trace — cooldown expired, second trigger fires
    monitor.onTraceRecord(breach);
    expect(events).toHaveLength(2);
  });
});

describe('PsychosisMonitor — per-persona isolation', () => {
  test('persona A trigger does not cool down persona B', () => {
    const bus = makeBus();
    const { events } = capturedTriggers(bus);
    const monitor = new PsychosisMonitor({
      bus,
      minObservations: 3,
      cooldownTraces: 100,
      fallbackCeilings: { delusion: 0.15 },
    });
    const breachA = trace({
      agentId: 'A',
      delusionResult: { kind: 'delusion', falsifiedCount: 1, delusionRate: 0.5 },
    });
    const breachB = trace({
      agentId: 'B',
      delusionResult: { kind: 'delusion', falsifiedCount: 1, delusionRate: 0.5 },
    });
    for (let i = 0; i < 3; i++) monitor.onTraceRecord(breachA);
    for (let i = 0; i < 3; i++) monitor.onTraceRecord(breachB);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.personaId).sort()).toEqual(['A', 'B']);
  });
});

describe('PsychosisMonitor — multi-signal at trace', () => {
  test('only ONE trigger fires per trace even when multiple signals breach', () => {
    const bus = makeBus();
    const { events } = capturedTriggers(bus);
    const monitor = new PsychosisMonitor({
      bus,
      minObservations: 3,
      cooldownTraces: 100,
      fallbackCeilings: { prediction_error: 0.4, contradiction: 0.2, delusion: 0.15 },
    });
    // Construct a trace that breaches all three signals at once.
    const t = trace({
      agentId: 'p',
      predictionError: predictionError(0.9),
      oracleVerdicts: { a: false, b: false },
      delusionResult: { kind: 'delusion', falsifiedCount: 1, delusionRate: 0.9 },
    });
    for (let i = 0; i < 3; i++) monitor.onTraceRecord(t);
    expect(events).toHaveLength(1);
    // Order in monitor: prediction_error checked first → it wins.
    expect(events[0]?.signal).toBe('prediction_error');
  });
});

describe('PsychosisMonitor — attach', () => {
  test('attach() subscribes to trace:record and returns unsubscribe', () => {
    const bus = makeBus();
    const { events } = capturedTriggers(bus);
    const monitor = new PsychosisMonitor({
      bus,
      minObservations: 1,
      fallbackCeilings: { delusion: 0.15 },
    });
    const unsub = monitor.attach();
    bus.emit('trace:record', {
      trace: trace({
        agentId: 'p',
        delusionResult: { kind: 'delusion', falsifiedCount: 1, delusionRate: 0.5 },
      }),
    });
    expect(events).toHaveLength(1);
    unsub();
    bus.emit('trace:record', {
      trace: trace({
        agentId: 'p',
        delusionResult: { kind: 'delusion', falsifiedCount: 1, delusionRate: 0.5 },
      }),
    });
    expect(events).toHaveLength(1); // detached, no further events
  });
});
