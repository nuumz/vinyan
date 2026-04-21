/**
 * Migration Runner Tests — TDD §20.5 Acceptance Criteria
 *
 * After the 2026-04-20 consolidation, the 41 historical migrations are
 * squashed into a single `001_initial_schema.ts`. These tests verify the
 * runner's contract (version tracking, idempotency, rollback on failure,
 * dry-run) against that single-migration baseline.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';
import type { Migration } from '../../src/db/migrations/migration-runner.ts';

/**
 * These tests predate the W1–W2 migrations (003/004/005/006/007). They
 * assert properties about the *init* migration specifically — "fresh install
 * applies the consolidated init", "dryRun returns pending=[1]", etc. — so
 * they pin against `[migration001]` rather than the live `ALL_MIGRATIONS`
 * array that keeps growing with each wave. The "live state" tests
 * (idempotent re-run, data integrity, failed migration rollback) continue
 * to use `ALL_MIGRATIONS` because that's where their semantic lives.
 */
const INIT_ONLY: Migration[] = [migration001];

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
  test('fresh install applies the consolidated init migration', () => {
    const result = runner.migrate(db, INIT_ONLY);

    expect(result.applied).toEqual([1]);
    expect(result.current).toBe(1);
    expect(result.pending).toEqual([1]);

    // Verify core tables exist
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
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
    expect(tableNames).toContain('session_turns');
    expect(tableNames).toContain('instance_registry');
    expect(tableNames).toContain('oracle_profiles');
    expect(tableNames).toContain('schema_version');
    expect(tableNames).toContain('causal_edges');

    // Ecosystem tables (O1-O4)
    expect(tableNames).toContain('agent_runtime');
    expect(tableNames).toContain('agent_runtime_transitions');
    expect(tableNames).toContain('commitments');
    expect(tableNames).toContain('teams');
    expect(tableNames).toContain('team_members');
    expect(tableNames).toContain('volunteer_offers');
    expect(tableNames).toContain('engine_helpfulness');
    // team_blackboard was intentionally dropped — filesystem is truth.
    expect(tableNames).not.toContain('team_blackboard');

    // Agent identity — narrative columns are NOT in DB (soul.md is truth).
    const agentCtxCols = db
      .query("PRAGMA table_info('agent_contexts')")
      .all() as Array<{ name: string }>;
    const ctxColNames = new Set(agentCtxCols.map((c) => c.name));
    expect(ctxColNames.has('persona')).toBe(false);
    expect(ctxColNames.has('soul_md')).toBe(false);
    expect(ctxColNames.has('anti_patterns')).toBe(false);
    expect(ctxColNames.has('pending_insights')).toBe(true);
    expect(ctxColNames.has('proficiencies')).toBe(true);
    expect(ctxColNames.has('episodes')).toBe(true);

    // Verify schema_version tracks the single applied migration
    const versions = db
      .query('SELECT version FROM schema_version ORDER BY version')
      .all() as { version: number }[];
    expect(versions.map((v) => v.version)).toEqual([1]);
  });

  // ── Acceptance Criterion 2: Idempotent re-run ───────────
  test('idempotent re-run applies 0 migrations', () => {
    const first = runner.migrate(db, ALL_MIGRATIONS);
    const highestVersion = Math.max(...ALL_MIGRATIONS.map((m) => m.version));

    const result = runner.migrate(db, ALL_MIGRATIONS);
    expect(result.applied).toEqual([]);
    expect(result.current).toBe(highestVersion);
    expect(result.pending).toEqual([]);
    expect(first.current).toBe(highestVersion);
  });

  // ── Acceptance Criterion 3: Failed migration rolls back ─
  test('failed migration rolls back that migration only', () => {
    const failingMigration: Migration = {
      version: 99,
      description: 'This migration will fail',
      up(db: Database) {
        db.exec('CREATE TABLE test_fail_table (id TEXT PRIMARY KEY)');
        // Invalid SQL — the runner should rollback this migration entirely.
        db.exec('INVALID SQL STATEMENT');
      },
    };

    // Apply the good init migration first
    runner.migrate(db, ALL_MIGRATIONS);
    const highestVersion = Math.max(...ALL_MIGRATIONS.map((m) => m.version));

    expect(() => {
      runner.migrate(db, [...ALL_MIGRATIONS, failingMigration]);
    }).toThrow();

    // Good migrations applied, failing one rolled back
    expect(runner.getCurrentVersion(db)).toBe(highestVersion);

    // The table from the failed migration should NOT exist (rolled back)
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name = 'test_fail_table'")
      .all();
    expect(tables.length).toBe(0);
  });

  // ── Acceptance Criterion 4: Data integrity preserved ────
  test('migrations preserve existing data integrity on re-run', () => {
    runner.migrate(db, ALL_MIGRATIONS);

    db.run(
      `INSERT INTO execution_traces (id, task_id, timestamp, routing_level, approach, model_used, tokens_consumed, duration_ms, outcome, oracle_verdicts, affected_files)
       VALUES ('trace-hash', 'task-hash', ?, 2, 'refactor', 'mock/test', 200, 1000, 'success', '{"ast": {"verified": true, "fileHashes": {"src/a.ts": "sha256:abc123"}}}', '["src/a.ts"]')`,
      [Date.now()],
    );

    // Re-run migrations (simulating a no-op boot)
    const result = runner.migrate(db, ALL_MIGRATIONS);
    expect(result.applied).toEqual([]);

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

  test('getCurrentVersion returns 1 after running init', () => {
    runner.migrate(db, INIT_ONLY);
    expect(runner.getCurrentVersion(db)).toBe(1);
  });

  // ── dryRun ──────────────────────────────────────────────
  test('dryRun returns pending without applying', () => {
    const result = runner.migrate(db, INIT_ONLY, { dryRun: true });
    expect(result.applied).toEqual([]);
    expect(result.current).toBe(0);
    expect(result.pending).toEqual([1]);

    // Verify NO tables were created (except schema_version from getCurrentVersion)
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name = 'execution_traces'")
      .all();
    expect(tables.length).toBe(0);
  });
});
