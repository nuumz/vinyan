/**
 * Migration 036 — verifies additive schema for the JSONL hybrid layer.
 *
 * Asserts:
 *   - session_store gains last_line_id, last_line_offset, active_segment
 *     (all nullable so existing rows are untouched).
 *   - session_turn_summary table is created with the documented columns.
 *   - Re-running 036 (via fresh migration application) is idempotent.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';
import { migration036 } from '../../src/db/migrations/036_session_jsonl_index.ts';
import { MigrationRunner } from '../../src/db/migrations/migration-runner.ts';

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
}

function columnNames(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as ColumnInfo[]).map((c) => c.name);
}

describe('Migration 036 — session JSONL index', () => {
  test('adds last_line_id, last_line_offset, active_segment to session_store', () => {
    const db = new Database(':memory:');
    new MigrationRunner().migrate(db, [migration001, migration036]);
    const cols = columnNames(db, 'session_store');
    expect(cols).toContain('last_line_id');
    expect(cols).toContain('last_line_offset');
    expect(cols).toContain('active_segment');
  });

  test('creates session_turn_summary with the documented shape', () => {
    const db = new Database(':memory:');
    new MigrationRunner().migrate(db, [migration001, migration036]);
    const cols = columnNames(db, 'session_turn_summary');
    expect(cols.sort()).toEqual(
      [
        'session_id',
        'latest_seq',
        'latest_turn_id',
        'latest_turn_role',
        'latest_turn_blocks_preview',
        'turn_count',
        'updated_at',
      ].sort(),
    );
  });

  test('upsert into session_turn_summary works (PK + ON CONFLICT)', () => {
    const db = new Database(':memory:');
    new MigrationRunner().migrate(db, [migration001, migration036]);
    db.run('INSERT INTO session_store (id, source, created_at, status, updated_at) VALUES (?, ?, ?, ?, ?)', [
      's1',
      'cli',
      1,
      'active',
      1,
    ]);
    db.run(
      `INSERT INTO session_turn_summary
         (session_id, latest_seq, latest_turn_id, latest_turn_role, latest_turn_blocks_preview, turn_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET turn_count = excluded.turn_count`,
      ['s1', 0, 't1', 'user', '[]', 1, 1],
    );
    db.run(
      `INSERT INTO session_turn_summary
         (session_id, latest_seq, latest_turn_id, latest_turn_role, latest_turn_blocks_preview, turn_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET turn_count = excluded.turn_count`,
      ['s1', 1, 't2', 'assistant', '[]', 2, 2],
    );
    const row = db.query('SELECT turn_count FROM session_turn_summary WHERE session_id = ?').get('s1') as {
      turn_count: number;
    };
    expect(row.turn_count).toBe(2);
  });

  test('migration is idempotent under re-application', () => {
    const db = new Database(':memory:');
    new MigrationRunner().migrate(db, [migration001, migration036]);
    // Calling up() again on the already-migrated DB must not throw.
    expect(() => migration036.up(db)).not.toThrow();
  });

  test('existing session_store rows survive the migration with nullable JSONL columns', () => {
    const db = new Database(':memory:');
    new MigrationRunner().migrate(db, [migration001]);
    db.run('INSERT INTO session_store (id, source, created_at, status, updated_at) VALUES (?, ?, ?, ?, ?)', [
      'legacy-1',
      'cli',
      1,
      'active',
      1,
    ]);
    new MigrationRunner().migrate(db, [migration001, migration036]);
    const row = db.query('SELECT * FROM session_store WHERE id = ?').get('legacy-1') as {
      id: string;
      last_line_id: string | null;
      last_line_offset: number | null;
      active_segment: string | null;
    };
    expect(row.id).toBe('legacy-1');
    expect(row.last_line_id).toBeNull();
    expect(row.last_line_offset).toBeNull();
    expect(row.active_segment).toBeNull();
  });
});
