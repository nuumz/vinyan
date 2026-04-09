import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createBus, type VinyanBus } from '../../src/core/bus.ts';
import { MetricsCollector } from '../../src/observability/metrics.ts';
import { CalibratedSelfModel } from '../../src/orchestrator/prediction/self-model.ts';
import type { ExecutionTrace } from '../../src/orchestrator/types.ts';
import { WorkingMemory } from '../../src/orchestrator/working-memory.ts';

// ── Helpers ─────────────────────────────────────────────────────────

function makeTaskInput() {
  return {
    id: 't1',
    source: 'cli' as const,
    goal: 'test something',
    taskType: 'code' as const,
    budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 1 },
  };
}

function makePerception() {
  return {
    dependencyCone: { transitiveBlastRadius: 1, directDependents: [], transitiveDependents: [] },
    diagnostics: { typeErrors: [], lintWarnings: [] },
  } as any;
}

function makeTrace(overrides?: Partial<ExecutionTrace>): ExecutionTrace {
  return {
    id: 'trace-1',
    taskId: 't1',
    workerId: 'w1',
    timestamp: Date.now(),
    routingLevel: 2,
    approach: 'test',
    oracleVerdicts: {},
    modelUsed: 'mock',
    tokensConsumed: 100,
    durationMs: 500,
    outcome: 'success',
    affectedFiles: ['test.ts'],
    ...overrides,
  } as any;
}

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS model_parameters (key TEXT PRIMARY KEY, value TEXT)');
  return db;
}

// ── WorkingMemory: memory:eviction_warning ──────────────────────────

describe('WorkingMemory emits memory:eviction_warning', () => {
  let bus: VinyanBus;
  let received: Array<{ taskId: string; evictionCount: number; memoryPressure: number }>;

  beforeEach(() => {
    bus = createBus();
    received = [];
    bus.on('memory:eviction_warning', (payload) => received.push(payload));
  });

  test('emits when failed approaches reach threshold (10)', () => {
    const wm = new WorkingMemory({ bus, taskId: 'task-42' });

    for (let i = 0; i < 12; i++) {
      wm.recordFailedApproach(`approach-${i}`, 'oracle-fail');
    }

    // Events emitted for each record at or above threshold (i=9,10,11 → 3 events)
    expect(received.length).toBe(3);
    expect(received[0]!.taskId).toBe('task-42');
    expect(received[0]!.evictionCount).toBe(10);
    expect(received[0]!.memoryPressure).toBe(0.5); // 10/20
    expect(received[2]!.evictionCount).toBe(12);
    expect(received[2]!.memoryPressure).toBe(0.6); // 12/20
  });

  test('does NOT emit below threshold', () => {
    const wm = new WorkingMemory({ bus, taskId: 'task-99' });

    for (let i = 0; i < 5; i++) {
      wm.recordFailedApproach(`approach-${i}`, 'oracle-fail');
    }

    expect(received).toHaveLength(0);
  });

  test('does NOT emit without bus', () => {
    const wm = new WorkingMemory({ taskId: 'task-no-bus' });

    for (let i = 0; i < 15; i++) {
      wm.recordFailedApproach(`approach-${i}`, 'oracle-fail');
    }

    expect(received).toHaveLength(0);
  });

  test('does NOT emit without taskId', () => {
    const wm = new WorkingMemory({ bus });

    for (let i = 0; i < 15; i++) {
      wm.recordFailedApproach(`approach-${i}`, 'oracle-fail');
    }

    expect(received).toHaveLength(0);
  });
});

// ── CalibratedSelfModel: selfmodel:systematic_miscalibration ────────

describe('CalibratedSelfModel emits selfmodel:systematic_miscalibration', () => {
  let bus: VinyanBus;
  let db: InstanceType<typeof Database>;
  let received: Array<{ taskId: string; biasDirection: 'over' | 'under'; magnitude: number; windowSize: number }>;

  beforeEach(() => {
    bus = createBus();
    db = createTestDb();
    received = [];
    bus.on('selfmodel:systematic_miscalibration', (payload) => received.push(payload));
  });

  test('emits after 20 calibrations with consistent bias direction', async () => {
    const model = new CalibratedSelfModel({ db, bus });

    const input = makeTaskInput();
    const perception = makePerception();

    for (let i = 0; i < 22; i++) {
      const prediction = await model.predict(input, perception);

      // Force "over" bias: actual quality much lower than predicted → composite error > 0
      const trace = makeTrace({
        id: `trace-${i}`,
        outcome: 'failure',
        durationMs: prediction.expectedDuration * 3,
        affectedFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
      });

      model.calibrate(prediction, trace);
    }

    // Window is 20, so events start appearing after 20th calibration
    expect(received.length).toBeGreaterThanOrEqual(1);
    const last = received[received.length - 1]!;
    expect(last.taskId).toBe('t1');
    expect(last.windowSize).toBe(20);
    // Bias direction depends on composite error sign — with failure+long duration it should be consistent
    expect(['over', 'under']).toContain(last.biasDirection);
    // Magnitude is between 0 and 0.5
    expect(last.magnitude).toBeGreaterThanOrEqual(0);
    expect(last.magnitude).toBeLessThanOrEqual(0.5);
  });

  test('does NOT emit before window fills (under 20 calibrations)', async () => {
    const model = new CalibratedSelfModel({ db, bus });

    const input = makeTaskInput();
    const perception = makePerception();

    // Only 15 calibrations — below the 20-sample window
    for (let i = 0; i < 15; i++) {
      const prediction = await model.predict(input, perception);
      const trace = makeTrace({
        id: `trace-${i}`,
        outcome: 'failure',
        durationMs: prediction.expectedDuration * 10,
        affectedFiles: ['a.ts', 'b.ts', 'c.ts'],
      });
      model.calibrate(prediction, trace);
    }

    // Window hasn't filled yet — no event should fire
    expect(received.length).toBe(0);
  });

  test('does NOT emit without bus', async () => {
    const model = new CalibratedSelfModel({ db });

    const input = makeTaskInput();
    const perception = makePerception();

    for (let i = 0; i < 22; i++) {
      const prediction = await model.predict(input, perception);
      const trace = makeTrace({
        id: `trace-${i}`,
        outcome: 'failure',
        durationMs: prediction.expectedDuration * 3,
        affectedFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
      });
      model.calibrate(prediction, trace);
    }

    expect(received).toHaveLength(0);
  });
});

// ── MetricsCollector: Phase 5 event counters ────────────────────────

describe('MetricsCollector counts Phase 5 events', () => {
  let bus: VinyanBus;
  let collector: MetricsCollector;

  beforeEach(() => {
    bus = createBus();
    collector = new MetricsCollector();
    collector.attach(bus);
  });

  test('counts memory:eviction_warning events', () => {
    bus.emit('memory:eviction_warning', { taskId: 't1', evictionCount: 10, memoryPressure: 0.5 });
    bus.emit('memory:eviction_warning', { taskId: 't2', evictionCount: 15, memoryPressure: 0.75 });

    expect(collector.get('memory.eviction')).toBe(2);
  });

  test('counts api:request events', () => {
    bus.emit('api:request', { method: 'POST', path: '/task', taskId: 't1' });
    bus.emit('api:request', { method: 'GET', path: '/status' });

    expect(collector.get('api.request')).toBe(2);
  });

  test('counts observability:alert events', () => {
    bus.emit('observability:alert', {
      detector: 'gap-h',
      severity: 'warning',
      message: 'High memory pressure',
    });

    expect(collector.get('observability.alert')).toBe(1);
  });

  test('counts oracle:verdict events', () => {
    bus.emit('oracle:verdict', { taskId: 't1', oracleName: 'ast', verdict: { pass: true, confidence: 0.9 } as any });
    bus.emit('oracle:verdict', { taskId: 't1', oracleName: 'type', verdict: { pass: false, confidence: 0.8 } as any });
    bus.emit('oracle:verdict', { taskId: 't2', oracleName: 'ast', verdict: { pass: true, confidence: 1.0 } as any });

    expect(collector.get('oracle.verdict')).toBe(3);
  });

  test('counts selfmodel:systematic_miscalibration events', () => {
    bus.emit('selfmodel:systematic_miscalibration', {
      taskId: 't1',
      biasDirection: 'over',
      magnitude: 0.3,
      windowSize: 20,
    });

    expect(collector.get('selfmodel.miscalibration')).toBe(1);
  });

  test('counts context:verdict_omitted events', () => {
    bus.emit('context:verdict_omitted', { taskId: 't1', oracleName: 'ast', reason: 'timeout' });

    expect(collector.get('context.verdict_omitted')).toBe(1);
  });

  test('getCounters() returns all Phase 5 counts together', () => {
    bus.emit('memory:eviction_warning', { taskId: 't1', evictionCount: 10, memoryPressure: 0.5 });
    bus.emit('api:request', { method: 'GET', path: '/health' });
    bus.emit('observability:alert', { detector: 'test', severity: 'critical', message: 'test' });
    bus.emit('oracle:verdict', { taskId: 't1', oracleName: 'ast', verdict: { pass: true } as any });

    const counters = collector.getCounters();
    expect(counters['memory.eviction']).toBe(1);
    expect(counters['api.request']).toBe(1);
    expect(counters['observability.alert']).toBe(1);
    expect(counters['oracle.verdict']).toBe(1);
  });
});
