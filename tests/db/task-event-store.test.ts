/**
 * TaskEventStore — verifies append/listForTask/seq counter behavior.
 *
 * Behavior tests (not structure tests): each case feeds inputs through the
 * public API and asserts what callers will actually observe.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { TaskEventStore } from '../../src/db/task-event-store.ts';

let db: Database;
let store: TaskEventStore;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  store = new TaskEventStore(db);
});

afterEach(() => {
  db.close();
});

describe('TaskEventStore', () => {
  test('appends events with monotonically increasing seq per task', () => {
    const a1 = store.append({ taskId: 'task-1', eventType: 'phase:timing', payload: { phase: 'plan' }, ts: 1 });
    const a2 = store.append({ taskId: 'task-1', eventType: 'agent:thinking', payload: { content: 'x' }, ts: 2 });
    const b1 = store.append({ taskId: 'task-2', eventType: 'phase:timing', payload: { phase: 'plan' }, ts: 3 });

    expect(a1.seq).toBe(1);
    expect(a2.seq).toBe(2);
    // seq is per-task — task-2 starts at 1 again.
    expect(b1.seq).toBe(1);
  });

  test('listForTask returns rows in seq order with payload preserved', () => {
    store.append({ taskId: 't', eventType: 'phase:timing', payload: { phase: 'plan' }, ts: 1 });
    store.append({ taskId: 't', eventType: 'agent:tool_started', payload: { name: 'read', input: { x: 1 } }, ts: 2 });
    const events = store.listForTask('t');
    expect(events.map((e) => e.eventType)).toEqual(['phase:timing', 'agent:tool_started']);
    expect(events[1]?.payload).toEqual({ name: 'read', input: { x: 1 } });
    expect(events[0]?.seq).toBeLessThan(events[1]?.seq ?? Infinity);
  });

  test('listForTask honors since cursor', () => {
    for (let i = 0; i < 5; i++) {
      store.append({ taskId: 't', eventType: 'phase:timing', payload: { i }, ts: i });
    }
    const tail = store.listForTask('t', { since: 3 });
    expect(tail.length).toBe(3);
    expect(tail[0]?.seq).toBe(3);
    expect((tail[0]?.payload as { i: number }).i).toBe(2);
  });

  test('seq counter survives forgetTask via DB hydration', () => {
    store.append({ taskId: 't', eventType: 'phase:timing', payload: {}, ts: 1 });
    store.append({ taskId: 't', eventType: 'phase:timing', payload: {}, ts: 2 });
    store.forgetTask('t');
    // Next append must continue past existing MAX(seq), not reset to 1.
    const next = store.append({ taskId: 't', eventType: 'phase:timing', payload: {}, ts: 3 });
    expect(next.seq).toBe(3);
  });

  test('appendBatch persists every event in one transaction', () => {
    const written = store.appendBatch([
      { taskId: 'b', eventType: 'phase:timing', payload: { i: 0 }, ts: 0 },
      { taskId: 'b', eventType: 'phase:timing', payload: { i: 1 }, ts: 1 },
      { taskId: 'b', eventType: 'phase:timing', payload: { i: 2 }, ts: 2 },
    ]);
    expect(written).toBe(3);
    expect(store.listForTask('b').length).toBe(3);
  });
});
