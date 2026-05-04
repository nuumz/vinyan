/**
 * Behavior tests for the T5 `getSuccessRateByThinkingModePerTaskType` query.
 *
 * Pinned contracts:
 *   - groups by (task_type_signature, thinking_mode) pair
 *   - NULL task_type_signature is filtered out (calibrator can't key by NULL)
 *   - NULL thinking_mode buckets under '(none)' sentinel
 *   - successRate computed per group, not aggregated globally
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { TRACE_SCHEMA_SQL } from '../../src/db/trace-schema.ts';
import { TraceStore } from '../../src/db/trace-store.ts';

function freshDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(TRACE_SCHEMA_SQL);
  return db;
}

function insertTrace(
  db: Database,
  args: {
    taskType: string | null;
    thinkingMode: string | null;
    outcome: 'success' | 'failure';
    quality?: number;
  },
): void {
  const id = `trace-${Math.random().toString(36).slice(2, 10)}`;
  db.run(
    `INSERT INTO execution_traces (
      id, task_id, timestamp, routing_level, approach, model_used,
      tokens_consumed, duration_ms, outcome, oracle_verdicts, affected_files,
      task_type_signature, thinking_mode, quality_composite
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      `task-${id}`,
      Date.now(),
      2,
      'test',
      'mock',
      1000,
      100,
      args.outcome,
      '{}',
      '[]',
      args.taskType,
      args.thinkingMode,
      args.quality ?? 0.7,
    ],
  );
}

describe('TraceStore.getSuccessRateByThinkingModePerTaskType', () => {
  test('groups by (taskType, mode) and computes per-group success rate', () => {
    const db = freshDb();
    const store = new TraceStore(db);
    // edit-ts: 4 successes / 6 total under adaptive:high, 1/2 under (none)
    for (let i = 0; i < 4; i++)
      insertTrace(db, { taskType: 'edit-ts', thinkingMode: 'adaptive:high', outcome: 'success' });
    for (let i = 0; i < 2; i++)
      insertTrace(db, { taskType: 'edit-ts', thinkingMode: 'adaptive:high', outcome: 'failure' });
    insertTrace(db, { taskType: 'edit-ts', thinkingMode: null, outcome: 'success' });
    insertTrace(db, { taskType: 'edit-ts', thinkingMode: null, outcome: 'failure' });
    // refactor: 1 success / 1 under adaptive:medium
    insertTrace(db, { taskType: 'refactor', thinkingMode: 'adaptive:medium', outcome: 'success' });

    const rows = store.getSuccessRateByThinkingModePerTaskType();
    const editHigh = rows.find((r) => r.taskType === 'edit-ts' && r.thinkingMode === 'adaptive:high');
    expect(editHigh?.total).toBe(6);
    expect(editHigh?.successes).toBe(4);
    expect(editHigh?.successRate).toBeCloseTo(4 / 6, 5);

    const editNone = rows.find((r) => r.taskType === 'edit-ts' && r.thinkingMode === '(none)');
    expect(editNone?.total).toBe(2);
    expect(editNone?.successes).toBe(1);
    expect(editNone?.successRate).toBe(0.5);

    const refactorMid = rows.find((r) => r.taskType === 'refactor' && r.thinkingMode === 'adaptive:medium');
    expect(refactorMid?.total).toBe(1);
  });

  test('rows with NULL task_type_signature are filtered out', () => {
    const db = freshDb();
    const store = new TraceStore(db);
    insertTrace(db, { taskType: 'edit-ts', thinkingMode: 'adaptive:high', outcome: 'success' });
    insertTrace(db, { taskType: null, thinkingMode: 'adaptive:high', outcome: 'success' });

    const rows = store.getSuccessRateByThinkingModePerTaskType();
    expect(rows.length).toBe(1);
    expect(rows[0]?.taskType).toBe('edit-ts');
  });

  test('empty database → empty array (not error)', () => {
    const db = freshDb();
    const store = new TraceStore(db);
    expect(store.getSuccessRateByThinkingModePerTaskType()).toEqual([]);
  });
});
