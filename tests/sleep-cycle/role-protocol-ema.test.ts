/**
 * Tests for `computeStepSuccessEMAs` — Phase A3-followup.
 *
 * Behavior-only: every assertion exercises the pure function against a
 * real `RoleProtocolRunStore` populated with synthetic rows. Verifies
 * the documented EMA contract.
 *
 * Coverage:
 *   - empty store + empty protocol list → []
 *   - undefined protocol list → [] (best-effort scoping)
 *   - tuple below minObservations is excluded
 *   - 'skipped' rows excluded from observations
 *   - all-success tuple → ema near 1
 *   - all-failure tuple → ema near 0
 *   - oracle-blocked counts as failure
 *   - chronological order: recent successes after older failures lift EMA
 *   - alpha boundary: alpha=1 means "only newest sample"
 *   - alpha range guard: throws on alpha=0 or alpha>1
 *   - sorted output (persona, protocol, step)
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { RoleProtocolRunStore, type RoleProtocolStepOutcome } from '../../src/db/role-protocol-run-store.ts';
import { computeStepSuccessEMAs } from '../../src/sleep-cycle/role-protocol-ema.ts';

let db: Database;
let store: RoleProtocolRunStore;

beforeEach(() => {
  db = new Database(':memory:');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  store = new RoleProtocolRunStore(db);
});

interface SeedRow {
  taskId: string;
  personaId: string;
  protocolId: string;
  stepId: string;
  outcome: RoleProtocolStepOutcome;
  startedAt: number;
}

function seed(rows: SeedRow[]): void {
  for (const r of rows) {
    store.recordStep({
      taskId: r.taskId,
      personaId: r.personaId,
      protocolId: r.protocolId,
      stepId: r.stepId,
      stepIndex: 0,
      outcome: r.outcome,
      attempts: 1,
      tokensConsumed: 0,
      durationMs: 0,
      startedAt: r.startedAt,
    });
  }
}

describe('computeStepSuccessEMAs — empty inputs', () => {
  test('empty store + empty protocol list returns []', () => {
    expect(computeStepSuccessEMAs(store, [])).toEqual([]);
  });

  test('undefined protocol list returns [] (caller must scope explicitly)', () => {
    seed([{ taskId: 't', personaId: 'p', protocolId: 'pr', stepId: 's', outcome: 'success', startedAt: 1 }]);
    expect(computeStepSuccessEMAs(store, undefined)).toEqual([]);
  });

  test('protocol with no rows returns []', () => {
    expect(computeStepSuccessEMAs(store, ['unknown.protocol'])).toEqual([]);
  });
});

describe('computeStepSuccessEMAs — observation threshold', () => {
  test('tuple below minObservations is excluded', () => {
    // 4 rows, threshold 5
    seed(
      [1, 2, 3, 4].map((i) => ({
        taskId: `t${i}`,
        personaId: 'p',
        protocolId: 'pr',
        stepId: 's',
        outcome: 'success' as const,
        startedAt: i,
      })),
    );
    expect(computeStepSuccessEMAs(store, ['pr'], { minObservations: 5 })).toEqual([]);
  });

  test('tuple meeting minObservations is included', () => {
    seed(
      [1, 2, 3, 4, 5].map((i) => ({
        taskId: `t${i}`,
        personaId: 'p',
        protocolId: 'pr',
        stepId: 's',
        outcome: 'success' as const,
        startedAt: i,
      })),
    );
    const out = computeStepSuccessEMAs(store, ['pr'], { minObservations: 5 });
    expect(out).toHaveLength(1);
  });
});

describe('computeStepSuccessEMAs — outcome scoring', () => {
  test('skipped rows excluded from observations', () => {
    seed([
      { taskId: 't1', personaId: 'p', protocolId: 'pr', stepId: 's', outcome: 'success', startedAt: 1 },
      { taskId: 't2', personaId: 'p', protocolId: 'pr', stepId: 's', outcome: 'skipped', startedAt: 2 },
      { taskId: 't3', personaId: 'p', protocolId: 'pr', stepId: 's', outcome: 'success', startedAt: 3 },
      { taskId: 't4', personaId: 'p', protocolId: 'pr', stepId: 's', outcome: 'success', startedAt: 4 },
      { taskId: 't5', personaId: 'p', protocolId: 'pr', stepId: 's', outcome: 'success', startedAt: 5 },
      { taskId: 't6', personaId: 'p', protocolId: 'pr', stepId: 's', outcome: 'success', startedAt: 6 },
    ]);
    const out = computeStepSuccessEMAs(store, ['pr'], { minObservations: 5 });
    expect(out).toHaveLength(1);
    expect(out[0]?.observations).toBe(5); // skipped row excluded
    expect(out[0]?.successes).toBe(5);
    expect(out[0]?.ema).toBeCloseTo(1, 5);
  });

  test('all-success tuple → ema = 1', () => {
    seed(
      [1, 2, 3, 4, 5].map((i) => ({
        taskId: `t${i}`,
        personaId: 'p',
        protocolId: 'pr',
        stepId: 's',
        outcome: 'success' as const,
        startedAt: i,
      })),
    );
    const out = computeStepSuccessEMAs(store, ['pr'], { minObservations: 5 });
    expect(out[0]?.ema).toBe(1);
  });

  test('all-failure tuple → ema = 0', () => {
    seed(
      [1, 2, 3, 4, 5].map((i) => ({
        taskId: `t${i}`,
        personaId: 'p',
        protocolId: 'pr',
        stepId: 's',
        outcome: 'failure' as const,
        startedAt: i,
      })),
    );
    const out = computeStepSuccessEMAs(store, ['pr'], { minObservations: 5 });
    expect(out[0]?.ema).toBe(0);
    expect(out[0]?.successes).toBe(0);
  });

  test('oracle-blocked counts as failure', () => {
    seed(
      [1, 2, 3, 4, 5].map((i) => ({
        taskId: `t${i}`,
        personaId: 'p',
        protocolId: 'pr',
        stepId: 's',
        outcome: 'oracle-blocked' as const,
        startedAt: i,
      })),
    );
    const out = computeStepSuccessEMAs(store, ['pr'], { minObservations: 5 });
    expect(out[0]?.ema).toBe(0);
    expect(out[0]?.successes).toBe(0);
  });
});

describe('computeStepSuccessEMAs — chronological dynamics', () => {
  test('recent successes after older failures lift EMA above naive average', () => {
    // 3 failures then 3 successes — naive average = 0.5
    // EMA with alpha=0.5 should be much higher because newest dominate.
    seed(
      [
        { outcome: 'failure', startedAt: 1 },
        { outcome: 'failure', startedAt: 2 },
        { outcome: 'failure', startedAt: 3 },
        { outcome: 'success', startedAt: 4 },
        { outcome: 'success', startedAt: 5 },
        { outcome: 'success', startedAt: 6 },
      ].map((r, i) => ({
        taskId: `t${i}`,
        personaId: 'p',
        protocolId: 'pr',
        stepId: 's',
        outcome: r.outcome as RoleProtocolStepOutcome,
        startedAt: r.startedAt,
      })),
    );
    const out = computeStepSuccessEMAs(store, ['pr'], { alpha: 0.5, minObservations: 5 });
    expect(out[0]?.ema).toBeGreaterThan(0.5);
    expect(out[0]?.successes).toBe(3);
    expect(out[0]?.observations).toBe(6);
  });

  test('alpha=1 means "only newest sample"', () => {
    seed([
      { taskId: 't1', personaId: 'p', protocolId: 'pr', stepId: 's', outcome: 'success', startedAt: 1 },
      { taskId: 't2', personaId: 'p', protocolId: 'pr', stepId: 's', outcome: 'success', startedAt: 2 },
      { taskId: 't3', personaId: 'p', protocolId: 'pr', stepId: 's', outcome: 'success', startedAt: 3 },
      { taskId: 't4', personaId: 'p', protocolId: 'pr', stepId: 's', outcome: 'success', startedAt: 4 },
      { taskId: 't5', personaId: 'p', protocolId: 'pr', stepId: 's', outcome: 'failure', startedAt: 5 },
    ]);
    const out = computeStepSuccessEMAs(store, ['pr'], { alpha: 1, minObservations: 5 });
    expect(out[0]?.ema).toBe(0); // newest sample is failure, alpha=1 → ema = 0
  });

  test('throws on alpha out of (0, 1]', () => {
    expect(() => computeStepSuccessEMAs(store, ['pr'], { alpha: 0 })).toThrow('alpha must be in (0, 1]');
    expect(() => computeStepSuccessEMAs(store, ['pr'], { alpha: 1.5 })).toThrow('alpha must be in (0, 1]');
    expect(() => computeStepSuccessEMAs(store, ['pr'], { alpha: -0.1 })).toThrow('alpha must be in (0, 1]');
  });
});

describe('computeStepSuccessEMAs — multi-tuple output', () => {
  test('separate tuples for different (persona, protocol, step) keys', () => {
    seed([
      ...[1, 2, 3, 4, 5].map((i) => ({
        taskId: `a${i}`,
        personaId: 'researcher',
        protocolId: 'researcher.investigate',
        stepId: 'discover',
        outcome: 'success' as const,
        startedAt: i,
      })),
      ...[1, 2, 3, 4, 5].map((i) => ({
        taskId: `b${i}`,
        personaId: 'researcher',
        protocolId: 'researcher.investigate',
        stepId: 'gather',
        outcome: 'failure' as const,
        startedAt: i + 10,
      })),
      ...[1, 2, 3, 4, 5].map((i) => ({
        taskId: `c${i}`,
        personaId: 'developer',
        protocolId: 'researcher.investigate',
        stepId: 'discover',
        outcome: 'success' as const,
        startedAt: i + 20,
      })),
    ]);
    const out = computeStepSuccessEMAs(store, ['researcher.investigate'], { minObservations: 5 });
    expect(out).toHaveLength(3);
    // Sort order: (personaId, protocolId, stepId)
    expect(out.map((r) => `${r.personaId}/${r.stepId}`)).toEqual([
      'developer/discover',
      'researcher/discover',
      'researcher/gather',
    ]);
  });

  test('protocolIds scope: only requested protocols are mined', () => {
    seed([
      ...[1, 2, 3, 4, 5].map((i) => ({
        taskId: `a${i}`,
        personaId: 'p',
        protocolId: 'wanted',
        stepId: 's',
        outcome: 'success' as const,
        startedAt: i,
      })),
      ...[1, 2, 3, 4, 5].map((i) => ({
        taskId: `b${i}`,
        personaId: 'p',
        protocolId: 'unwanted',
        stepId: 's',
        outcome: 'success' as const,
        startedAt: i + 10,
      })),
    ]);
    const out = computeStepSuccessEMAs(store, ['wanted'], { minObservations: 5 });
    expect(out).toHaveLength(1);
    expect(out[0]?.protocolId).toBe('wanted');
  });
});
