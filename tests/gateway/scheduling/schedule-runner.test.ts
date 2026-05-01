/**
 * Tests for ScheduleRunner — tick-driven firing with circuit-breaker.
 *
 * Uses an in-memory SQLite (migration001 + migration001) so the tests
 * exercise the real GatewayScheduleStore instead of a stub.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { GatewayScheduleStore } from '../../../src/db/gateway-schedule-store.ts';
import { migration001 } from '../../../src/db/migrations/001_initial_schema.ts';
import { MigrationRunner } from '../../../src/db/migrations/migration-runner.ts';
import {
  type MarketSchedulerTickApi,
  ScheduleRunner,
  type ScheduleRunnerDeps,
} from '../../../src/gateway/scheduling/schedule-runner.ts';
import {
  SCHEDULE_FAILURE_CIRCUIT_STREAK,
  type ScheduledHypothesisTuple,
} from '../../../src/gateway/scheduling/types.ts';
import type { TaskInput, TaskResult } from '../../../src/orchestrator/types.ts';

let db: Database;
let store: GatewayScheduleStore;

beforeEach(() => {
  db = new Database(':memory:');
  new MigrationRunner().migrate(db, [migration001]);
  store = new GatewayScheduleStore(db);
});

afterEach(() => {
  db.close();
});

function makeTuple(overrides: Partial<ScheduledHypothesisTuple> = {}): ScheduledHypothesisTuple {
  return {
    id: overrides.id ?? 'sched-1',
    profile: 'default',
    createdAt: 1_000,
    createdByHermesUserId: null,
    origin: { platform: 'cli', chatId: null },
    cron: '0 9 * * *',
    timezone: 'UTC',
    nlOriginal: 'daily at 9am send stand-up summary',
    goal: 'send stand-up summary',
    constraints: {},
    confidenceAtCreation: 0.9,
    evidenceHash: 'hash-1',
    status: 'active',
    failureStreak: 0,
    nextFireAt: 5_000,
    runHistory: [],
    ...overrides,
  };
}

function makeResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    id: 'task-1',
    status: 'completed',
    mutations: [],
    trace: { events: [] } as unknown as TaskResult['trace'],
    ...overrides,
  };
}

function baseDeps(partial: Partial<ScheduleRunnerDeps> = {}): ScheduleRunnerDeps {
  return {
    store,
    executeTask: async () => makeResult(),
    deliverReply: async () => undefined,
    uuid: () => 'uuid-1',
    ...partial,
  };
}

describe('ScheduleRunner — firing', () => {
  test('fires every due schedule and advances nextFireAt', async () => {
    store.save(makeTuple({ id: 's1', nextFireAt: 5_000 }));
    store.save(makeTuple({ id: 's2', nextFireAt: 6_000 }));
    // Schedule in the future — should NOT fire.
    store.save(makeTuple({ id: 's3', nextFireAt: Date.UTC(2099, 0, 1) }));

    const fires: TaskInput[] = [];
    const runner = new ScheduleRunner(
      baseDeps({
        executeTask: async (input) => {
          fires.push(input);
          return makeResult();
        },
      }),
    );

    const fired = await runner.tickAt(10_000);
    expect(fired).toBe(2);
    expect(fires.map((f) => f.goal).sort()).toEqual(['send stand-up summary', 'send stand-up summary']);
    expect(fires[0]?.source).toBe('gateway-cron');
    expect(fires[0]?.profile).toBe('default');

    const s1 = store.get('s1', 'default');
    expect(s1?.runHistory.length).toBe(1);
    // nextFireAt is moved forward (some future epoch); exact value depends
    // on the evaluator, but must be > the tick time.
    expect(s1?.nextFireAt).not.toBeNull();
    expect(s1!.nextFireAt!).toBeGreaterThan(10_000);
  });

  test('deliverReply is invoked with the schedule and the task result', async () => {
    store.save(makeTuple({ id: 's1', nextFireAt: 5_000 }));

    const received: Array<{ id: string; status: TaskResult['status'] }> = [];
    const runner = new ScheduleRunner(
      baseDeps({
        deliverReply: async (schedule, result) => {
          received.push({ id: schedule.id, status: result.status });
        },
      }),
    );

    await runner.tickAt(10_000);
    expect(received).toEqual([{ id: 's1', status: 'completed' }]);
  });

  test('success resets failureStreak to 0', async () => {
    store.save(makeTuple({ id: 's1', nextFireAt: 5_000, failureStreak: 3 }));

    const runner = new ScheduleRunner(baseDeps());
    await runner.tickAt(10_000);

    const s1 = store.get('s1', 'default');
    expect(s1?.failureStreak).toBe(0);
  });
});

describe('ScheduleRunner — circuit breaker', () => {
  test('flips status to failed-circuit after 5 consecutive failures', async () => {
    store.save(makeTuple({ id: 's1', nextFireAt: 5_000, failureStreak: 4 }));
    const runner = new ScheduleRunner(
      baseDeps({
        executeTask: async () => makeResult({ status: 'failed' }),
      }),
    );

    await runner.tickAt(10_000);
    const s1 = store.get('s1', 'default');
    expect(s1?.status).toBe('failed-circuit');
    expect(s1?.failureStreak).toBeGreaterThanOrEqual(SCHEDULE_FAILURE_CIRCUIT_STREAK);
    expect(s1?.nextFireAt).toBeNull();
  });

  test('executeTask throwing counts as a failure', async () => {
    store.save(makeTuple({ id: 's1', nextFireAt: 5_000, failureStreak: 0 }));
    const runner = new ScheduleRunner(
      baseDeps({
        executeTask: async () => {
          throw new Error('boom');
        },
      }),
    );
    await runner.tickAt(10_000);
    const s1 = store.get('s1', 'default');
    expect(s1?.failureStreak).toBe(1);
    expect(s1?.runHistory[0]?.outcome).toContain('threw');
  });
});

describe('ScheduleRunner — lifecycle', () => {
  test('start registers with MarketScheduler hook when available', () => {
    let registered = false;
    let unregistered = false;
    const market: MarketSchedulerTickApi = {
      registerTickHook: () => {
        registered = true;
        return () => {
          unregistered = true;
        };
      },
    };
    const runner = new ScheduleRunner(baseDeps({ marketScheduler: market }));
    runner.start();
    expect(registered).toBe(true);
    runner.stop();
    expect(unregistered).toBe(true);
  });

  test('double start is a no-op', () => {
    let calls = 0;
    const market: MarketSchedulerTickApi = {
      registerTickHook: () => {
        calls++;
        return () => undefined;
      },
    };
    const runner = new ScheduleRunner(baseDeps({ marketScheduler: market }));
    runner.start();
    runner.start();
    expect(calls).toBe(1);
    runner.stop();
  });

  test('falls back to a local timer when no MarketScheduler is provided', () => {
    const runner = new ScheduleRunner(baseDeps({ tickIntervalMs: 10_000 }));
    runner.start();
    // If we got here without throwing, the timer registered. `stop()` must clear it.
    runner.stop();
    // Starting again after stop is allowed.
    runner.start();
    runner.stop();
  });
});
