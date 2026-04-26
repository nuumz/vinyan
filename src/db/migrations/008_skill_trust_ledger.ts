/**
 * Migration 008 — Skills Hub import trust ledger.
 *
 * Reserved slot per `docs/spec/w1-contracts.md` §2 for the W3 SK3 Skills
 * Hub import pipeline. Every state transition an imported skill goes through
 * — fetched, scanned, quarantined, dry-run, critic-reviewed, promoted,
 * demoted, retired, rejected — writes one row here. Promotion/demotion
 * decisions are rule-based (A3); this table is the replay log that proves
 * the deterministic governance held.
 *
 * Profile column: required per w1-contracts §3. All reads at the store
 * layer must filter on `profile`.
 *
 * IMPORTANT: this file does NOT register itself into
 * `src/db/migrations/index.ts` — the coordinator wires it in a separate
 * pass to avoid merge races with parallel W3 migrations.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration008: Migration = {
  version: 8,
  description: 'Skills Hub import trust ledger',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS skill_trust_ledger (
        ledger_id        INTEGER PRIMARY KEY AUTOINCREMENT,
        profile          TEXT NOT NULL DEFAULT 'default',
        skill_id         TEXT NOT NULL,
        event            TEXT NOT NULL CHECK(event IN
          ('fetched','scanned','quarantined','dry_run','critic_reviewed',
           'promoted','demoted','retired','rejected')),
        from_status      TEXT,
        to_status        TEXT,
        from_tier        TEXT,
        to_tier          TEXT,
        evidence_json    TEXT NOT NULL,
        rule_id          TEXT,
        created_at       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_skill_trust_ledger_profile_skill
        ON skill_trust_ledger(profile, skill_id);
      CREATE INDEX IF NOT EXISTS idx_skill_trust_ledger_created
        ON skill_trust_ledger(created_at);
    `);
  },
};
