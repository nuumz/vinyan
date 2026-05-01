/**
 * Migration 034 — repeat backfill for v32-late deployments.
 *
 * Verifies the migration:
 *   - fills missing revision rows for proposals that pre-date the
 *     mig032 second-wave backfill (deployments that ran the first
 *     cut of mig032 — CREATE TABLE only, no backfill — and advanced
 *     past v32 before the backfill cut landed).
 *   - is idempotent (re-running is a no-op).
 *   - does NOT rewrite revision rows already created by mig032.
 *   - is registered in `ALL_MIGRATIONS` so the runner picks it up at
 *     server startup.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';
import { migration029 } from '../../src/db/migrations/029_skill_proposals.ts';
import { migration032 } from '../../src/db/migrations/032_skill_proposal_revisions.ts';
import { migration034 } from '../../src/db/migrations/034_skill_proposal_revisions_rebackfill.ts';
import { ALL_MIGRATIONS } from '../../src/db/migrations/index.ts';
import { MigrationRunner } from '../../src/db/migrations/migration-runner.ts';

interface RevisionRow {
  profile: string;
  proposal_id: string;
  revision: number;
  actor: string;
  reason: string | null;
  created_at: number;
}

function setupBaseDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  // 001 = initial schema; 029 = skill_proposals.
  new MigrationRunner().migrate(db, [migration001, migration029]);
  return db;
}

/**
 * Mimic a deployment that ran the FIRST cut of mig032 — table + index
 * only, no backfill body. We re-create the table by hand (mig032's
 * CREATE TABLE IF NOT EXISTS) and stamp schema_version to 32 so the
 * runner skips mig032 entirely.
 */
function setupDbAtPostV32MissingBackfill(): Database {
  const db = setupBaseDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_proposal_revisions (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      profile             TEXT NOT NULL DEFAULT 'default',
      proposal_id         TEXT NOT NULL,
      revision            INTEGER NOT NULL,
      skill_md            TEXT NOT NULL,
      safety_flags_json   TEXT NOT NULL DEFAULT '[]',
      actor               TEXT NOT NULL,
      reason              TEXT,
      created_at          INTEGER NOT NULL,
      UNIQUE (profile, proposal_id, revision)
    );
    CREATE INDEX IF NOT EXISTS idx_skill_proposal_revisions_proposal
      ON skill_proposal_revisions(profile, proposal_id, revision DESC);
  `);
  db.run(
    'INSERT INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)',
    [32, 'skill_proposal_revisions (first cut, no backfill)', Date.now()],
  );
  return db;
}

function insertProposal(
  db: Database,
  opts: {
    id: string;
    profile?: string;
    name: string;
    skillMd: string;
    safetyFlags?: string;
    createdAt?: number;
  },
) {
  db.prepare(
    `INSERT INTO skill_proposals
       (id, profile, status, proposed_name, proposed_category, skill_md,
        capability_tags, tools_required, source_task_ids, evidence_event_ids,
        success_count, safety_flags, trust_tier, created_at)
     VALUES ($id, $profile, 'pending', $name, 'cat', $skill_md,
             '[]', '[]', '[]', '[]', 0, $safety_flags, 'quarantined', $created_at)`,
  ).run({
    $id: opts.id,
    $profile: opts.profile ?? 'default',
    $name: opts.name,
    $skill_md: opts.skillMd,
    $safety_flags: opts.safetyFlags ?? '[]',
    $created_at: opts.createdAt ?? Date.now(),
  });
}

function listRevisions(db: Database): RevisionRow[] {
  return db
    .query<RevisionRow, []>(
      'SELECT profile, proposal_id, revision, actor, reason, created_at FROM skill_proposal_revisions ORDER BY proposal_id, revision',
    )
    .all();
}

describe('Migration 034 — repeat backfill of skill_proposal_revisions', () => {
  test('past-v32 with missing revisions: mig034 fills them with its own reason', () => {
    const db = setupDbAtPostV32MissingBackfill();
    insertProposal(db, { id: 'prop-1', name: 'p1', skillMd: '# Skill 1', createdAt: 1000 });
    insertProposal(db, { id: 'prop-2', name: 'p2', skillMd: '# Skill 2', createdAt: 2000 });

    expect(listRevisions(db).length).toBe(0);

    migration034.up(db);

    const rows = listRevisions(db);
    expect(rows.length).toBe(2);
    expect(rows[0]?.proposal_id).toBe('prop-1');
    expect(rows[0]?.revision).toBe(1);
    expect(rows[0]?.actor).toBe('auto-generator');
    expect(rows[0]?.reason).toBe('initial create (backfilled by migration 034)');
    expect(rows[0]?.created_at).toBe(1000);
    expect(rows[1]?.proposal_id).toBe('prop-2');
    expect(rows[1]?.created_at).toBe(2000);
  });

  test('idempotent — second run does nothing (no duplicates, no overwrites)', () => {
    const db = setupDbAtPostV32MissingBackfill();
    insertProposal(db, { id: 'prop-A', name: 'pA', skillMd: '# A', createdAt: 5000 });

    migration034.up(db);
    const firstRows = listRevisions(db);
    expect(firstRows.length).toBe(1);

    migration034.up(db);
    const secondRows = listRevisions(db);
    expect(secondRows.length).toBe(1);
    expect(secondRows[0]?.reason).toBe('initial create (backfilled by migration 034)');
    expect(secondRows[0]?.created_at).toBe(5000);
  });

  test('does NOT overwrite rows already created by mig032 (preserves audit trail)', () => {
    // Build a DB where mig032 ran with the second-cut backfill, then
    // a new proposal landed AFTER mig032 was applied (so it has no
    // revision row even though mig032's reason text is the convention).
    const db = setupBaseDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS skill_proposal_revisions (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        profile             TEXT NOT NULL DEFAULT 'default',
        proposal_id         TEXT NOT NULL,
        revision            INTEGER NOT NULL,
        skill_md            TEXT NOT NULL,
        safety_flags_json   TEXT NOT NULL DEFAULT '[]',
        actor               TEXT NOT NULL,
        reason              TEXT,
        created_at          INTEGER NOT NULL,
        UNIQUE (profile, proposal_id, revision)
      );
    `);
    insertProposal(db, { id: 'prop-old', name: 'old', skillMd: '# old', createdAt: 100 });
    // Pre-populate prop-old's revision as if mig032 already backfilled it.
    db.run(
      `INSERT INTO skill_proposal_revisions
         (profile, proposal_id, revision, skill_md, safety_flags_json,
          actor, reason, created_at)
       VALUES ('default', 'prop-old', 1, '# old', '[]', 'auto-generator',
               'initial create (backfilled by migration 032)', 100)`,
    );
    insertProposal(db, { id: 'prop-new', name: 'new', skillMd: '# new', createdAt: 200 });

    migration034.up(db);

    const rows = listRevisions(db);
    expect(rows.length).toBe(2);
    const oldRow = rows.find((r) => r.proposal_id === 'prop-old');
    const newRow = rows.find((r) => r.proposal_id === 'prop-new');
    // mig032's reason text MUST be preserved on the existing row.
    expect(oldRow?.reason).toBe('initial create (backfilled by migration 032)');
    // mig034's reason text identifies the new row.
    expect(newRow?.reason).toBe('initial create (backfilled by migration 034)');
  });

  test('no proposals = no-op', () => {
    const db = setupDbAtPostV32MissingBackfill();
    migration034.up(db);
    expect(listRevisions(db).length).toBe(0);
  });

  test('full migration runner picks up mig034 from ALL_MIGRATIONS', () => {
    expect(ALL_MIGRATIONS.find((m) => m.version === 34)).toBe(migration034);
    expect(migration034.version).toBe(34);
    // ALL_MIGRATIONS is sorted by version; mig034 should be last.
    const versions = ALL_MIGRATIONS.map((m) => m.version);
    expect(Math.max(...versions)).toBe(34);
  });

  test('fresh DB through ALL_MIGRATIONS: revision rows present after mig032 runs in full', () => {
    // Sanity: the happy path (deployment that ran second-wave mig032)
    // already has revision rows; mig034 is a no-op. This guards
    // against accidentally rewriting existing rows on first deploy.
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    // Stop after mig029 so we can insert a proposal before mig032 runs.
    new MigrationRunner().migrate(db, [migration001, migration029]);
    insertProposal(db, { id: 'prop-fresh', name: 'fresh', skillMd: '# f', createdAt: 42 });
    // Now run 032 + 034 in version order.
    new MigrationRunner().migrate(db, [migration001, migration029, migration032, migration034]);

    const rows = listRevisions(db);
    expect(rows.length).toBe(1);
    // mig032 ran first and won the INSERT; mig034 saw the row and skipped.
    expect(rows[0]?.reason).toBe('initial create (backfilled by migration 032)');
  });
});
