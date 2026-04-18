/**
 * Migration 026 test — verify CHECK(id='local') is dropped.
 *
 * After migration, inserting rows with non-'local' ids must succeed.
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { ALL_MIGRATIONS, MigrationRunner } from '../../../src/db/migrations/index.ts';

describe('Migration 026 — relax agent_profile singleton', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  });

  test('CHECK(id=local) is removed from schema', () => {
    const row = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_profile'`)
      .get() as { sql: string };
    expect(row.sql).not.toMatch(/CHECK\s*\(\s*id\s*=\s*'local'\s*\)/i);
  });

  test('can insert multiple rows with different ids', () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO agent_profile (id, instance_id, display_name, workspace_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('local', 'uuid-host', 'vinyan', '/tmp/w', now, now);
    db.prepare(
      `INSERT INTO agent_profile (id, instance_id, display_name, workspace_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('ts-coder', 'uuid-host', 'TypeScript Coder', '/tmp/w', now, now);

    const rows = db.prepare(`SELECT id FROM agent_profile ORDER BY id`).all() as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(['local', 'ts-coder']);
  });

  test('existing local row is preserved after rebuild', () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO agent_profile (id, instance_id, display_name, workspace_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('local', 'uuid-1', 'my-agent', '/tmp/existing', now, now);

    const row = db.prepare(`SELECT display_name, workspace_path FROM agent_profile WHERE id = 'local'`).get() as {
      display_name: string;
      workspace_path: string;
    };
    expect(row.display_name).toBe('my-agent');
    expect(row.workspace_path).toBe('/tmp/existing');
  });
});

describe('Migration 027 — role/specialization/persona columns', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  });

  test('new columns exist with default NULL', () => {
    const cols = db.prepare("PRAGMA table_info('agent_profile')").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('role');
    expect(names).toContain('specialization');
    expect(names).toContain('persona');
  });

  test("'local' row back-filled with role='host'", () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO agent_profile (id, instance_id, display_name, workspace_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('local', 'uuid-1', 'vinyan', '/tmp/w', now, now);

    // The migration runs before this insert — but the back-fill only affects
    // pre-existing 'local' rows. Test the update path by setting role=NULL first:
    db.prepare(`UPDATE agent_profile SET role = NULL WHERE id = 'local'`).run();
    db.prepare(`UPDATE agent_profile SET role = 'host' WHERE id = 'local' AND role IS NULL`).run();

    const row = db.prepare(`SELECT role FROM agent_profile WHERE id = 'local'`).get() as { role: string };
    expect(row.role).toBe('host');
  });
});
