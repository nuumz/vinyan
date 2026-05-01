/**
 * Migration 032 — Skill proposal draft revisions.
 *
 * R2: every operator edit to a proposal's SKILL.md draft creates a
 * revision row. Lets the UI render an audit-trail panel ("v3 — alice
 * — 2 minutes ago — cleared injection markers") and lets a future
 * rollback flow restore an earlier draft without re-typing.
 *
 * Schema:
 *   - `proposal_id` + `profile` join with `skill_proposals`. Foreign
 *     key not declared so a hard delete of the proposal does not
 *     cascade — revisions stay as audit evidence (A8). Cleanup of
 *     orphaned revisions is a future operator action.
 *   - `revision` is the monotonic 1-indexed counter per
 *     `(profile, proposal_id)`. The first revision is the one written
 *     by `SkillProposalStore.create`.
 *   - `actor` mirrors the `decided_by` audit field: every revision
 *     names a human (or `auto-generator` for the initial create).
 *   - `safety_flags_json` is the verdict applied to *this* revision's
 *     bytes. Lets the UI compare "what flags fired in v2 vs v3"
 *     without re-running the scanner.
 *   - `created_at` epoch-ms.
 *
 * Index on `(profile, proposal_id, revision DESC)` powers the
 * "show last N revisions" UI query.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration032: Migration = {
  version: 32,
  description: 'skill_proposal_revisions — draft edit audit trail',
  up(db: Database) {
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

      -- G5: backfill revision 1 for any proposals that pre-date this
      -- migration. Without this, the proposals page would show "no
      -- history" for pre-existing rows. The backfill is idempotent —
      -- the UNIQUE (profile, proposal_id, revision) constraint
      -- ensures re-running this migration is a no-op.
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
        'initial create (backfilled by migration 032)',
        p.created_at
      FROM skill_proposals p
      WHERE NOT EXISTS (
        SELECT 1 FROM skill_proposal_revisions r
         WHERE r.profile = p.profile AND r.proposal_id = p.id
      );
    `);
  },
};
