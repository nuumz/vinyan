/**
 * Migration 035 — session_turns (Turn model) smoke test.
 *
 * Verifies that:
 *   - legacy session_* rows are wiped on up()
 *   - session_turns is created with the expected columns + indexes
 *   - UNIQUE(session_id, seq) is enforced
 *
 * Plan commit A — see /root/.claude/plans/cached-zooming-platypus.md
 */
import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { ALL_MIGRATIONS } from '../../../src/db/migrations/index.ts';
import { migration035 } from '../../../src/db/migrations/035_add_session_turns.ts';

function freshDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const m of ALL_MIGRATIONS) m.up(db);
  return db;
}

describe('migration035 — session_turns (Turn model)', () => {
  it('declares the correct version + description', () => {
    expect(migration035.version).toBe(35);
    expect(migration035.description.toLowerCase()).toContain('turn');
  });

  it('creates the session_turns table with expected columns', () => {
    const db = freshDb();
    const cols = db.query('PRAGMA table_info(session_turns)').all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        'id',
        'session_id',
        'seq',
        'role',
        'blocks_json',
        'cancelled_at',
        'token_count_json',
        'task_id',
        'created_at',
      ].sort(),
    );
  });

  it('creates the (session_id, seq) and (session_id, created_at) indexes', () => {
    const db = freshDb();
    const indexes = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='session_turns' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_session_turns_session_seq');
    expect(names).toContain('idx_session_turns_session_time');
  });

  it('accepts an INSERT + SELECT roundtrip', () => {
    const db = freshDb();
    db.run(
      `INSERT INTO session_store (id, source, created_at, status, working_memory_json, compaction_json, updated_at)
       VALUES ('s1', 'cli', ?, 'active', NULL, NULL, ?)`,
      [Date.now(), Date.now()],
    );
    db.run(
      `INSERT INTO session_turns (id, session_id, seq, role, blocks_json, cancelled_at, token_count_json, task_id, created_at)
       VALUES ('t1', 's1', 0, 'user', '[]', NULL, '{"input":0,"output":0,"cacheRead":0,"cacheCreation":0}', NULL, ?)`,
      [Date.now()],
    );
    const rows = db
      .query('SELECT id, session_id, seq, role FROM session_turns WHERE session_id = ?')
      .all('s1') as Array<{ id: string; session_id: string; seq: number; role: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('t1');
    expect(rows[0]!.role).toBe('user');
  });

  it('enforces UNIQUE(session_id, seq)', () => {
    const db = freshDb();
    db.run(
      `INSERT INTO session_store (id, source, created_at, status, working_memory_json, compaction_json, updated_at)
       VALUES ('s1', 'cli', ?, 'active', NULL, NULL, ?)`,
      [Date.now(), Date.now()],
    );
    db.run(
      `INSERT INTO session_turns (id, session_id, seq, role, blocks_json, cancelled_at, token_count_json, task_id, created_at)
       VALUES ('t1', 's1', 0, 'user', '[]', NULL, '{"input":0,"output":0,"cacheRead":0,"cacheCreation":0}', NULL, ?)`,
      [Date.now()],
    );
    expect(() =>
      db.run(
        `INSERT INTO session_turns (id, session_id, seq, role, blocks_json, cancelled_at, token_count_json, task_id, created_at)
         VALUES ('t2', 's1', 0, 'assistant', '[]', NULL, '{"input":0,"output":0,"cacheRead":0,"cacheCreation":0}', NULL, ?)`,
        [Date.now()],
      ),
    ).toThrow();
  });

  it('wipes legacy session rows on re-apply (hard cut-over semantics)', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    for (const m of ALL_MIGRATIONS) {
      if (m.version < 35) m.up(db);
    }
    db.run(
      `INSERT INTO session_store (id, source, created_at, status, working_memory_json, compaction_json, updated_at)
       VALUES ('legacy', 'cli', 0, 'active', NULL, NULL, 0)`,
    );
    db.run(
      `INSERT INTO session_messages (session_id, task_id, role, content, thinking, tools_used, token_estimate, created_at)
       VALUES ('legacy', NULL, 'user', 'hi', NULL, NULL, 1, 0)`,
    );

    migration035.up(db);

    const remainingStore = db.query('SELECT COUNT(*) AS n FROM session_store').get() as { n: number };
    const remainingMsgs = db.query('SELECT COUNT(*) AS n FROM session_messages').get() as { n: number };
    expect(remainingStore.n).toBe(0);
    expect(remainingMsgs.n).toBe(0);
  });
});
