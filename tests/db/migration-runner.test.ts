/**
 * Migration Runner Tests — TDD §20.5 Acceptance Criteria
 *
 * 1. Fresh install applies all migrations
 * 2. Existing Phase 4 DB upgrades without data loss
 * 3. Idempotent re-run
 * 4. Failed migration rolls back
 * 5. World Graph integrity preserved
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import type { Migration } from '../../src/db/migrations/migration-runner.ts';

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

describe('MigrationRunner', () => {
  // ── Acceptance Criterion 1: Fresh install ───────────────
  test('fresh install applies all migrations', () => {
    const result = runner.migrate(db, ALL_MIGRATIONS);

    expect(result.applied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
    expect(result.current).toBe(21);
    expect(result.pending).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);

    // Verify all tables exist
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('execution_traces');
    expect(tableNames).toContain('rejected_approaches');
    expect(tableNames).toContain('model_parameters');
    expect(tableNames).toContain('self_model_params');
    expect(tableNames).toContain('extracted_patterns');
    expect(tableNames).toContain('sleep_cycle_runs');
    expect(tableNames).toContain('shadow_jobs');
    expect(tableNames).toContain('cached_skills');
    expect(tableNames).toContain('evolutionary_rules');
    expect(tableNames).toContain('worker_profiles');
    expect(tableNames).toContain('session_store');
    expect(tableNames).toContain('session_tasks');
    expect(tableNames).toContain('instance_registry');
    expect(tableNames).toContain('schema_version');
    expect(tableNames).toContain('causal_edges');

    // Verify schema_version tracks all applied
    const versions = db.query('SELECT version FROM schema_version ORDER BY version').all() as { version: number }[];
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);

    // Verify oracle_profiles table from migration 005
    expect(tableNames).toContain('oracle_profiles');
  });

  // ── Acceptance Criterion 2: Upgrade without data loss ───
  test('existing Phase 4 DB upgrades without data loss', () => {
    // Simulate a Phase 4 DB by applying only migration 1
    const result1 = runner.migrate(db, [ALL_MIGRATIONS[0]!]);
    expect(result1.applied).toEqual([1]);

    // Insert some Phase 4 data
    db.run(
      `INSERT INTO execution_traces (id, task_id, timestamp, routing_level, approach, model_used, tokens_consumed, duration_ms, outcome, oracle_verdicts, affected_files)
       VALUES ('trace-1', 'task-1', ?, 1, 'test-approach', 'mock/test', 100, 500, 'success', '{}', '[]')`,
      [Date.now()],
    );
    db.run(
      `INSERT INTO worker_profiles (id, model_id, temperature, status, created_at, demotion_count)
       VALUES ('worker-1', 'mock/test', 0.7, 'active', ?, 0)`,
      [Date.now()],
    );

    // Now upgrade to latest (migrations 2-5)
    const result2 = runner.migrate(db, ALL_MIGRATIONS);
    expect(result2.applied).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
    expect(result2.current).toBe(21);

    // Verify existing data is intact
    const trace = db.query("SELECT id, approach FROM execution_traces WHERE id = 'trace-1'").get() as {
      id: string;
      approach: string;
    };
    expect(trace.id).toBe('trace-1');
    expect(trace.approach).toBe('test-approach');

    const worker = db.query("SELECT id, status FROM worker_profiles WHERE id = 'worker-1'").get() as {
      id: string;
      status: string;
    };
    expect(worker.id).toBe('worker-1');
    expect(worker.status).toBe('active');

    // Verify new tables exist
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('session_store', 'instance_registry')")
      .all() as { name: string }[];
    expect(tables.length).toBe(2);
  });

  // ── Acceptance Criterion 3: Idempotent re-run ───────────
  test('idempotent re-run applies 0 migrations', () => {
    runner.migrate(db, ALL_MIGRATIONS);

    // Second run
    const result = runner.migrate(db, ALL_MIGRATIONS);
    expect(result.applied).toEqual([]);
    expect(result.current).toBe(21);
    expect(result.pending).toEqual([]);
  });

  // ── Acceptance Criterion 4: Failed migration rolls back ─
  test('failed migration rolls back that migration only', () => {
    const failingMigration: Migration = {
      version: 99,
      description: 'This migration will fail',
      up(db: Database) {
        db.exec('CREATE TABLE test_fail_table (id TEXT PRIMARY KEY)');
        // This will throw — invalid SQL
        db.exec('INVALID SQL STATEMENT');
      },
    };

    // Apply good migrations first
    runner.migrate(db, ALL_MIGRATIONS);

    // Attempt the failing migration
    expect(() => {
      runner.migrate(db, [...ALL_MIGRATIONS, failingMigration]);
    }).toThrow();

    // Verify: good migrations applied, failed one rolled back
    const currentVersion = runner.getCurrentVersion(db);
    expect(currentVersion).toBe(21);

    // The table from the failed migration should NOT exist (rolled back)
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name = 'test_fail_table'").all();
    expect(tables.length).toBe(0);
  });

  // ── Acceptance Criterion 5: World Graph integrity ───────
  test('migrations preserve existing data integrity', () => {
    // Apply all migrations
    runner.migrate(db, ALL_MIGRATIONS);

    // Insert data with file hashes (A4: content-addressed truth)
    db.run(
      `INSERT INTO execution_traces (id, task_id, timestamp, routing_level, approach, model_used, tokens_consumed, duration_ms, outcome, oracle_verdicts, affected_files)
       VALUES ('trace-hash', 'task-hash', ?, 2, 'refactor', 'mock/test', 200, 1000, 'success', '{"ast": {"verified": true, "fileHashes": {"src/a.ts": "sha256:abc123"}}}', '["src/a.ts"]')`,
      [Date.now()],
    );

    // Re-run migrations (simulating upgrade)
    const result = runner.migrate(db, ALL_MIGRATIONS);
    expect(result.applied).toEqual([]);

    // Verify data with file hashes is intact
    const trace = db
      .query("SELECT oracle_verdicts, affected_files FROM execution_traces WHERE id = 'trace-hash'")
      .get() as { oracle_verdicts: string; affected_files: string };
    const verdicts = JSON.parse(trace.oracle_verdicts);
    expect(verdicts.ast.fileHashes['src/a.ts']).toBe('sha256:abc123');
    expect(JSON.parse(trace.affected_files)).toEqual(['src/a.ts']);
  });

  // ── getCurrentVersion ───────────────────────────────────
  test('getCurrentVersion returns 0 for fresh DB', () => {
    expect(runner.getCurrentVersion(db)).toBe(0);
  });

  test('getCurrentVersion returns latest after migration', () => {
    runner.migrate(db, ALL_MIGRATIONS);
    expect(runner.getCurrentVersion(db)).toBe(21);
  });

  // ── dryRun ──────────────────────────────────────────────
  test('dryRun returns pending without applying', () => {
    const result = runner.migrate(db, ALL_MIGRATIONS, { dryRun: true });
    expect(result.applied).toEqual([]);
    expect(result.current).toBe(0);
    expect(result.pending).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);

    // Verify NO tables were created (except schema_version from getCurrentVersion)
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name = 'execution_traces'").all();
    expect(tables.length).toBe(0);
  });

  test('dryRun after partial migration shows remaining', () => {
    runner.migrate(db, [ALL_MIGRATIONS[0]!]);

    const result = runner.migrate(db, ALL_MIGRATIONS, { dryRun: true });
    expect(result.applied).toEqual([]);
    expect(result.current).toBe(1);
    expect(result.pending).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
  });
});
