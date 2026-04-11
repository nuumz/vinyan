/**
 * Rule Schema — SQLite tables for evolutionary rules.
 *
 * Rules are mined from Sleep Cycle patterns and backtested before activation.
 * Lifecycle: probation → active → retired.
 * 6 immutable safety invariants enforced on every rule application.
 *
 * Source of truth: spec/tdd.md §2 (Evolution Engine), Phase 2.6
 */

export const RULE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS evolutionary_rules (
  id              TEXT PRIMARY KEY,
  source          TEXT NOT NULL CHECK(source IN ('sleep-cycle', 'manual')),
  condition       TEXT NOT NULL,
  action          TEXT NOT NULL CHECK(action IN ('escalate', 'require-oracle', 'prefer-model', 'adjust-threshold', 'assign-worker')),
  parameters      TEXT NOT NULL,
  status          TEXT NOT NULL CHECK(status IN ('probation', 'active', 'retired')),
  created_at      INTEGER NOT NULL,
  effectiveness   REAL NOT NULL DEFAULT 0.0,
  specificity     INTEGER NOT NULL DEFAULT 0,
  superseded_by   TEXT,
  origin          TEXT CHECK(origin IN ('local', 'a2a', 'mcp')) DEFAULT 'local'
);

CREATE INDEX IF NOT EXISTS idx_rules_status ON evolutionary_rules(status);
CREATE INDEX IF NOT EXISTS idx_rules_action ON evolutionary_rules(action);
`;
