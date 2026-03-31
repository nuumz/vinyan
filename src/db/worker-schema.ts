/**
 * Worker Profile Schema — SQLite table for fleet governance worker profiles.
 *
 * WorkerProfile is a first-class entity pairing a specific configuration
 * (model + temperature + prompt template) with lifecycle state.
 * Stats are computed on-demand from traces — NOT stored here.
 *
 * Source of truth: vinyan-implementation-plan.md §Phase 4.1
 */

export const WORKER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS worker_profiles (
  id                 TEXT PRIMARY KEY,
  model_id           TEXT NOT NULL,
  model_version      TEXT,
  temperature        REAL NOT NULL DEFAULT 0.7,
  tool_allowlist     TEXT,
  system_prompt_tpl  TEXT DEFAULT 'default',
  max_context_tokens INTEGER,
  status             TEXT NOT NULL DEFAULT 'probation'
                     CHECK(status IN ('probation','active','demoted','retired')),
  created_at         INTEGER NOT NULL,
  promoted_at        INTEGER,
  demoted_at         INTEGER,
  demotion_reason    TEXT,
  demotion_count     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_wp_status ON worker_profiles(status);
CREATE INDEX IF NOT EXISTS idx_wp_model ON worker_profiles(model_id);
`;
