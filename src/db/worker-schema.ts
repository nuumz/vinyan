/**
 * Worker Profile Schema — SQLite table for fleet governance worker profiles.
 *
 * EngineProfile is a first-class entity pairing a specific configuration
 * with lifecycle state. Config itself lives in `engine_config` (JSON blob).
 * Stats are computed on-demand from traces — NOT stored here.
 *
 * Source of truth: design/implementation-plan.md §Phase 4.1
 */

export const WORKER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS worker_profiles (
  id                   TEXT PRIMARY KEY,
  model_id             TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'probation'
                       CHECK(status IN ('probation','active','demoted','retired')),
  created_at           INTEGER NOT NULL,
  promoted_at          INTEGER,
  demoted_at           INTEGER,
  demotion_reason      TEXT,
  demotion_count       INTEGER NOT NULL DEFAULT 0,
  engine_config        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wp_status ON worker_profiles(status);
CREATE INDEX IF NOT EXISTS idx_wp_model ON worker_profiles(model_id);
`;
