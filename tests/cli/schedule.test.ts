/**
 * Tests for `vinyan schedule` CLI — create / list / show / delete.
 *
 * Strategy: invoke `runScheduleCommand` directly with a `:memory:` DB and
 * captured stdout/stderr/exit. Avoids spawning subprocesses so the tests
 * run in the default unit tier.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runScheduleCommand, type ScheduleCommandDeps } from '../../src/cli/schedule.ts';
import { GatewayScheduleStore } from '../../src/db/gateway-schedule-store.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';

class ExitCalled extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`);
  }
}

interface Harness {
  stdout: string[];
  stderr: string[];
  exitCode?: number;
  deps: Pick<ScheduleCommandDeps, 'stdout' | 'stderr' | 'exit'>;
}

function makeHarness(): Harness {
  const h: Partial<Harness> & Pick<Harness, 'stdout' | 'stderr'> = { stdout: [], stderr: [] };
  h.deps = {
    stdout: (c: string) => h.stdout.push(c),
    stderr: (c: string) => h.stderr.push(c),
    exit: ((code: number) => {
      (h as Harness).exitCode = code;
      throw new ExitCalled(code);
    }) as (code: number) => never,
  };
  return h as Harness;
}

async function runAndCatchExit(argv: readonly string[], deps: ScheduleCommandDeps): Promise<void> {
  try {
    await runScheduleCommand(argv, deps);
  } catch (e) {
    if (!(e instanceof ExitCalled)) throw e;
  }
}

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
});

afterEach(() => {
  db.close();
});

describe('runScheduleCommand — create', () => {
  test('parses NL text, persists a tuple, and prints the created id', async () => {
    const h = makeHarness();
    const ids = ['test-schedule-1'];
    const fixedNow = Date.UTC(2026, 3, 21, 8, 0); // Tue 2026-04-21 08:00 UTC

    await runAndCatchExit(['create', 'every weekday at 9am summarize open PRs'], {
      db,
      profile: 'default',
      clock: () => fixedNow,
      uuid: () => ids.shift() as string,
      defaultTimezone: 'UTC',
      ...h.deps,
    });

    const store = new GatewayScheduleStore(db);
    const tuple = store.get('test-schedule-1', 'default');
    expect(tuple).not.toBeNull();
    expect(tuple?.cron).toBe('0 9 * * 1-5');
    expect(tuple?.timezone).toBe('UTC');
    expect(tuple?.goal.toLowerCase()).toContain('summarize open prs');
    expect(tuple?.status).toBe('active');
    expect(tuple?.nextFireAt).toBeGreaterThan(fixedNow);
    expect(tuple?.evidenceHash.length).toBeGreaterThan(0);

    const out = h.stdout.join('');
    expect(out).toContain('Schedule created: test-schedule-1');
    expect(out).toContain('0 9 * * 1-5');
  });

  test('non-schedule NL text is rejected with non-zero exit', async () => {
    const h = makeHarness();
    await runAndCatchExit(['create', 'refactor the user module'], {
      db,
      profile: 'default',
      ...h.deps,
    });
    expect(h.exitCode).toBe(1);
    expect(h.stderr.join('')).toMatch(/Not a schedule request/);
  });

  test('ambiguous time → clean failure', async () => {
    const h = makeHarness();
    await runAndCatchExit(['create', 'every day at noon do something'], {
      db,
      profile: 'default',
      ...h.deps,
    });
    expect(h.exitCode).toBe(1);
    expect(h.stderr.join('')).toMatch(/Schedule interpretation failed/);
  });

  test('missing NL text exits 2', async () => {
    const h = makeHarness();
    await runAndCatchExit(['create'], { db, profile: 'default', ...h.deps });
    expect(h.exitCode).toBe(2);
  });
});

describe('runScheduleCommand — list', () => {
  test('lists saved schedules across statuses', async () => {
    const store = new GatewayScheduleStore(db);
    store.save({
      id: 'sched-a',
      profile: 'default',
      createdAt: 1000,
      createdByHermesUserId: null,
      origin: { platform: 'cli', chatId: null },
      cron: '0 9 * * 1-5',
      timezone: 'UTC',
      nlOriginal: 'weekday at 9',
      goal: 'ping',
      constraints: {},
      confidenceAtCreation: 0.9,
      evidenceHash: 'h',
      status: 'active',
      failureStreak: 0,
      nextFireAt: 2000,
      runHistory: [],
    });
    store.save({
      id: 'sched-b',
      profile: 'default',
      createdAt: 1001,
      createdByHermesUserId: null,
      origin: { platform: 'cli', chatId: null },
      cron: '0 10 * * *',
      timezone: 'UTC',
      nlOriginal: 'daily at 10',
      goal: 'broom',
      constraints: {},
      confidenceAtCreation: 0.9,
      evidenceHash: 'h2',
      status: 'expired',
      failureStreak: 0,
      nextFireAt: null,
      runHistory: [],
    });

    const h = makeHarness();
    await runAndCatchExit(['list'], { db, profile: 'default', ...h.deps });
    const out = h.stdout.join('');
    expect(out).toContain('sched-a');
    expect(out).toContain('sched-b');
    expect(out).toContain('status=active');
    expect(out).toContain('status=expired');
  });

  test('empty list prints a friendly message', async () => {
    const h = makeHarness();
    await runAndCatchExit(['list'], { db, profile: 'default', ...h.deps });
    expect(h.stdout.join('')).toMatch(/No schedules for profile "default"/);
  });
});

describe('runScheduleCommand — delete', () => {
  test('delete flips status to expired', async () => {
    const store = new GatewayScheduleStore(db);
    store.save({
      id: 'del-1',
      profile: 'default',
      createdAt: 1000,
      createdByHermesUserId: null,
      origin: { platform: 'cli', chatId: null },
      cron: '0 9 * * *',
      timezone: 'UTC',
      nlOriginal: 'daily at 9',
      goal: 'ping',
      constraints: {},
      confidenceAtCreation: 0.9,
      evidenceHash: 'h',
      status: 'active',
      failureStreak: 0,
      nextFireAt: 2000,
      runHistory: [],
    });

    const h = makeHarness();
    await runAndCatchExit(['delete', 'del-1'], { db, profile: 'default', ...h.deps });
    expect(store.get('del-1', 'default')?.status).toBe('expired');
    expect(h.stdout.join('')).toContain('expired');
  });

  test('delete on missing id exits 1', async () => {
    const h = makeHarness();
    await runAndCatchExit(['delete', 'nope'], { db, profile: 'default', ...h.deps });
    expect(h.exitCode).toBe(1);
  });
});

describe('runScheduleCommand — show', () => {
  test('show prints pretty-printed JSON for a known id', async () => {
    const store = new GatewayScheduleStore(db);
    store.save({
      id: 'show-1',
      profile: 'default',
      createdAt: 1000,
      createdByHermesUserId: null,
      origin: { platform: 'cli', chatId: null },
      cron: '0 9 * * *',
      timezone: 'UTC',
      nlOriginal: 'daily at 9',
      goal: 'ping',
      constraints: {},
      confidenceAtCreation: 0.9,
      evidenceHash: 'h',
      status: 'active',
      failureStreak: 0,
      nextFireAt: 2000,
      runHistory: [],
    });
    const h = makeHarness();
    await runAndCatchExit(['show', 'show-1'], { db, profile: 'default', ...h.deps });
    const out = h.stdout.join('');
    const parsed = JSON.parse(out);
    expect(parsed.id).toBe('show-1');
    expect(parsed.cron).toBe('0 9 * * *');
  });
});

describe('runScheduleCommand — profile isolation', () => {
  test('schedule in profile A is not visible from profile B', async () => {
    const hA1 = makeHarness();
    await runAndCatchExit(['create', 'every weekday at 9am summarize open PRs'], {
      db,
      profile: 'profile-a',
      uuid: () => 'iso-1',
      clock: () => Date.UTC(2026, 3, 21, 8, 0),
      defaultTimezone: 'UTC',
      ...hA1.deps,
    });

    const hB = makeHarness();
    await runAndCatchExit(['list'], { db, profile: 'profile-b', ...hB.deps });
    expect(hB.stdout.join('')).toMatch(/No schedules for profile "profile-b"/);

    const hA2 = makeHarness();
    await runAndCatchExit(['list'], { db, profile: 'profile-a', ...hA2.deps });
    expect(hA2.stdout.join('')).toContain('iso-1');
  });
});
