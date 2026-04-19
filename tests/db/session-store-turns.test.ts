/**
 * SessionStore — Turn persistence roundtrip (plan commit A).
 *
 * Covers:
 *   - appendTurn auto-assigns seq when omitted
 *   - blocks (text + thinking + tool_use + tool_result) survive round-trip
 *   - getRecentTurns returns newest-N in chronological order
 *   - markCancelled persists partial blocks + cancelledAt
 *   - updateTurnTokenCount rewrites the JSON blob
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, it } from 'bun:test';
import { ALL_MIGRATIONS } from '../../src/db/migrations/index.ts';
import { SessionStore } from '../../src/db/session-store.ts';
import type { Turn } from '../../src/orchestrator/types.ts';

function freshDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const m of ALL_MIGRATIONS) m.up(db);
  return db;
}

function insertSession(db: Database, id: string): void {
  db.run(
    `INSERT INTO session_store (id, source, created_at, status, working_memory_json, compaction_json, updated_at)
     VALUES (?, 'cli', ?, 'active', NULL, NULL, ?)`,
    [id, Date.now(), Date.now()],
  );
}

function makeTurn(overrides: Partial<Turn>): Omit<Turn, 'seq'> & { seq?: number } {
  return {
    id: overrides.id ?? `turn-${Math.random().toString(36).slice(2, 10)}`,
    sessionId: overrides.sessionId ?? 's1',
    role: overrides.role ?? 'user',
    blocks: overrides.blocks ?? [{ type: 'text', text: 'hello' }],
    tokenCount: overrides.tokenCount ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    createdAt: overrides.createdAt ?? Date.now(),
    ...(overrides.cancelledAt !== undefined ? { cancelledAt: overrides.cancelledAt } : {}),
    ...(overrides.taskId !== undefined ? { taskId: overrides.taskId } : {}),
    ...(overrides.seq !== undefined ? { seq: overrides.seq } : {}),
  };
}

describe('SessionStore — Turn persistence', () => {
  let db: Database;
  let store: SessionStore;

  beforeEach(() => {
    db = freshDb();
    store = new SessionStore(db);
    insertSession(db, 's1');
  });

  it('appendTurn auto-assigns monotonic seq when omitted', () => {
    const t1 = store.appendTurn(makeTurn({ id: 'a' }));
    const t2 = store.appendTurn(makeTurn({ id: 'b' }));
    const t3 = store.appendTurn(makeTurn({ id: 'c' }));
    expect(t1.seq).toBe(0);
    expect(t2.seq).toBe(1);
    expect(t3.seq).toBe(2);
  });

  it('preserves every ContentBlock variant through SQLite round-trip', () => {
    const turn = makeTurn({
      id: 'mixed',
      role: 'assistant',
      blocks: [
        { type: 'text', text: 'Hello' },
        { type: 'thinking', thinking: 'plan', signature: 'sig-abc' },
        { type: 'tool_use', id: 'tu-1', name: 'read_file', input: { path: '/tmp/a.txt' } },
        { type: 'tool_result', tool_use_id: 'tu-1', content: 'contents' },
        { type: 'tool_result', tool_use_id: 'tu-2', content: 'oops', is_error: true },
      ],
      tokenCount: { input: 10, output: 20, cacheRead: 5, cacheCreation: 3 },
      taskId: 'task-1',
    });
    store.appendTurn(turn);

    const [loaded] = store.getTurns('s1');
    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe('mixed');
    expect(loaded!.role).toBe('assistant');
    expect(loaded!.blocks).toHaveLength(5);
    expect(loaded!.blocks[0]).toEqual({ type: 'text', text: 'Hello' });
    expect(loaded!.blocks[1]).toEqual({ type: 'thinking', thinking: 'plan', signature: 'sig-abc' });
    expect(loaded!.blocks[2]).toEqual({
      type: 'tool_use',
      id: 'tu-1',
      name: 'read_file',
      input: { path: '/tmp/a.txt' },
    });
    expect(loaded!.blocks[3]).toEqual({ type: 'tool_result', tool_use_id: 'tu-1', content: 'contents' });
    expect(loaded!.blocks[4]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu-2',
      content: 'oops',
      is_error: true,
    });
    expect(loaded!.tokenCount).toEqual({ input: 10, output: 20, cacheRead: 5, cacheCreation: 3 });
    expect(loaded!.taskId).toBe('task-1');
  });

  it('getRecentTurns returns newest-N in chronological order', () => {
    for (let i = 0; i < 5; i++) {
      store.appendTurn(makeTurn({ id: `t${i}`, blocks: [{ type: 'text', text: `msg-${i}` }] }));
    }
    const recent = store.getRecentTurns('s1', 3);
    expect(recent.map((t) => t.id)).toEqual(['t2', 't3', 't4']);
  });

  it('markCancelled persists partialBlocks + cancelledAt timestamp', () => {
    const turn = store.appendTurn(
      makeTurn({
        id: 'cancel-me',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'streaming...' }],
      }),
    );
    const cancelledAt = Date.now();
    store.markCancelled(turn.id, cancelledAt, [{ type: 'text', text: 'partial before cancel' }]);

    const loaded = store.getTurn(turn.id);
    expect(loaded?.cancelledAt).toBe(cancelledAt);
    expect(loaded?.blocks).toEqual([{ type: 'text', text: 'partial before cancel' }]);
  });

  it('updateTurnTokenCount rewrites counts after the response lands', () => {
    const turn = store.appendTurn(makeTurn({ id: 'tok' }));
    store.updateTurnTokenCount(turn.id, { input: 100, output: 250, cacheRead: 80, cacheCreation: 20 });
    const loaded = store.getTurn(turn.id);
    expect(loaded?.tokenCount).toEqual({ input: 100, output: 250, cacheRead: 80, cacheCreation: 20 });
  });

  it('countTurns matches the number of appended turns', () => {
    expect(store.countTurns('s1')).toBe(0);
    store.appendTurn(makeTurn({ id: 'a' }));
    store.appendTurn(makeTurn({ id: 'b' }));
    expect(store.countTurns('s1')).toBe(2);
  });
});
