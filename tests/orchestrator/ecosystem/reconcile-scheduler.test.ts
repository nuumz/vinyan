import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';

import { createBus } from '../../../src/core/bus.ts';
import { buildEcosystem } from '../../../src/orchestrator/ecosystem/index.ts';
import type { CoordinatorTimerImpl } from '../../../src/orchestrator/ecosystem/index.ts';
import { migration031 } from '../../../src/db/migrations/031_add_agent_runtime.ts';
import { migration032 } from '../../../src/db/migrations/032_add_commitments.ts';
import { migration033 } from '../../../src/db/migrations/033_add_teams.ts';
import { migration034 } from '../../../src/db/migrations/034_add_volunteer.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  migration031.up(db);
  migration032.up(db);
  migration033.up(db);
  migration034.up(db);
  return db;
}

/**
 * Controllable fake timer — the scheduler uses chained setTimeout, so
 * tests drive ticks by invoking the most-recently-registered callback
 * via `fireNext()`. We keep the queue to make reentrancy tests simple.
 */
function makeFakeTimer() {
  const queue: Array<{ id: number; fn: () => void; ms: number; fired: boolean }> = [];
  let nextId = 1;
  const impl: CoordinatorTimerImpl = {
    setTimer: (fn, ms) => {
      const entry = { id: nextId++, fn, ms, fired: false };
      queue.push(entry);
      return entry.id;
    },
    clearTimer: (h) => {
      const idx = queue.findIndex((e) => e.id === h && !e.fired);
      if (idx !== -1) queue.splice(idx, 1);
    },
  };
  return {
    impl,
    queue,
    fireNext: () => {
      const entry = queue.find((e) => !e.fired);
      if (!entry) throw new Error('no pending timer');
      entry.fired = true;
      const idx = queue.indexOf(entry);
      queue.splice(idx, 1);
      entry.fn();
    },
    pending: () => queue.filter((e) => !e.fired).length,
  };
}

describe('EcosystemCoordinator — reconcile scheduler', () => {
  it('does not schedule when reconcileIntervalMs is omitted (default 0)', () => {
    const db = makeDb();
    const bus = createBus();
    const fake = makeFakeTimer();

    const { coordinator } = buildEcosystem({
      db,
      bus,
      taskResolver: () => null,
      engineRoster: () => [],
      timer: fake.impl,
      // reconcileIntervalMs omitted → scheduler off
    });
    coordinator.start();
    expect(fake.pending()).toBe(0);
    coordinator.stop();
  });

  it('schedules ticks when interval > 0 and stops canceling them', () => {
    const db = makeDb();
    const bus = createBus();
    const fake = makeFakeTimer();

    const { coordinator } = buildEcosystem({
      db,
      bus,
      taskResolver: () => null,
      engineRoster: () => [],
      timer: fake.impl,
      reconcileIntervalMs: 1000,
    });
    coordinator.start();
    expect(fake.pending()).toBe(1);

    // Fire once — a follow-up tick should be queued.
    fake.fireNext();
    expect(fake.pending()).toBe(1);

    // stop() cancels the pending tick.
    coordinator.stop();
    expect(fake.pending()).toBe(0);
  });

  it('emits ecosystem:reconcile_tick on each scheduled sweep', () => {
    const db = makeDb();
    const bus = createBus();
    const fake = makeFakeTimer();
    const ticks: Array<{ violationCount: number; durationMs: number }> = [];
    bus.on('ecosystem:reconcile_tick', (p) => ticks.push(p));

    const { coordinator } = buildEcosystem({
      db,
      bus,
      taskResolver: () => null,
      engineRoster: () => [],
      timer: fake.impl,
      reconcileIntervalMs: 500,
    });
    coordinator.start();
    fake.fireNext();
    fake.fireNext();
    expect(ticks).toHaveLength(2);

    coordinator.stop();
  });

  it('emits ecosystem:invariant_violation per finding during a scheduled sweep', () => {
    const db = makeDb();
    const bus = createBus();
    const fake = makeFakeTimer();
    const violations: Array<{ id: string; subject: string }> = [];
    bus.on('ecosystem:invariant_violation', (p) => violations.push(p));

    const { coordinator, runtime } = buildEcosystem({
      db,
      bus,
      taskResolver: () => null,
      engineRoster: () => [],
      timer: fake.impl,
      reconcileIntervalMs: 500,
    });
    coordinator.start();

    // Stage an I-E1 violation: Working engine with no commitment.
    runtime.register('rogue');
    runtime.awaken('rogue');
    runtime.markReady('rogue');
    runtime.markWorking('rogue', 'phantom');

    fake.fireNext();
    expect(violations.some((v) => v.id === 'I-E1' && v.subject === 'rogue')).toBe(true);

    coordinator.stop();
  });

  it('survives an exception inside reconcile and continues scheduling', () => {
    const db = makeDb();
    const bus = createBus();
    const fake = makeFakeTimer();
    const tickErrors: Array<string | undefined> = [];
    bus.on('ecosystem:reconcile_tick', (p) => tickErrors.push(p.error));

    const { coordinator } = buildEcosystem({
      db,
      bus,
      taskResolver: () => null,
      engineRoster: () => {
        throw new Error('roster unavailable');
      },
      timer: fake.impl,
      reconcileIntervalMs: 500,
    });

    const origError = console.error;
    console.error = () => {}; // silence expected log noise

    try {
      coordinator.start();
      fake.fireNext();

      // First tick caught the error, still scheduled a follow-up.
      expect(tickErrors[0]).toContain('roster unavailable');
      expect(fake.pending()).toBe(1);

      fake.fireNext();
      expect(tickErrors).toHaveLength(2);
      expect(fake.pending()).toBe(1);
    } finally {
      coordinator.stop();
      console.error = origError;
    }
  });

  it('start() is idempotent — repeated calls do not double-schedule', () => {
    const db = makeDb();
    const bus = createBus();
    const fake = makeFakeTimer();

    const { coordinator } = buildEcosystem({
      db,
      bus,
      taskResolver: () => null,
      engineRoster: () => [],
      timer: fake.impl,
      reconcileIntervalMs: 500,
    });
    coordinator.start();
    coordinator.start();
    coordinator.start();
    expect(fake.pending()).toBe(1);
    coordinator.stop();
  });
});
