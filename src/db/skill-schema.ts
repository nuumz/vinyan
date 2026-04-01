/**
 * Skill Schema — SQLite tables for cached skill patterns (L0 reflex shortcuts).
 *
 * Skills are formed from Sleep Cycle success patterns. Lifecycle: probation → active → demoted.
 * Risk-tiered verification: hash-only / structural / full.
 *
 * Source of truth: spec/tdd.md §12B (Skill Formation), Phase 2.5
 */

export const SKILL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cached_skills (
  task_signature       TEXT PRIMARY KEY,
  approach             TEXT NOT NULL,
  success_rate         REAL NOT NULL,
  status               TEXT NOT NULL CHECK(status IN ('probation', 'active', 'demoted')),
  probation_remaining  INTEGER NOT NULL DEFAULT 10,
  usage_count          INTEGER NOT NULL DEFAULT 0,
  risk_at_creation     REAL NOT NULL,
  dep_cone_hashes      TEXT NOT NULL,
  last_verified_at     INTEGER NOT NULL,
  verification_profile TEXT NOT NULL CHECK(verification_profile IN ('hash-only', 'structural', 'full'))
);

CREATE INDEX IF NOT EXISTS idx_skills_status ON cached_skills(status);
CREATE INDEX IF NOT EXISTS idx_skills_task_sig ON cached_skills(task_signature);
`;
