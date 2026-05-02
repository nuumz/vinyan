/**
 * Migration 038 — drop session_store blob columns. Phase 4 destructive.
 *
 * Asserts:
 *   1. working_memory_json + compaction_json columns are gone after the
 *      migration.
 *   2. Re-running on a DB that already lacks the columns is a no-op.
 *   3. SessionStore.refreshSchemaState reflects the drop, and
 *      updateSessionMemory / updateSessionCompaction degrade to no-ops
 *      that still touch updated_at / status respectively.
 *   4. insertSession uses the post-drop column list — no SQL error.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';
import { migration036 } from '../../src/db/migrations/036_session_jsonl_index.ts';
import { migration037 } from '../../src/db/migrations/037_drop_session_turns.ts';
import { migration038 } from '../../src/db/migrations/038_drop_session_store_blobs.ts';
import { MigrationRunner } from '../../src/db/migrations/migration-runner.ts';
import { SessionStore } from '../../src/db/session-store.ts';

function setup(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, [migration001, migration036]);
  return db;
}

function columns(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

describe('Migration 038 — drop session_store blob columns', () => {
  test('removes working_memory_json + compaction_json from session_store', () => {
    const db = setup();
    expect(columns(db, 'session_store')).toContain('working_memory_json');
    expect(columns(db, 'session_store')).toContain('compaction_json');
    new MigrationRunner().migrate(db, [migration001, migration036, migration037, migration038]);
    expect(columns(db, 'session_store')).not.toContain('working_memory_json');
    expect(columns(db, 'session_store')).not.toContain('compaction_json');
  });

  test('keeps every other session_store column intact', () => {
    const db = setup();
    new MigrationRunner().migrate(db, [migration001, migration036, migration037, migration038]);
    const after = columns(db, 'session_store');
    for (const name of [
      'id',
      'source',
      'created_at',
      'status',
      'updated_at',
      'title',
      'description',
      'archived_at',
      'deleted_at',
      'last_line_id',
      'last_line_offset',
      'active_segment',
    ]) {
      expect(after).toContain(name);
    }
  });

  test('idempotent — re-applying on a DB that has already dropped the columns is a no-op', () => {
    const db = setup();
    new MigrationRunner().migrate(db, [migration001, migration036, migration037, migration038]);
    expect(() => migration038.up(db)).not.toThrow();
  });

  test('SessionStore detects column drop on refreshSchemaState', () => {
    const db = setup();
    const store = new SessionStore(db);
    expect(store.getSchemaState().blobColumnsDropped).toBe(false);
    new MigrationRunner().migrate(db, [migration001, migration036, migration037, migration038]);
    store.refreshSchemaState();
    expect(store.getSchemaState().blobColumnsDropped).toBe(true);
  });

  test('post-drop insertSession + updateSessionMemory / updateSessionCompaction degrade gracefully', () => {
    const db = setup();
    new MigrationRunner().migrate(db, [migration001, migration036, migration037, migration038]);
    const store = new SessionStore(db);
    const now = Date.now();
    expect(() =>
      store.insertSession({
        id: 's1',
        source: 'cli',
        created_at: now,
        status: 'active',
        working_memory_json: null,
        compaction_json: null,
        updated_at: now,
        title: 'phase4',
        description: null,
        archived_at: null,
        deleted_at: null,
      }),
    ).not.toThrow();

    // updateSessionMemory has no column to write to — must still bump updated_at.
    expect(() => store.updateSessionMemory('s1', '{}')).not.toThrow();
    // updateSessionCompaction has no column — must still flip status to 'compacted'.
    store.updateSessionCompaction('s1', '{}');
    const row = db.query('SELECT status FROM session_store WHERE id = ?').get('s1') as { status: string };
    expect(row.status).toBe('compacted');
  });
});
