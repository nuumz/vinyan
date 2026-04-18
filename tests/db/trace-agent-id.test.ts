/**
 * Phase 3 (multi-agent follow-up) — verify execution_traces.agent_id
 * partitioning. Before this landed, traces were keyed only by worker_id
 * (oracle id), so per-agent analytics misattributed activity across
 * specialists. These tests prove:
 *   - insert persists agent_id
 *   - findByAgent returns only the named specialist's rows
 *   - rows with agent_id IS NULL are NOT returned by findByAgent
 *   - rowToTrace roundtrips agentId
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { TRACE_SCHEMA_SQL } from '../../src/db/trace-schema.ts';
import { TraceStore } from '../../src/db/trace-store.ts';
import type { ExecutionTrace } from '../../src/orchestrator/types.ts';

function createDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(TRACE_SCHEMA_SQL);
  return db;
}

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: `trace-${Math.random().toString(36).slice(2, 10)}`,
    taskId: `task-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    routingLevel: 1,
    approach: 'direct-edit',
    oracleVerdicts: { ast: true, type: true },
    modelUsed: 'claude-haiku',
    tokensConsumed: 500,
    durationMs: 1200,
    outcome: 'success',
    affectedFiles: ['src/foo.ts'],
    ...overrides,
  };
}

describe('TraceStore agent_id partitioning', () => {
  let db: Database;
  let store: TraceStore;

  beforeEach(() => {
    db = createDb();
    store = new TraceStore(db);
  });

  afterEach(() => {
    db.close();
  });

  test('insert persists agent_id and rowToTrace roundtrips it', () => {
    store.insert(makeTrace({ id: 'trace-ts-1', agentId: 'ts-coder' }));
    const recent = store.findRecent(10);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.agentId).toBe('ts-coder');
  });

  test('insert without agentId stores NULL and rowToTrace returns undefined', () => {
    store.insert(makeTrace({ id: 'trace-anon-1' }));
    const recent = store.findRecent(10);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.agentId).toBeUndefined();
  });

  test('findByAgent returns only rows for the given specialist', () => {
    store.insert(makeTrace({ id: 'ts-a', agentId: 'ts-coder', taskId: 'task-ts-a' }));
    store.insert(makeTrace({ id: 'ts-b', agentId: 'ts-coder', taskId: 'task-ts-b' }));
    store.insert(makeTrace({ id: 'w-a', agentId: 'writer', taskId: 'task-w-a' }));
    store.insert(makeTrace({ id: 'null-a', taskId: 'task-null-a' })); // no agent

    const tsRows = store.findByAgent('ts-coder');
    expect(tsRows).toHaveLength(2);
    for (const r of tsRows) expect(r.agentId).toBe('ts-coder');

    const writerRows = store.findByAgent('writer');
    expect(writerRows).toHaveLength(1);
    expect(writerRows[0]!.agentId).toBe('writer');
  });

  test('findByAgent excludes rows with NULL agent_id', () => {
    store.insert(makeTrace({ id: 'legacy-1', taskId: 'task-legacy-1' })); // agent_id = NULL
    store.insert(makeTrace({ id: 'ts-x', agentId: 'ts-coder', taskId: 'task-ts-x' }));

    const tsRows = store.findByAgent('ts-coder');
    expect(tsRows).toHaveLength(1);
    expect(tsRows[0]!.id).toBe('ts-x');
  });

  test('findByAgent respects the limit arg and orders by timestamp DESC', () => {
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      store.insert(
        makeTrace({ id: `acc-${i}`, agentId: 'accountant', taskId: `t-${i}`, timestamp: base + i }),
      );
    }
    const limited = store.findByAgent('accountant', 2);
    expect(limited).toHaveLength(2);
    expect(limited[0]!.timestamp).toBeGreaterThan(limited[1]!.timestamp);
  });
});
