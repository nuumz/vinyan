/**
 * Migration 005 — Trajectory Exports manifest-pointer table.
 *
 * Reserved slot per w1-contracts §2 for PR #4 (Trajectory Exporter).
 *
 * This table is a pointer only — artifacts live on disk at
 * `$VINYAN_HOME/trajectories/<dataset_id>/`. The DB row is the manifest
 * index: it records what was exported, when, under which redaction policy
 * hash, and the artifact SHA-256 so any tampering is visible.
 *
 * Invariants:
 *   - `dataset_id` is a deterministic first-16-hex of SHA-256 over the
 *     export filter + redaction policy hash + row count.
 *   - `profile` column per w1 §3 — every new table carries profile scope.
 *   - `artifact_sha256` is computed AFTER redaction, so bypassing the policy
 *     changes the hash and is observable from this row alone.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration005: Migration = {
  version: 5,
  description: 'Trajectory exports manifest-pointer table',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS trajectory_exports (
        dataset_id             TEXT PRIMARY KEY,
        profile                TEXT NOT NULL DEFAULT 'default',
        format                 TEXT NOT NULL,
        schema_version         TEXT NOT NULL,
        manifest_path          TEXT NOT NULL,
        artifact_path          TEXT NOT NULL,
        artifact_sha256        TEXT NOT NULL,
        redaction_policy_hash  TEXT NOT NULL,
        row_count              INTEGER NOT NULL,
        created_at             INTEGER NOT NULL,
        filter_json            TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trajexport_profile_created
        ON trajectory_exports(profile, created_at);
    `);
  },
};
