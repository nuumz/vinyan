/**
 * Migration 034 — repeat the mig032 backfill for deployments that
 * advanced past v32 BEFORE the backfill block landed in mig032.
 *
 * Mig032 was published in two waves: the first cut shipped only the
 * `CREATE TABLE` + index; the backfill `INSERT OR IGNORE ... FROM
 * skill_proposals` was added later. Deployments that ran the first
 * cut have `schema_version >= 32` but no revision rows, so the
 * `/api/v1/skill-proposals/:id/revisions` UI returns "no history" for
 * proposals created before mig032. Re-running mig032 isn't an option —
 * the runner only applies a migration once per version.
 *
 * Mig034 carries the same `INSERT OR IGNORE` block. The
 * `UNIQUE (profile, proposal_id, revision)` constraint from mig032
 * makes it idempotent: deployments that already have revision rows
 * (because they ran the second-wave mig032) get a no-op; the rest
 * receive their backfilled v1 rows. Existing actor/reason/created_at
 * are never overwritten.
 *
 * Reason text differs from mig032 ('... migration 034' vs '...
 * migration 032') so audit logs can distinguish which pass populated
 * each row.
 *
 * Axioms upheld:
 *   A3 — deterministic SQL, replayable on identical input state.
 *   A8 — preserves audit evidence on existing rows; never destructive.
 *   A9 — idempotent; re-runs degrade safely to no-op.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration034: Migration = {
  version: 34,
  description: 'skill_proposal_revisions — repeat backfill for v32-late deployments',
  up(db: Database) {
    db.exec(`
      INSERT OR IGNORE INTO skill_proposal_revisions
        (profile, proposal_id, revision, skill_md, safety_flags_json,
         actor, reason, created_at)
      SELECT
        p.profile,
        p.id,
        1,
        p.skill_md,
        p.safety_flags,
        'auto-generator',
        'initial create (backfilled by migration 034)',
        p.created_at
      FROM skill_proposals p
      WHERE NOT EXISTS (
        SELECT 1 FROM skill_proposal_revisions r
         WHERE r.profile = p.profile AND r.proposal_id = p.id
      );
    `);
  },
};
