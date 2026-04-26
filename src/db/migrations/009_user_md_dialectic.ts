/**
 * Migration 009 — USER.md dialectic user-model tables.
 *
 * Reserved slot per `docs/spec/w1-contracts.md` §2 for the W3 P3 USER.md
 * dialectic track. The user-model is stored as per-section rows (one row
 * per (profile, slug)) with each row carrying the falsifiable
 * `predicted_response` and its current ConfidenceTier. A companion table
 * ledgers per-turn observed-vs-predicted delta values so the rolling rule
 * in `src/orchestrator/user-context/dialectic.ts` has an authoritative
 * replay log (A3 + A7).
 *
 * Profile column: required per w1-contracts §3. All reads at the store
 * layer must filter on `profile`.
 *
 * IMPORTANT: this file does NOT register itself into
 * `src/db/migrations/index.ts` — the coordinator wires it in a separate
 * pass to avoid merge races with the other parallel W3 migrations.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration009: Migration = {
  version: 9,
  description: 'USER.md dialectic user-model sections + prediction-error ledger',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_md_sections (
        slug               TEXT NOT NULL,
        profile            TEXT NOT NULL DEFAULT 'default',
        heading            TEXT NOT NULL,
        body               TEXT NOT NULL,
        predicted_response TEXT NOT NULL,
        evidence_tier      TEXT NOT NULL
                             CHECK(evidence_tier IN (
                               'deterministic','heuristic','probabilistic','speculative'
                             )),
        confidence         REAL NOT NULL,
        last_revised_at    INTEGER,
        PRIMARY KEY (profile, slug)
      );

      CREATE TABLE IF NOT EXISTS user_md_prediction_errors (
        error_id  INTEGER PRIMARY KEY AUTOINCREMENT,
        profile   TEXT NOT NULL DEFAULT 'default',
        slug      TEXT NOT NULL,
        observed  TEXT NOT NULL,
        predicted TEXT NOT NULL,
        delta     REAL NOT NULL,
        turn_id   TEXT,
        ts        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ume_profile_slug_ts
        ON user_md_prediction_errors(profile, slug, ts);
    `);
  },
};
