/**
 * TaskEventStore.listForSession — verifies cross-task ordering and the
 * opaque cursor contract used by the session event-history endpoint.
 *
 * These tests focus on what the reconciler actually relies on:
 *   - events from multiple tasks in the same session are returned in
 *     chronological order;
 *   - `nextCursor` returned in one page, when passed back as `since`,
 *     yields strictly newer rows (no duplicates, no gaps);
 *   - rows from other sessions are never returned.
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

describe('TaskEventStore.listForSession', () => {
  test('returns events from multiple tasks ordered by ts then id', () => {
    // Interleave two tasks under one session — order must reflect ts.
    store.append({ taskId: 'a', sessionId: 's1', eventType: 'phase:timing', payload: { p: 1 }, ts: 10 });
    store.append({ taskId: 'b', sessionId: 's1', eventType: 'phase:timing', payload: { p: 2 }, ts: 20 });
    store.append({ taskId: 'a', sessionId: 's1', eventType: 'phase:timing', payload: { p: 3 }, ts: 30 });

    const page = store.listForSession('s1');
    expect(page.events.map((e) => (e.payload as { p: number }).p)).toEqual([1, 2, 3]);
    expect(page.events.map((e) => e.taskId)).toEqual(['a', 'b', 'a']);
  });

  test('breaks ts ties deterministically by id (no jitter on equal timestamps)', () => {
    // Multiple events sharing ts is realistic — ms granularity + bursty
    // emits. The cursor must still produce a stable order.
    store.append({ taskId: 'a', sessionId: 's', eventType: 'phase:timing', payload: { i: 0 }, ts: 5 });
    store.append({ taskId: 'a', sessionId: 's', eventType: 'phase:timing', payload: { i: 1 }, ts: 5 });
    store.append({ taskId: 'b', sessionId: 's', eventType: 'phase:timing', payload: { i: 2 }, ts: 5 });

    const page = store.listForSession('s');
    expect(page.events.length).toBe(3);
    // ids look like `<taskId>-<seq>`; lexical order is `a-1, a-2, b-1`.
    expect(page.events.map((e) => e.id)).toEqual(['a-1', 'a-2', 'b-1']);
  });

  test('isolates session_id — sibling sessions are not visible', () => {
    store.append({ taskId: 't', sessionId: 's1', eventType: 'phase:timing', payload: {}, ts: 1 });
    store.append({ taskId: 't', sessionId: 's2', eventType: 'phase:timing', payload: {}, ts: 2 });

    const s1 = store.listForSession('s1');
    expect(s1.events.length).toBe(1);
    expect(s1.events[0]?.sessionId).toBe('s1');
  });

  test('cursor returns strictly newer rows on next call (no duplicates, no gaps)', () => {
    for (let i = 0; i < 6; i++) {
      store.append({
        // alternate taskIds so the cursor is exercised across tasks too.
        taskId: i % 2 === 0 ? 'a' : 'b',
        sessionId: 's',
        eventType: 'phase:timing',
        payload: { i },
        ts: i,
      });
    }
    const first = store.listForSession('s', { limit: 3 });
    expect(first.events.length).toBe(3);
    expect(first.nextCursor).toBeDefined();

    const second = store.listForSession('s', { since: first.nextCursor, limit: 3 });
    expect(second.events.length).toBe(3);
    // Concatenation must equal full list — no overlap, no skip.
    const merged = [...first.events, ...second.events].map((e) => (e.payload as { i: number }).i);
    expect(merged).toEqual([0, 1, 2, 3, 4, 5]);

    // One more page — should be empty, with no cursor.
    const third = store.listForSession('s', { since: second.nextCursor });
    expect(third.events.length).toBe(0);
    expect(third.nextCursor).toBeUndefined();
  });

  test('malformed cursor falls back to "from beginning" rather than throwing', () => {
    store.append({ taskId: 't', sessionId: 's', eventType: 'phase:timing', payload: {}, ts: 1 });
    const page = store.listForSession('s', { since: 'not-a-real-cursor' });
    // Defensive: an old client that lost cursor state can still recover.
    expect(page.events.length).toBe(1);
  });

  test('returns no rows for sessions with no events', () => {
    const page = store.listForSession('never-existed');
    expect(page.events.length).toBe(0);
    expect(page.nextCursor).toBeUndefined();
  });
});
