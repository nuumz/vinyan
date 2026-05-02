/**
 * Migration 037 — drop session_turns. Phase 4 destructive.
 *
 * Asserts:
 *   1. The migration is a clean DROP TABLE — table is gone afterwards.
 *   2. Idempotent — re-running on a DB without session_turns is a no-op.
 *   3. After applying, SessionStore detects the missing table on
 *      `refreshSchemaState()` and degrades turn methods to empty
 *      results / no-op writes.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';
import { migration036 } from '../../src/db/migrations/036_session_jsonl_index.ts';
import { migration037 } from '../../src/db/migrations/037_drop_session_turns.ts';
import { MigrationRunner } from '../../src/db/migrations/migration-runner.ts';
import { SessionStore } from '../../src/db/session-store.ts';

function setup(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, [migration001, migration036]);
  return db;
}

function tableExists(db: Database, name: string): boolean {
  return db.query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name) != null;
}

describe('Migration 037 — drop session_turns', () => {
  test('drops the session_turns table', () => {
    const db = setup();
    expect(tableExists(db, 'session_turns')).toBe(true);
    new MigrationRunner().migrate(db, [migration001, migration036, migration037]);
    expect(tableExists(db, 'session_turns')).toBe(false);
  });

  test('is idempotent — re-applying on a DB without session_turns does not throw', () => {
    const db = setup();
    new MigrationRunner().migrate(db, [migration001, migration036, migration037]);
    expect(() => migration037.up(db)).not.toThrow();
  });

  test('SessionStore.refreshSchemaState reflects the drop', () => {
    const db = setup();
    const store = new SessionStore(db);
    expect(store.getSchemaState().sessionTurnsDropped).toBe(false);
    new MigrationRunner().migrate(db, [migration001, migration036, migration037]);
    store.refreshSchemaState();
    expect(store.getSchemaState().sessionTurnsDropped).toBe(true);
  });

  test('post-drop turn methods degrade gracefully', () => {
    const db = setup();
    const store = new SessionStore(db);
    const now = Date.now();
    db.run('INSERT INTO session_store (id, source, created_at, status, updated_at) VALUES (?, ?, ?, ?, ?)', [
      's1',
      'cli',
      now,
      'active',
      now,
    ]);
    new MigrationRunner().migrate(db, [migration001, migration036, migration037]);
    store.refreshSchemaState();

    expect(store.getTurns('s1')).toEqual([]);
    expect(store.getRecentTurns('s1', 10)).toEqual([]);
    expect(store.getTurn('any-turn')).toBeUndefined();
    expect(store.countTurns('s1')).toBe(0);
    // appendTurn returns a synthetic Turn (no insert, no throw)
    const synthetic = store.appendTurn({
      id: 't',
      sessionId: 's1',
      role: 'user',
      blocks: [],
      tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      createdAt: now,
    });
    expect(synthetic.id).toBe('t');
    expect(synthetic.seq).toBe(0);
    // markCancelled / updateTurnTokenCount no-op without throwing
    expect(() => store.markCancelled('t', now)).not.toThrow();
    expect(() =>
      store.updateTurnTokenCount('t', { input: 1, output: 2, cacheRead: 0, cacheCreation: 0 }),
    ).not.toThrow();
  });

  test('legacy listSessions auto-routes to listSessionsViaIndex post-drop', () => {
    const db = setup();
    const now = Date.now();
    db.run('INSERT INTO session_store (id, source, created_at, status, updated_at) VALUES (?, ?, ?, ?, ?)', [
      's1',
      'cli',
      now,
      'active',
      now,
    ]);
    new MigrationRunner().migrate(db, [migration001, migration036, migration037]);
    const store = new SessionStore(db);
    // Should not throw — auto-routes to listSessionsViaIndex.
    const rows = store.listSessions();
    expect(rows.find((r) => r.id === 's1')).toBeDefined();
  });

  test('hardDeleteSession works post-drop (no session_turns to clean up)', () => {
    const db = setup();
    const now = Date.now();
    db.run(
      'INSERT INTO session_store (id, source, created_at, status, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['s1', 'cli', now, 'active', now, now],
    );
    new MigrationRunner().migrate(db, [migration001, migration036, migration037]);
    const store = new SessionStore(db);
    expect(store.hardDeleteSession('s1')).toBe(true);
    expect(db.query('SELECT id FROM session_store WHERE id = ?').get('s1')).toBeNull();
  });
});
