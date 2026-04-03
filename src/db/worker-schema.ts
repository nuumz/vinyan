/**
 * Worker Profile Schema — SQLite table for fleet governance worker profiles.
 *
 * WorkerProfile is a first-class entity pairing a specific configuration
 * (model + temperature + prompt template) with lifecycle state.
 * Stats are computed on-demand from traces — NOT stored here.
 *
 * Source of truth: design/implementation-plan.md §Phase 4.1
 */

export const WORKER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS worker_profiles (
  id                   TEXT PRIMARY KEY,
  model_id             TEXT NOT NULL,
  model_version        TEXT,
  temperature          REAL NOT NULL DEFAULT 0.7,
  tool_allowlist       TEXT,
  system_prompt_tpl    TEXT DEFAULT 'default',
  max_context_tokens   INTEGER,
  project_id           TEXT,
  status               TEXT NOT NULL DEFAULT 'probation'
                       CHECK(status IN ('probation','active','demoted','retired')),
  created_at           INTEGER NOT NULL,
  promoted_at          INTEGER,
  demoted_at           INTEGER,
  demotion_reason      TEXT,
  demotion_count       INTEGER NOT NULL DEFAULT 0,
  -- RE-agnostic columns (migration 008)
  engine_type          TEXT DEFAULT 'llm',
  capabilities_declared TEXT,
  engine_config        TEXT
);

CREATE INDEX IF NOT EXISTS idx_wp_identity
  ON worker_profiles(model_id, temperature, system_prompt_tpl);
CREATE INDEX IF NOT EXISTS idx_wp_status ON worker_profiles(status);
CREATE INDEX IF NOT EXISTS idx_wp_model ON worker_profiles(model_id);
`;

/**
 * Additive migration: RE-agnostic columns for worker_profiles.
 *
 * engine_type:           'llm' | 'symbolic' | 'oracle' | 'hybrid' | 'external'
 * capabilities_declared: JSON array of capability strings (e.g. ["code-generation", "reasoning"])
 * engine_config:         JSON object — RE-specific config (replaces scattered LLM-specific columns)
 *
 * Legacy columns (model_id, temperature, system_prompt_tpl, max_context_tokens) are kept for
 * backward compatibility. New code should use engine_config for RE-specific parameters.
 */
export const WORKER_SCHEMA_MIGRATION_RE_AGNOSTIC = `
ALTER TABLE worker_profiles ADD COLUMN engine_type TEXT DEFAULT 'llm';
ALTER TABLE worker_profiles ADD COLUMN capabilities_declared TEXT;
ALTER TABLE worker_profiles ADD COLUMN engine_config TEXT;
`;
