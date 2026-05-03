/**
 * Memory Wiki — scheduler contract.
 *
 * Pins the periodic NREM consolidation + lint loop. Uses an in-test
 * fake timer so we can advance virtual time deterministically without
 * waiting for wall-clock hours.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migration001 } from '../../../src/db/migrations/001_initial_schema.ts';
import { MigrationRunner } from '../../../src/db/migrations/migration-runner.ts';
import { MemoryWikiConsolidation } from '../../../src/memory/wiki/consolidation.ts';
import { MemoryWikiLint } from '../../../src/memory/wiki/lint.ts';
import { PageWriter } from '../../../src/memory/wiki/page-writer.ts';
import { MemoryWikiStore } from '../../../src/memory/wiki/store.ts';
import { startWikiScheduler } from '../../../src/memory/wiki/wiki-scheduler.ts';

function freshDb(): Database {
  const db = new Database(':memory:');
  new MigrationRunner().migrate(db, [migration001]);
  return db;
}

interface FakeTimer {
  fn: () => void;
  delay: number;
}

function fakeTimers() {
  let nextId = 1;
  const queue = new Map<number, FakeTimer>();
  const setT = (fn: () => void, delay: number) => {
    const id = nextId++;
    queue.set(id, { fn, delay });
    return { id, unref: () => {} } as { id: number; unref(): void };
  };
  const clearT = (h: { unref?: () => void }) => {
    const id = (h as { id?: number }).id;
    if (typeof id === 'number') queue.delete(id);
  };
  /** Fire and remove the next pending timer (smallest id). */
  const drainNext = (): boolean => {
    const next = [...queue.entries()].sort((a, b) => a[0] - b[0])[0];
    if (!next) return false;
    queue.delete(next[0]);
    next[1].fn();
    return true;
  };
  const drainAll = (max = 20): number => {
    let count = 0;
    while (count < max && drainNext()) count++;
    return count;
  };
  return { setT, clearT, drainNext, drainAll, queue };
}

describe('startWikiScheduler', () => {
  test('initial delay then periodic tick — runs consolidation + lint', async () => {
    const db = freshDb();
    const clock = () => 1_700_000_000_000;
    const store = new MemoryWikiStore(db, { clock });
    const writer = new PageWriter({ store, clock });
    const consolidation = new MemoryWikiConsolidation({ store, writer, clock });
    const lint = new MemoryWikiLint({ store, clock });
    const timers = fakeTimers();

    const consolidationReports: number[] = [];
    const lintResults: number[] = [];
    const sched = startWikiScheduler({
      consolidation,
      lint,
      defaultProfile: 'default',
      consolidationIntervalMs: 1000,
      lintIntervalMs: 2000,
      initialDelayMs: 100,
      setTimeoutImpl: timers.setT,
      clearTimeoutImpl: timers.clearT,
      onConsolidation: (r) => consolidationReports.push(r.scanned),
      onLint: (r) => lintResults.push(r.scanned),
    });

    // Two pending timers: consolidation (delay 100), lint (delay 600).
    expect(timers.queue.size).toBe(2);

    // Drain initial consolidation + lint timers.
    timers.drainAll();
    // Async consolidation report — yield event loop to let promises settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(sched.stats.consolidationTicks).toBeGreaterThanOrEqual(1);
    expect(sched.stats.lintTicks).toBeGreaterThanOrEqual(1);
    expect(consolidationReports.length).toBeGreaterThanOrEqual(1);
    expect(lintResults.length).toBeGreaterThanOrEqual(1);

    sched.stop();
    expect(timers.queue.size).toBe(0);
  });

  test('consolidation throw goes through onError + scheduler keeps ticking', async () => {
    const db = freshDb();
    const clock = () => 1_700_000_000_000;
    const store = new MemoryWikiStore(db, { clock });
    const writer = new PageWriter({ store, clock });
    const lint = new MemoryWikiLint({ store, clock });
    let calls = 0;
    const consolidation = {
      run: async () => {
        calls += 1;
        throw new Error('simulated consolidation failure');
      },
    } as unknown as MemoryWikiConsolidation;

    const timers = fakeTimers();
    const errors: string[] = [];
    const sched = startWikiScheduler({
      consolidation,
      lint,
      defaultProfile: 'default',
      consolidationIntervalMs: 100,
      lintIntervalMs: 200,
      initialDelayMs: 10,
      setTimeoutImpl: timers.setT,
      clearTimeoutImpl: timers.clearT,
      onError: (op) => errors.push(op),
    });

    timers.drainAll(5);
    await Promise.resolve();
    await Promise.resolve();
    timers.drainAll(5);
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toBeGreaterThanOrEqual(1);
    expect(errors).toContain('consolidation');
    expect(sched.stats.consolidationErrors).toBeGreaterThanOrEqual(1);

    sched.stop();
  });

  test('tickNow runs both immediately for tests/operators', async () => {
    const db = freshDb();
    const clock = () => 1_700_000_000_000;
    const store = new MemoryWikiStore(db, { clock });
    const writer = new PageWriter({ store, clock });
    const consolidation = new MemoryWikiConsolidation({ store, writer, clock });
    const lint = new MemoryWikiLint({ store, clock });
    const timers = fakeTimers();
    const sched = startWikiScheduler({
      consolidation,
      lint,
      defaultProfile: 'default',
      setTimeoutImpl: timers.setT,
      clearTimeoutImpl: timers.clearT,
    });

    await sched.tickNow();
    expect(sched.stats.consolidationTicks).toBe(1);
    expect(sched.stats.lintTicks).toBe(1);

    sched.stop();
  });
});
