/**
 * Migration 029 — Skill Proposals.
 *
 * Hermes lesson (`features/skills`): a verified repeated success or a
 * corrected failure should turn into a skill proposal — but only as a
 * **quarantined** artifact until trust is established. Auto-activating
 * generated skills would violate Vinyan's A6 (zero-trust execution) and
 * A8 (traceable accountability — every skill activation must be a
 * recorded human decision).
 *
 * Schema design:
 *   - `id` is the canonical proposal id (UUID).
 *   - `profile` scopes the row (w1-contracts §3) so a profile-A proposal
 *     never leaks into profile-B's catalog.
 *   - `status` is the lifecycle enum: `pending` (just generated),
 *     `approved` (human accepted; the artifact has been written to the
 *     skill registry), `rejected` (human declined), `quarantined`
 *     (security scanner flagged something dangerous).
 *   - `source_task_ids` is a JSON array of task ids that contributed
 *     to this proposal — provenance for A8 replay.
 *   - `evidence_event_ids` is a JSON array of recorder event ids that
 *     fired the trigger (e.g. `skill:outcome` ids with success=true).
 *   - `safety_flags` mirrors `memorySafetyVerdict.flags` from
 *     `src/memory/snapshot.ts` so the operator sees why a proposal
 *     landed in quarantine without re-running the scanner.
 *   - `skill_md` carries the full SKILL.md draft. `tools_required` and
 *     `capability_tags` are JSON arrays surfaced in the UI without
 *     parsing the markdown.
 *
 * No FTS5 — proposals are a small set; LIKE filter is fine. Indexes
 * for the operator console: `(profile, status, created_at)`.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration029: Migration = {
  version: 29,
  description: 'skill_proposals — agent-managed skill quarantine + provenance',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS skill_proposals (
        id                 TEXT PRIMARY KEY,
        profile            TEXT NOT NULL DEFAULT 'default',
        status             TEXT NOT NULL DEFAULT 'pending'
                             CHECK(status IN ('pending','approved','rejected','quarantined')),
        proposed_name      TEXT NOT NULL,
        proposed_category  TEXT NOT NULL,
        skill_md           TEXT NOT NULL,
        capability_tags    TEXT NOT NULL DEFAULT '[]',
        tools_required     TEXT NOT NULL DEFAULT '[]',
        source_task_ids    TEXT NOT NULL DEFAULT '[]',
        evidence_event_ids TEXT NOT NULL DEFAULT '[]',
        success_count      INTEGER NOT NULL DEFAULT 0,
        safety_flags       TEXT NOT NULL DEFAULT '[]',
        trust_tier         TEXT NOT NULL DEFAULT 'quarantined'
                             CHECK(trust_tier IN ('quarantined','community','trusted','official','builtin')),
        created_at         INTEGER NOT NULL,
        decided_at         INTEGER,
        decided_by         TEXT,
        decision_reason    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_skill_proposals_status
        ON skill_proposals(profile, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_skill_proposals_name
        ON skill_proposals(profile, proposed_name);
    `);
  },
};
