import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { QualityScore } from '../../src/core/types.ts';
import { TRACE_SCHEMA_SQL } from '../../src/db/trace-schema.ts';
import { TraceStore } from '../../src/db/trace-store.ts';
import type { ExecutionTrace } from '../../src/orchestrator/types.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(TRACE_SCHEMA_SQL);
  return db;
}

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: 'trace-001',
    taskId: 'task-001',
    timestamp: Date.now(),
    routingLevel: 1,
    approach: 'direct-edit',
    oracleVerdicts: { ast: true, type: true, dep: false },
    modelUsed: 'claude-haiku',
    tokensConsumed: 500,
    durationMs: 1200,
    outcome: 'success',
    affectedFiles: ['src/foo.ts', 'src/bar.ts'],
    ...overrides,
  };
}

const PHASE1_QUALITY: QualityScore = {
  architecturalCompliance: 0.85,
  efficiency: 0.72,
  simplificationGain: 0.6,
  testMutationScore: 0.45,
  composite: 0.66,
  dimensionsAvailable: 4,
  phase: 'phase1',
};

describe('TraceStore', () => {
  let db: Database;
  let store: TraceStore;

  beforeEach(() => {
    db = createTestDb();
    store = new TraceStore(db);
  });

  afterEach(() => {
    db.close();
  });

  test('insert and query roundtrip', () => {
    const trace = makeTrace();
    store.insert(trace);

    const results = store.findRecent(10);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('trace-001');
    expect(results[0]!.taskId).toBe('task-001');
    expect(results[0]!.routingLevel).toBe(1);
    expect(results[0]!.approach).toBe('direct-edit');
    expect(results[0]!.modelUsed).toBe('claude-haiku');
    expect(results[0]!.tokensConsumed).toBe(500);
    expect(results[0]!.outcome).toBe('success');
  });

  test('JSON fields deserialized correctly', () => {
    const trace = makeTrace({
      oracleVerdicts: { ast: true, type: false },
      affectedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    });
    store.insert(trace);

    const result = store.findRecent(1)[0]!;
    expect(result.oracleVerdicts).toEqual({ ast: true, type: false });
    expect(result.affectedFiles).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  test('QualityScore denormalized into columns and reconstructed', () => {
    const trace = makeTrace({ qualityScore: PHASE1_QUALITY });
    store.insert(trace);

    const result = store.findRecent(1)[0]!;
    expect(result.qualityScore).toBeDefined();
    expect(result.qualityScore!.architecturalCompliance).toBe(0.85);
    expect(result.qualityScore!.efficiency).toBe(0.72);
    expect(result.qualityScore!.simplificationGain).toBe(0.6);
    expect(result.qualityScore!.testMutationScore).toBe(0.45);
    expect(result.qualityScore!.composite).toBe(0.66);
    expect(result.qualityScore!.dimensionsAvailable).toBe(4);
    expect(result.qualityScore!.phase).toBe('phase1');
  });

  test('trace without QualityScore returns undefined', () => {
    store.insert(makeTrace());

    const result = store.findRecent(1)[0]!;
    expect(result.qualityScore).toBeUndefined();
  });

  test('phase0 QualityScore (2 dims) roundtrip', () => {
    const phase0: QualityScore = {
      architecturalCompliance: 0.9,
      efficiency: 0.8,
      composite: 0.86,
      dimensionsAvailable: 2,
      phase: 'phase0',
    };
    store.insert(makeTrace({ qualityScore: phase0 }));

    const result = store.findRecent(1)[0]!;
    expect(result.qualityScore!.phase).toBe('phase0');
    expect(result.qualityScore!.dimensionsAvailable).toBe(2);
    expect(result.qualityScore!.simplificationGain).toBeUndefined();
  });

  test('findByTaskType filters correctly', () => {
    store.insert(makeTrace({ id: 't1', taskTypeSignature: 'refactor:rename' }));
    store.insert(makeTrace({ id: 't2', taskTypeSignature: 'bugfix:null-check' }));
    store.insert(makeTrace({ id: 't3', taskTypeSignature: 'refactor:rename' }));

    const refactors = store.findByTaskType('refactor:rename');
    expect(refactors).toHaveLength(2);
    expect(refactors.every((t) => t.taskTypeSignature === 'refactor:rename')).toBe(true);
  });

  test('findByOutcome filters correctly', () => {
    store.insert(makeTrace({ id: 't1', outcome: 'success' }));
    store.insert(makeTrace({ id: 't2', outcome: 'failure', failureReason: 'type error' }));
    store.insert(makeTrace({ id: 't3', outcome: 'timeout' }));

    const failures = store.findByOutcome('failure');
    expect(failures).toHaveLength(1);
    expect(failures[0]!.failureReason).toBe('type error');
  });

  test('findByTimeRange filters correctly', () => {
    const now = Date.now();
    store.insert(makeTrace({ id: 't1', timestamp: now - 5000 }));
    store.insert(makeTrace({ id: 't2', timestamp: now - 1000 }));
    store.insert(makeTrace({ id: 't3', timestamp: now + 5000 }));

    const results = store.findByTimeRange(now - 6000, now);
    expect(results).toHaveLength(2);
    expect(results[0]!.id).toBe('t1'); // ASC order
    expect(results[1]!.id).toBe('t2');
  });

  test('count returns total traces', () => {
    expect(store.count()).toBe(0);
    store.insert(makeTrace({ id: 't1' }));
    store.insert(makeTrace({ id: 't2' }));
    expect(store.count()).toBe(2);
  });

  test('countDistinctTaskTypes counts unique signatures', () => {
    store.insert(makeTrace({ id: 't1', taskTypeSignature: 'a' }));
    store.insert(makeTrace({ id: 't2', taskTypeSignature: 'a' }));
    store.insert(makeTrace({ id: 't3', taskTypeSignature: 'b' }));
    store.insert(makeTrace({ id: 't4' })); // no signature — not counted

    expect(store.countDistinctTaskTypes()).toBe(2);
  });

  test('predictionError JSON roundtrip', () => {
    const trace = makeTrace({
      predictionError: {
        taskId: 'task-001',
        predicted: {
          taskId: 'task-001',
          timestamp: Date.now(),
          expectedTestResults: 'pass',
          expectedBlastRadius: 3,
          expectedDuration: 5000,
          expectedQualityScore: 0.7,
          uncertainAreas: [],
          confidence: 0.6,
          metaConfidence: 0.2,
          basis: 'static-heuristic',
          calibrationDataPoints: 0,
        },
        actual: { testResults: 'fail', blastRadius: 5, duration: 8000, qualityScore: 0.4 },
        error: {
          testResultMatch: false,
          blastRadiusDelta: 2,
          durationDelta: 3000,
          qualityScoreDelta: -0.3,
          composite: 0.45,
        },
      },
    });
    store.insert(trace);

    const result = store.findRecent(1)[0]!;
    expect(result.predictionError).toBeDefined();
    expect(result.predictionError!.error.composite).toBe(0.45);
    expect(result.predictionError!.actual.testResults).toBe('fail');
  });

  test('optional fields handled gracefully', () => {
    store.insert(
      makeTrace({
        sessionId: 'sess-1',
        workerId: 'w-1',
        approachDescription: 'detailed explanation',
        riskScore: 0.35,
        validationDepth: 'structural',
      }),
    );

    const result = store.findRecent(1)[0]!;
    expect(result.sessionId).toBe('sess-1');
    expect(result.workerId).toBe('w-1');
    expect(result.approachDescription).toBe('detailed explanation');
    expect(result.riskScore).toBe(0.35);
    expect(result.validationDepth).toBe('structural');
  });
});
