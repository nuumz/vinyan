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
import { asPersonaId } from '../../src/core/agent-vocabulary.ts';
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
    store.insert(makeTrace({ id: 'trace-ts-1', agentId: asPersonaId('ts-coder') }));
    const recent = store.findRecent(10);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.agentId).toBe(asPersonaId('ts-coder'));
  });

  test('insert without agentId stores NULL and rowToTrace returns undefined', () => {
    store.insert(makeTrace({ id: 'trace-anon-1' }));
    const recent = store.findRecent(10);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.agentId).toBeUndefined();
  });

  test('findByAgent returns only rows for the given specialist', () => {
    store.insert(makeTrace({ id: 'ts-a', agentId: asPersonaId('ts-coder'), taskId: 'task-ts-a' }));
    store.insert(makeTrace({ id: 'ts-b', agentId: asPersonaId('ts-coder'), taskId: 'task-ts-b' }));
    store.insert(makeTrace({ id: 'w-a', agentId: asPersonaId('writer'), taskId: 'task-w-a' }));
    store.insert(makeTrace({ id: 'null-a', taskId: 'task-null-a' })); // no agent

    const tsRows = store.findByAgent('ts-coder');
    expect(tsRows).toHaveLength(2);
    for (const r of tsRows) expect(r.agentId).toBe(asPersonaId('ts-coder'));

    const writerRows = store.findByAgent('writer');
    expect(writerRows).toHaveLength(1);
    expect(writerRows[0]!.agentId).toBe(asPersonaId('writer'));
  });

  test('findByAgent excludes rows with NULL agent_id', () => {
    store.insert(makeTrace({ id: 'legacy-1', taskId: 'task-legacy-1' })); // agent_id = NULL
    store.insert(makeTrace({ id: 'ts-x', agentId: asPersonaId('ts-coder'), taskId: 'task-ts-x' }));

    const tsRows = store.findByAgent('ts-coder');
    expect(tsRows).toHaveLength(1);
    expect(tsRows[0]!.id).toBe('ts-x');
  });

  test('findByAgent respects the limit arg and orders by timestamp DESC', () => {
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      store.insert(
        makeTrace({ id: `acc-${i}`, agentId: asPersonaId('accountant'), taskId: `t-${i}`, timestamp: base + i }),
      );
    }
    const limited = store.findByAgent('accountant', 2);
    expect(limited).toHaveLength(2);
    expect(limited[0]!.timestamp).toBeGreaterThan(limited[1]!.timestamp);
  });

  test('rowToTrace degrades a malformed legacy agent_id to undefined (A9, no silent fallback to bare string)', () => {
    // Bypass the typed insert path: simulate a legacy row that was
    // written before the PersonaId-shape contract was enforced. Only
    // the NOT-NULL columns must be populated; the rest stay default/NULL.
    db.run(
      `INSERT INTO execution_traces
         (id, task_id, agent_id, timestamp, routing_level, approach,
          model_used, tokens_consumed, duration_ms, outcome,
          oracle_verdicts, affected_files)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'malformed-1',
        'task-mal',
        'INVALID UPPER',
        Date.now(),
        1,
        'noop',
        'haiku',
        0,
        0,
        'success',
        '{}',
        '[]',
      ],
    );
    const recent = store.findRecent(10);
    const malformed = recent.find((r) => r.id === 'malformed-1');
    expect(malformed).toBeDefined();
    // The malformed agent_id MUST NOT survive deserialization as a bare
    // string; the field becomes undefined, not 'INVALID UPPER'.
    expect(malformed!.agentId).toBeUndefined();
  });
});
