import { Database } from 'bun:sqlite';
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { TRACE_SCHEMA_SQL } from '../../src/db/trace-schema.ts';
import { TraceStore } from '../../src/db/trace-store.ts';
import type { ExecutionTrace, TaskInput } from '../../src/orchestrator/types.ts';
import { profileHistory } from '../../src/orchestrator/historical-profiler.ts';

function makeInput(overrides?: Partial<TaskInput>): TaskInput {
  return {
    id: 't1',
    source: 'cli',
    goal: 'fix the auth service',
    taskType: 'code',
    targetFiles: ['src/auth/login.ts'],
    budget: { maxTokens: 10000, maxDurationMs: 60000, maxRetries: 3 },
    ...overrides,
  };
}

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: `trace-${Math.random().toString(36).slice(2)}`,
    taskId: `task-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    routingLevel: 1,
    approach: 'direct-edit',
    oracleVerdicts: { ast: true, type: true },
    modelUsed: 'claude-haiku',
    tokensConsumed: 500,
    durationMs: 1200,
    outcome: 'success',
    affectedFiles: ['src/auth/login.ts'],
    taskTypeSignature: 'fix::ts::single',
    ...overrides,
  };
}

describe('profileHistory', () => {
  let db: Database;
  let store: TraceStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(TRACE_SCHEMA_SQL);
    store = new TraceStore(db);
  });

  afterEach(() => {
    db.close();
  });

  test('empty history returns zero-valued profile', () => {
    const input = makeInput();
    const profile = profileHistory(input, store);

    expect(profile.observationCount).toBe(0);
    expect(profile.failRate).toBe(0);
    expect(profile.commonFailureOracles).toEqual([]);
    expect(profile.avgDurationPerFile).toBe(0);
    expect(profile.isRecurring).toBe(false);
    expect(profile.priorAttemptCount).toBe(0);
    expect(profile.basis).toBe('static-heuristic');
  });

  test('2 traces for same file+verb is NOT recurring', () => {
    const input = makeInput();
    // Insert 2 traces with same affected file
    store.insert(makeTrace({ affectedFiles: ['src/auth/login.ts'], taskTypeSignature: 'fix::ts::single' }));
    store.insert(makeTrace({ affectedFiles: ['src/auth/login.ts'], taskTypeSignature: 'fix::ts::single' }));

    const profile = profileHistory(input, store);

    expect(profile.isRecurring).toBe(false);
    expect(profile.priorAttemptCount).toBe(2);
  });

  test('3+ traces for same file+verb is recurring', () => {
    const input = makeInput();
    // Insert 3 traces with same affected file
    for (let i = 0; i < 3; i++) {
      store.insert(makeTrace({ affectedFiles: ['src/auth/login.ts'], taskTypeSignature: 'fix::ts::single' }));
    }

    const profile = profileHistory(input, store);

    expect(profile.isRecurring).toBe(true);
    expect(profile.priorAttemptCount).toBe(3);
  });

  test('common failure oracles ranked by frequency', () => {
    const input = makeInput();

    // 3 failures: 'type' fails in all 3, 'ast' fails in 2, 'dep' fails in 1
    store.insert(makeTrace({
      outcome: 'failure',
      oracleVerdicts: { ast: false, type: false, dep: false },
      taskTypeSignature: 'fix::ts::single',
    }));
    store.insert(makeTrace({
      outcome: 'failure',
      oracleVerdicts: { ast: false, type: false, dep: true },
      taskTypeSignature: 'fix::ts::single',
    }));
    store.insert(makeTrace({
      outcome: 'failure',
      oracleVerdicts: { ast: true, type: false, dep: true },
      taskTypeSignature: 'fix::ts::single',
    }));

    const profile = profileHistory(input, store);

    expect(profile.commonFailureOracles[0]).toBe('type'); // 3 failures
    expect(profile.commonFailureOracles[1]).toBe('ast');  // 2 failures
    expect(profile.commonFailureOracles[2]).toBe('dep');  // 1 failure
    expect(profile.commonFailureOracles).toHaveLength(3);
  });

  test('failRate calculated correctly', () => {
    const input = makeInput();

    // 2 success, 1 failure
    store.insert(makeTrace({ outcome: 'success', taskTypeSignature: 'fix::ts::single' }));
    store.insert(makeTrace({ outcome: 'success', taskTypeSignature: 'fix::ts::single' }));
    store.insert(makeTrace({ outcome: 'failure', taskTypeSignature: 'fix::ts::single' }));

    const profile = profileHistory(input, store);

    expect(profile.failRate).toBeCloseTo(1 / 3, 5);
    expect(profile.observationCount).toBe(3);
  });

  test('different task type signatures are isolated', () => {
    const input = makeInput({ goal: 'fix auth', targetFiles: ['src/auth/login.ts'] });

    // Insert traces with different signatures
    store.insert(makeTrace({ taskTypeSignature: 'fix::ts::single', affectedFiles: ['src/auth/login.ts'] }));
    store.insert(makeTrace({ taskTypeSignature: 'refactor::ts::medium', affectedFiles: ['src/auth/login.ts'] }));

    const profile = profileHistory(input, store);

    // Should only see the fix::ts::single trace (matching input's computed signature)
    expect(profile.observationCount).toBe(1);
  });

  test('no failures returns empty commonFailureOracles', () => {
    const input = makeInput();
    store.insert(makeTrace({ outcome: 'success', taskTypeSignature: 'fix::ts::single' }));
    store.insert(makeTrace({ outcome: 'success', taskTypeSignature: 'fix::ts::single' }));

    const profile = profileHistory(input, store);

    expect(profile.commonFailureOracles).toEqual([]);
  });

  test('basis reflects observation count', () => {
    const input = makeInput();

    // 4 traces → static-heuristic
    for (let i = 0; i < 4; i++) {
      store.insert(makeTrace({ taskTypeSignature: 'fix::ts::single' }));
    }
    expect(profileHistory(input, store).basis).toBe('static-heuristic');

    // Add 1 more → 5 total → hybrid
    store.insert(makeTrace({ taskTypeSignature: 'fix::ts::single' }));
    expect(profileHistory(input, store).basis).toBe('hybrid');

    // Add 25 more → 30 total → trace-calibrated
    for (let i = 0; i < 25; i++) {
      store.insert(makeTrace({ taskTypeSignature: 'fix::ts::single' }));
    }
    expect(profileHistory(input, store).basis).toBe('trace-calibrated');
  });

  test('avgDurationPerFile computed correctly', () => {
    const input = makeInput();

    // Trace 1: 1200ms, 2 files → 600ms/file
    store.insert(makeTrace({
      durationMs: 1200,
      affectedFiles: ['src/a.ts', 'src/b.ts'],
      taskTypeSignature: 'fix::ts::single',
    }));
    // Trace 2: 900ms, 1 file → 900ms/file
    store.insert(makeTrace({
      durationMs: 900,
      affectedFiles: ['src/c.ts'],
      taskTypeSignature: 'fix::ts::single',
    }));

    const profile = profileHistory(input, store);

    // Average: (600 + 900) / 2 = 750
    expect(profile.avgDurationPerFile).toBeCloseTo(750, 0);
  });

  test('no targetFiles means isRecurring is always false', () => {
    const input = makeInput({ targetFiles: undefined });

    for (let i = 0; i < 5; i++) {
      store.insert(makeTrace({
        affectedFiles: ['src/auth/login.ts'],
        taskTypeSignature: 'fix::ts::single',
      }));
    }

    const profile = profileHistory(input, store);

    expect(profile.isRecurring).toBe(false);
    expect(profile.priorAttemptCount).toBe(0);
  });
});
