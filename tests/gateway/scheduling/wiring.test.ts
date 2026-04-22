/**
 * Tests for setupScheduleRunner — factory-layer wiring helper.
 *
 * Confirms:
 *   - Minimal deps produce a working handle with a GatewayScheduleStore.
 *   - start() / stop() lifecycle is idempotent and does not throw.
 *   - MarketScheduler hook is preferred when present (registerTickHook called).
 *   - Without MarketScheduler, a local timer drives ticks (stop() clears it).
 *   - deliverReply path forwards messaging-origin replies to the lifecycle;
 *     CLI-origin replies skip the lifecycle.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { migration001 } from '../../../src/db/migrations/001_initial_schema.ts';
import { migration006 } from '../../../src/db/migrations/006_gateway_tables.ts';
import { MigrationRunner } from '../../../src/db/migrations/migration-runner.ts';
import type { MarketScheduler } from '../../../src/economy/market/market-scheduler.ts';
import type { MessagingAdapterLifecycleManager } from '../../../src/gateway/lifecycle.ts';
import type { ScheduledHypothesisTuple } from '../../../src/gateway/scheduling/types.ts';
import { setupScheduleRunner } from '../../../src/gateway/scheduling/wiring.ts';
import type { GatewayDeliveryReceipt, GatewayOutboundEnvelope } from '../../../src/gateway/types.ts';
import type { TaskInput, TaskResult } from '../../../src/orchestrator/types.ts';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  new MigrationRunner().migrate(db, [migration001, migration006]);
});

afterEach(() => {
  db.close();
});

function makeTuple(overrides: Partial<ScheduledHypothesisTuple> = {}): ScheduledHypothesisTuple {
  return {
    id: 'sched-wiring-1',
    profile: 'default',
    createdAt: 1_000,
    createdByHermesUserId: null,
    origin: { platform: 'cli', chatId: null },
    cron: '0 9 * * *',
    timezone: 'UTC',
    nlOriginal: 'daily at 9am ping',
    goal: 'ping',
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
    answer: 'ok',
    ...overrides,
  };
}

const noopLog = (): ((level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void) => {
  return () => undefined;
};

describe('setupScheduleRunner — handle', () => {
  test('returns a handle with runner + store given minimal deps', () => {
    const handle = setupScheduleRunner({
      db,
      executeTask: async () => makeResult(),
      log: noopLog(),
    });

    expect(handle.runner).toBeDefined();
    expect(handle.store).toBeDefined();
    expect(typeof handle.start).toBe('function');
    expect(typeof handle.stop).toBe('function');
  });

  test('handle.store can persist and recall a schedule', () => {
    const handle = setupScheduleRunner({
      db,
      executeTask: async () => makeResult(),
      log: noopLog(),
    });
    handle.store.save(makeTuple({ id: 'w1' }));
    expect(handle.store.get('w1', 'default')?.goal).toBe('ping');
  });
});

describe('setupScheduleRunner — lifecycle', () => {
  test('start/stop without MarketScheduler falls back to local timer', () => {
    const handle = setupScheduleRunner({
      db,
      executeTask: async () => makeResult(),
      log: noopLog(),
      tickIntervalMs: 10_000,
    });
    handle.start();
    // Stopping must be safe even with the fallback timer active.
    expect(() => handle.stop()).not.toThrow();
    // Restart after stop is allowed.
    handle.start();
    handle.stop();
  });

  test('MarketScheduler.registerTickHook is called when provided', () => {
    let hookCalls = 0;
    let unregistered = false;
    const fakeMarket = {
      registerTickHook: (_fn: () => void | Promise<void>) => {
        hookCalls++;
        return () => {
          unregistered = true;
        };
      },
    } as unknown as MarketScheduler;

    const handle = setupScheduleRunner({
      db,
      executeTask: async () => makeResult(),
      log: noopLog(),
      marketScheduler: fakeMarket,
    });

    handle.start();
    expect(hookCalls).toBe(1);
    handle.stop();
    expect(unregistered).toBe(true);
  });
});

describe('setupScheduleRunner — reply routing', () => {
  test('CLI-origin schedule skips lifecycle.deliver', async () => {
    const fires: TaskInput[] = [];
    const delivered: GatewayOutboundEnvelope[] = [];
    const fakeLifecycle = {
      deliver: async (env: GatewayOutboundEnvelope): Promise<GatewayDeliveryReceipt> => {
        delivered.push(env);
        return { ok: true };
      },
    } as unknown as MessagingAdapterLifecycleManager;

    const handle = setupScheduleRunner({
      db,
      executeTask: async (input) => {
        fires.push(input);
        return makeResult();
      },
      lifecycle: fakeLifecycle,
      log: noopLog(),
    });
    handle.store.save(makeTuple({ id: 'cli-1', nextFireAt: 5_000 }));

    const fired = await handle.runner.tickAt(10_000);
    expect(fired).toBe(1);
    expect(delivered.length).toBe(0);
  });

  test('messaging-origin schedule dispatches through lifecycle.deliver', async () => {
    const delivered: GatewayOutboundEnvelope[] = [];
    const fakeLifecycle = {
      deliver: async (env: GatewayOutboundEnvelope): Promise<GatewayDeliveryReceipt> => {
        delivered.push(env);
        return { ok: true };
      },
    } as unknown as MessagingAdapterLifecycleManager;

    const handle = setupScheduleRunner({
      db,
      executeTask: async () => makeResult({ answer: 'done' }),
      lifecycle: fakeLifecycle,
      log: noopLog(),
    });
    handle.store.save(
      makeTuple({
        id: 'tg-1',
        nextFireAt: 5_000,
        origin: { platform: 'telegram', chatId: 'chat-9' },
      }),
    );

    await handle.runner.tickAt(10_000);
    expect(delivered.length).toBe(1);
    expect(delivered[0]!.platform).toBe('telegram');
    expect(delivered[0]!.chatId).toBe('chat-9');
    expect(delivered[0]!.text).toBe('done');
  });

  test('messaging-origin schedule without lifecycle drops reply (logged only)', async () => {
    const logs: Array<{ level: string; msg: string }> = [];
    const handle = setupScheduleRunner({
      db,
      executeTask: async () => makeResult(),
      log: (level, msg) => {
        logs.push({ level, msg });
      },
    });
    handle.store.save(
      makeTuple({
        id: 'tg-2',
        nextFireAt: 5_000,
        origin: { platform: 'telegram', chatId: 'chat-9' },
      }),
    );

    await handle.runner.tickAt(10_000);
    expect(logs.some((l) => l.msg.includes('no messaging lifecycle'))).toBe(true);
  });
});
