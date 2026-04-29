/**
 * TaskEventRecorder — verifies bus → store batching, allow-list filtering,
 * FIFO overflow handling, and string truncation.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createBus, type VinyanBus } from '../../../src/core/bus.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../../src/db/migrations/index.ts';
import { TaskEventStore } from '../../../src/db/task-event-store.ts';
import {
  attachTaskEventRecorder,
  type TaskEventRecorderHandle,
} from '../../../src/orchestrator/observability/task-event-recorder.ts';

let db: Database;
let store: TaskEventStore;
let bus: VinyanBus;
let handle: TaskEventRecorderHandle;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  store = new TaskEventStore(db);
  bus = createBus();
});

afterEach(() => {
  handle?.detach();
  db.close();
});

describe('TaskEventRecorder', () => {
  test('persists allow-listed events keyed by taskId', () => {
    handle = attachTaskEventRecorder(bus, store, { flushIntervalMs: 10_000 });

    bus.emit('phase:timing', { taskId: 't-1', phase: 'plan', durationMs: 12, routingLevel: 2 });
    bus.emit('agent:thinking', { taskId: 't-1', turnId: 'turn-1', rationale: 'hello' });

    handle.flush();
    const events = store.listForTask('t-1');
    expect(events.map((e) => e.eventType)).toEqual(['phase:timing', 'agent:thinking']);
    expect((events[0]?.payload as { phase: string }).phase).toBe('plan');
  });

  test('skips events without a taskId', () => {
    handle = attachTaskEventRecorder(bus, store, { flushIntervalMs: 10_000 });
    // session-scoped event with no taskId — recorder should drop.
    bus.emit('phase:timing', { phase: 'plan', durationMs: 5 } as never);
    handle.flush();
    // No task to query, so just assert nothing was written for any task.
    const row = db.prepare('SELECT COUNT(*) AS n FROM task_events').get() as { n: number };
    expect(row.n).toBe(0);
  });

  test('skips events not on the allow-list', () => {
    handle = attachTaskEventRecorder(bus, store, { flushIntervalMs: 10_000 });
    // `task:complete` is intentionally excluded — execution_traces covers it.
    bus.emit('task:complete', { result: { id: 't-x', status: 'completed' } } as never);
    handle.flush();
    const row = db.prepare('SELECT COUNT(*) AS n FROM task_events').get() as { n: number };
    expect(row.n).toBe(0);
  });

  test('truncates oversized string payload fields', () => {
    handle = attachTaskEventRecorder(bus, store, { flushIntervalMs: 10_000, maxStringChars: 16 });
    const huge = 'x'.repeat(64);
    bus.emit('agent:thinking', { taskId: 't-2', turnId: 'turn-2', rationale: huge });
    handle.flush();
    const events = store.listForTask('t-2');
    const rationale = (events[0]?.payload as { rationale: string }).rationale;
    expect(rationale.length).toBeLessThan(huge.length);
    expect(rationale).toContain('truncated');
  });

  test('drops oldest buffered event on overflow (FIFO)', () => {
    handle = attachTaskEventRecorder(bus, store, {
      bufferLimit: 2,
      flushIntervalMs: 10_000,
    });
    bus.emit('phase:timing', { taskId: 't-3', phase: 'a', durationMs: 1, routingLevel: 2 });
    bus.emit('phase:timing', { taskId: 't-3', phase: 'b', durationMs: 1, routingLevel: 2 });
    bus.emit('phase:timing', { taskId: 't-3', phase: 'c', durationMs: 1, routingLevel: 2 });
    expect(handle.droppedCount()).toBe(1);
    handle.flush();
    const phases = store.listForTask('t-3').map((e) => (e.payload as { phase: string }).phase);
    // Oldest ('a') was dropped; newest two survived.
    expect(phases).toEqual(['b', 'c']);
  });
});
