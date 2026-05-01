/**
 * Migration 004 tests — verify the SKILL.md artifact columns land on
 * `cached_skills`, that indexes are created, and that the migration is
 * idempotent.
 *
 * Also verifies the defaults (`confidence_tier='probabilistic'`) work and
 * that inserting a deterministic-tier row succeeds whether the runtime
 * enforces the CHECK clause via ALTER or the application layer handles
 * validation.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { migration001 } from '../../../src/db/migrations/001_initial_schema.ts';
import { MigrationRunner } from '../../../src/db/migrations/migration-runner.ts';

let db: Database;
const runner = new MigrationRunner();

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
});

afterEach(() => {
  db.close();
});

function columnsOf(table: string): Array<{ name: string; type: string; notnull: number; dflt_value: unknown }> {
  return db.query(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
  }>;
}

describe('migration 004 — cached_skills SKILL.md columns', () => {
  test('applies the new columns on top of migration 001', () => {
    const result = runner.migrate(db, [migration001]);
    expect(result.applied).toEqual([1]);
    expect(result.current).toBe(1);

    const cols = columnsOf('cached_skills');
    const names = new Set(cols.map((c) => c.name));
    expect(names.has('confidence_tier')).toBe(true);
    expect(names.has('skill_md_path')).toBe(true);
    expect(names.has('content_hash')).toBe(true);
    expect(names.has('expected_error_reduction')).toBe(true);
    expect(names.has('backtest_id')).toBe(true);
    expect(names.has('quarantined_at')).toBe(true);

    // Pre-existing columns still present.
    expect(names.has('task_signature')).toBe(true);
    expect(names.has('approach')).toBe(true);
    expect(names.has('status')).toBe(true);
  });

  test('creates the content_hash and tier indexes', () => {
    runner.migrate(db, [migration001]);
    const indexes = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='cached_skills'")
      .all() as Array<{ name: string }>;
    const names = new Set(indexes.map((i) => i.name));
    expect(names.has('idx_cached_skills_content_hash')).toBe(true);
    expect(names.has('idx_cached_skills_tier')).toBe(true);
  });

  test('re-applying migration 004 against a migrated DB is idempotent', () => {
    runner.migrate(db, [migration001]);
    // Run the migration body again directly — should NOT throw.
    expect(() => migration001.up(db)).not.toThrow();

    // Column count stays the same after second run.
    const colsAfter = columnsOf('cached_skills');
    const tierCols = colsAfter.filter((c) => c.name === 'confidence_tier');
    expect(tierCols.length).toBe(1);
  });

  test('inserts a row with default confidence_tier succeed', () => {
    runner.migrate(db, [migration001]);
    db.run(
      `INSERT INTO cached_skills (
        task_signature, approach, success_rate, status,
        probation_remaining, usage_count, risk_at_creation,
        dep_cone_hashes, last_verified_at, verification_profile
      ) VALUES ('sig-1', 'do-thing', 0.9, 'probation', 10, 0, 0.2, '{}', 0, 'structural')`,
    );
    const row = db
      .query("SELECT confidence_tier, skill_md_path FROM cached_skills WHERE task_signature='sig-1'")
      .get() as { confidence_tier: string; skill_md_path: string | null } | undefined;
    expect(row?.confidence_tier).toBe('probabilistic');
    expect(row?.skill_md_path).toBeNull();
  });

  test('inserts a deterministic-tier row and reads it back', () => {
    runner.migrate(db, [migration001]);
    db.run(
      `INSERT INTO cached_skills (
        task_signature, approach, success_rate, status,
        probation_remaining, usage_count, risk_at_creation,
        dep_cone_hashes, last_verified_at, verification_profile,
        confidence_tier, content_hash, skill_md_path
      ) VALUES ('sig-2', 'do-det', 1.0, 'active', 0, 5, 0.1, '{}', 0, 'full',
                'deterministic', ?, 'skills/sig-2/SKILL.md')`,
      [`sha256:${'a'.repeat(64)}`],
    );
    const row = db
      .query("SELECT confidence_tier, content_hash FROM cached_skills WHERE task_signature='sig-2'")
      .get() as { confidence_tier: string; content_hash: string } | undefined;
    expect(row?.confidence_tier).toBe('deterministic');
    expect(row?.content_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test('idempotent — re-running mig004 on an already-migrated DB is a no-op', () => {
    // Post-2026-05-02 consolidation, migration001 already runs the
    // squashed mig004 internally, so `cached_skills` arrives with all
    // SKILL.md columns present from the first migrate() call. Running
    // mig004 a second time must be a clean no-op rather than throwing
    // "duplicate column" — that's the per-column ADD's `try/catch`
    // contract.
    runner.migrate(db, [migration001]);
    const before = new Set(columnsOf('cached_skills').map((c) => c.name));
    expect(before.has('confidence_tier')).toBe(true);
    expect(() => migration001.up(db)).not.toThrow();
    const after = new Set(columnsOf('cached_skills').map((c) => c.name));
    expect(after).toEqual(before);
  });
});
