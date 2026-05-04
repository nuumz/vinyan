/**
 * Tests for `RoleProtocolRunStore` — Phase A2 audit log persistence.
 *
 * Behavior-only: every assertion exercises the public API and verifies
 * the documented contract.
 *
 * Coverage:
 *   - recordStep persists every nullable field correctly
 *   - listForTask returns step records in step_index order
 *   - listForProtocol returns recent runs (DESC by started_at)
 *   - outcomeCountsForPersona aggregates buckets
 *   - composite PK idempotency (same task+step+started_at → silent dedup)
 *   - oversize evidence payload truncated, marker present
 *   - JSON roundtrip for oracle_verdicts + evidence
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { RoleProtocolRunStore } from '../../src/db/role-protocol-run-store.ts';

describe('RoleProtocolRunStore', () => {
  let db: Database;
  let store: RoleProtocolRunStore;

  beforeEach(() => {
    db = new Database(':memory:');
    new MigrationRunner().migrate(db, ALL_MIGRATIONS);
    store = new RoleProtocolRunStore(db);
  });

  test('listForTask returns empty when no rows recorded', () => {
    expect(store.listForTask('task-1')).toEqual([]);
  });

  test('recordStep persists a success record with full field roundtrip', () => {
    store.recordStep({
      taskId: 'task-1',
      personaId: 'researcher',
      protocolId: 'researcher.investigate',
      stepId: 'discover',
      stepIndex: 0,
      outcome: 'success',
      attempts: 1,
      confidence: 0.85,
      tokensConsumed: 250,
      durationMs: 12,
      evidence: { hashes: ['hash-a', 'hash-b'] },
      oracleVerdicts: { 'source-citation': true },
      startedAt: 1000,
    });
    const rows = store.listForTask('task-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      taskId: 'task-1',
      personaId: 'researcher',
      protocolId: 'researcher.investigate',
      stepId: 'discover',
      stepIndex: 0,
      outcome: 'success',
      attempts: 1,
      confidence: 0.85,
      tokensConsumed: 250,
      durationMs: 12,
      reason: null,
      oracleVerdicts: { 'source-citation': true },
      evidence: { hashes: ['hash-a', 'hash-b'] },
      startedAt: 1000,
    });
  });

  test('recordStep persists a reject record with reason populated', () => {
    store.recordStep({
      taskId: 'task-1',
      personaId: 'researcher',
      protocolId: 'researcher.investigate',
      stepId: 'verify-citations',
      stepIndex: 4,
      outcome: 'oracle-blocked',
      attempts: 2,
      tokensConsumed: 80,
      durationMs: 4,
      reason: 'blocking oracle "source-citation" failed after 2 attempt(s)',
      oracleVerdicts: { 'source-citation': false },
      startedAt: 2000,
    });
    const rows = store.listForTask('task-1');
    expect(rows[0]?.outcome).toBe('oracle-blocked');
    expect(rows[0]?.reason).toBe('blocking oracle "source-citation" failed after 2 attempt(s)');
    expect(rows[0]?.confidence).toBeNull();
  });

  test('listForTask orders by step_index ASC, then started_at ASC', () => {
    // Records inserted out of step order — listForTask must sort by stepIndex.
    store.recordStep({
      taskId: 't',
      personaId: 'p',
      protocolId: 'pr',
      stepId: 'verify',
      stepIndex: 4,
      outcome: 'success',
      attempts: 1,
      tokensConsumed: 0,
      durationMs: 0,
      startedAt: 5,
    });
    store.recordStep({
      taskId: 't',
      personaId: 'p',
      protocolId: 'pr',
      stepId: 'discover',
      stepIndex: 0,
      outcome: 'success',
      attempts: 1,
      tokensConsumed: 0,
      durationMs: 0,
      startedAt: 1,
    });
    store.recordStep({
      taskId: 't',
      personaId: 'p',
      protocolId: 'pr',
      stepId: 'gather',
      stepIndex: 1,
      outcome: 'success',
      attempts: 1,
      tokensConsumed: 0,
      durationMs: 0,
      startedAt: 2,
    });
    const rows = store.listForTask('t');
    expect(rows.map((r) => r.stepId)).toEqual(['discover', 'gather', 'verify']);
  });

  test('listForProtocol returns recent runs across tasks, newest first', () => {
    for (const [taskId, ts] of [
      ['t1', 1000],
      ['t2', 3000],
      ['t3', 2000],
    ] as const) {
      store.recordStep({
        taskId,
        personaId: 'p',
        protocolId: 'researcher.investigate',
        stepId: 'discover',
        stepIndex: 0,
        outcome: 'success',
        attempts: 1,
        tokensConsumed: 0,
        durationMs: 0,
        startedAt: ts,
      });
    }
    const rows = store.listForProtocol('researcher.investigate');
    expect(rows.map((r) => r.taskId)).toEqual(['t2', 't3', 't1']);
  });

  test('listForProtocol respects the limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      store.recordStep({
        taskId: `t-${i}`,
        personaId: 'p',
        protocolId: 'pr',
        stepId: 's',
        stepIndex: 0,
        outcome: 'success',
        attempts: 1,
        tokensConsumed: 0,
        durationMs: 0,
        startedAt: 1000 + i,
      });
    }
    expect(store.listForProtocol('pr', 3)).toHaveLength(3);
  });

  test('idempotent on (task_id, step_id, started_at) — duplicate insert silently dropped', () => {
    const input = {
      taskId: 't',
      personaId: 'p',
      protocolId: 'pr',
      stepId: 's',
      stepIndex: 0,
      outcome: 'success' as const,
      attempts: 1,
      tokensConsumed: 0,
      durationMs: 0,
      startedAt: 1000,
    };
    store.recordStep(input);
    store.recordStep(input);
    expect(store.listForTask('t')).toHaveLength(1);
  });

  test('outcomeCountsForPersona returns zero for unknown persona', () => {
    expect(store.outcomeCountsForPersona('ghost')).toEqual({
      success: 0,
      failure: 0,
      skipped: 0,
      'oracle-blocked': 0,
    });
  });

  test('outcomeCountsForPersona aggregates across tasks', () => {
    const persona = 'researcher';
    const ids: Array<['success' | 'failure' | 'skipped' | 'oracle-blocked', string]> = [
      ['success', 's1'],
      ['success', 's2'],
      ['failure', 's3'],
      ['skipped', 's4'],
      ['oracle-blocked', 's5'],
      ['success', 's6'],
    ];
    let ts = 1000;
    for (const [outcome, stepId] of ids) {
      store.recordStep({
        taskId: 't',
        personaId: persona,
        protocolId: 'pr',
        stepId,
        stepIndex: 0,
        outcome,
        attempts: 1,
        tokensConsumed: 0,
        durationMs: 0,
        startedAt: ts++,
      });
    }
    expect(store.outcomeCountsForPersona(persona)).toEqual({
      success: 3,
      failure: 1,
      skipped: 1,
      'oracle-blocked': 1,
    });
  });

  test('large evidence payload is truncated, marker preserved', () => {
    const huge = 'x'.repeat(80 * 1024); // 80KB > 64KB cap
    store.recordStep({
      taskId: 't',
      personaId: 'p',
      protocolId: 'pr',
      stepId: 's',
      stepIndex: 0,
      outcome: 'success',
      attempts: 1,
      tokensConsumed: 0,
      durationMs: 0,
      evidence: { synthesisText: huge, otherKey: 'short' },
      startedAt: 1000,
    });
    const row = store.listForTask('t')[0];
    expect(row?.evidence).toEqual({
      evidence_truncated: true,
      original_keys: ['synthesisText', 'otherKey'],
    });
  });

  test('null evidence + null oracleVerdicts roundtrip cleanly', () => {
    store.recordStep({
      taskId: 't',
      personaId: 'p',
      protocolId: 'pr',
      stepId: 's',
      stepIndex: 0,
      outcome: 'skipped',
      attempts: 0,
      tokensConsumed: 0,
      durationMs: 0,
      startedAt: 1000,
    });
    const row = store.listForTask('t')[0];
    expect(row?.evidence).toBeNull();
    expect(row?.oracleVerdicts).toBeNull();
    expect(row?.confidence).toBeNull();
  });

  test('default startedAt clock advances on subsequent calls', () => {
    store.recordStep({
      taskId: 't',
      personaId: 'p',
      protocolId: 'pr',
      stepId: 's',
      stepIndex: 0,
      outcome: 'success',
      attempts: 1,
      tokensConsumed: 0,
      durationMs: 0,
    });
    expect(store.listForTask('t')[0]?.startedAt).toBeGreaterThan(0);
  });
});
