/**
 * Tests for GatewayScheduleStore — reads/writes against gateway_schedules
 * (migration 006). First consumer; the schema was schema-only until W3 H3.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { GatewayScheduleStore } from '../../src/db/gateway-schedule-store.ts';
import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';
import { migration006 } from '../../src/db/migrations/006_gateway_tables.ts';
import { MigrationRunner } from '../../src/db/migrations/migration-runner.ts';
import { SCHEDULE_RUN_HISTORY_LIMIT, type ScheduledHypothesisTuple } from '../../src/gateway/scheduling/types.ts';

let db: Database;
let store: GatewayScheduleStore;

beforeEach(() => {
  db = new Database(':memory:');
  new MigrationRunner().migrate(db, [migration001, migration006]);
  store = new GatewayScheduleStore(db);
});

afterEach(() => {
  db.close();
});

function tuple(overrides: Partial<ScheduledHypothesisTuple> = {}): ScheduledHypothesisTuple {
  return {
    id: 'sched-1',
    profile: 'default',
    createdAt: 1_000,
    createdByHermesUserId: 'user-xyz',
    origin: { platform: 'slack', chatId: 'C1', threadKey: 'T2' },
    cron: '0 9 * * 1-5',
    timezone: 'UTC',
    nlOriginal: 'every weekday at 9am summarize backlog',
    goal: 'summarize backlog',
    constraints: { maxTokens: 2000 },
    confidenceAtCreation: 0.9,
    evidenceHash: 'hash-abc',
    status: 'active',
    failureStreak: 0,
    nextFireAt: 10_000,
    runHistory: [],
    ...overrides,
  };
}

describe('save + get', () => {
  test('round-trips a full tuple, preserving every field', () => {
    const t = tuple();
    store.save(t);
    const got = store.get(t.id, t.profile);
    expect(got).not.toBeNull();
    expect(got).toEqual(t);
  });

  test('save is idempotent (INSERT OR REPLACE)', () => {
    store.save(tuple({ goal: 'v1' }));
    store.save(tuple({ goal: 'v2' }));
    expect(store.get('sched-1', 'default')?.goal).toBe('v2');
  });
});

describe('profile scoping', () => {
  test('get() returns null when the profile does not match', () => {
    store.save(tuple({ profile: 'team-a' }));
    expect(store.get('sched-1', 'default')).toBeNull();
    expect(store.get('sched-1', 'team-a')).not.toBeNull();
  });

  test('listDueBefore only surfaces the requested profile', () => {
    store.save(tuple({ id: 's-a', profile: 'team-a', nextFireAt: 5 }));
    store.save(tuple({ id: 's-b', profile: 'team-b', nextFireAt: 5 }));
    const aOnly = store.listDueBefore('team-a', 1_000);
    expect(aOnly.map((t) => t.id)).toEqual(['s-a']);
  });
});

describe('listDueBefore ordering', () => {
  test('returns rows ordered by nextFireAt ascending', () => {
    store.save(tuple({ id: 's-mid', nextFireAt: 200 }));
    store.save(tuple({ id: 's-early', nextFireAt: 100 }));
    store.save(tuple({ id: 's-late', nextFireAt: 300 }));
    const rows = store.listDueBefore('default', 1_000);
    expect(rows.map((t) => t.id)).toEqual(['s-early', 's-mid', 's-late']);
  });

  test('ignores paused / failed-circuit / expired schedules', () => {
    store.save(tuple({ id: 's-active', nextFireAt: 100 }));
    store.save(tuple({ id: 's-paused', nextFireAt: 100, status: 'paused' }));
    store.save(tuple({ id: 's-exp', nextFireAt: 100, status: 'expired' }));
    store.save(tuple({ id: 's-cb', nextFireAt: 100, status: 'failed-circuit' }));
    const rows = store.listDueBefore('default', 1_000);
    expect(rows.map((t) => t.id)).toEqual(['s-active']);
  });
});

describe('updateRunHistory', () => {
  test('appends one entry', () => {
    store.save(tuple());
    store.updateRunHistory('sched-1', 'default', { ranAt: 1, taskId: 't1', outcome: 'completed' });
    const got = store.get('sched-1', 'default');
    expect(got?.runHistory.length).toBe(1);
    expect(got?.runHistory[0]?.taskId).toBe('t1');
  });

  test(`trims to the last ${SCHEDULE_RUN_HISTORY_LIMIT} entries`, () => {
    store.save(tuple());
    for (let i = 0; i < SCHEDULE_RUN_HISTORY_LIMIT + 5; i++) {
      store.updateRunHistory('sched-1', 'default', {
        ranAt: i,
        taskId: `t${i}`,
        outcome: 'completed',
      });
    }
    const got = store.get('sched-1', 'default');
    expect(got?.runHistory.length).toBe(SCHEDULE_RUN_HISTORY_LIMIT);
    // Oldest surviving entry is t5 because we overwrote 0..4.
    expect(got?.runHistory[0]?.taskId).toBe('t5');
    expect(got?.runHistory[SCHEDULE_RUN_HISTORY_LIMIT - 1]?.taskId).toBe(`t${SCHEDULE_RUN_HISTORY_LIMIT + 4}`);
  });
});

describe('setStatus + setNextFire', () => {
  test('setStatus is profile-scoped and persists', () => {
    store.save(tuple());
    store.setStatus('sched-1', 'default', 'paused');
    expect(store.get('sched-1', 'default')?.status).toBe('paused');
  });

  test('setNextFire writes null to pause firing', () => {
    store.save(tuple());
    store.setNextFire('sched-1', 'default', null);
    expect(store.get('sched-1', 'default')?.nextFireAt).toBeNull();
  });
});
