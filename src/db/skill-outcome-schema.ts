/**
 * `skill_outcomes` table — per-(persona, skill, task-signature) outcome tracking.
 *
 * Phase-3 separates this from `provider_trust_store` so that:
 *   - `bidderId` (provider id) keeps its cardinality bound for trust pooling.
 *   - Per-skill learning signal lives at the right granularity for Phase-4
 *     autonomous skill creation triggers (persona × task-signature × skill).
 *
 * The triple `(persona_id, skill_id, task_signature)` is the natural primary
 * key; queries fan out by any prefix when computing per-persona, per-skill,
 * or per-task-family Wilson LBs.
 */
export const SKILL_OUTCOME_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS skill_outcomes (
  persona_id      TEXT    NOT NULL,
  skill_id        TEXT    NOT NULL,
  task_signature  TEXT    NOT NULL,
  successes       INTEGER NOT NULL DEFAULT 0,
  failures        INTEGER NOT NULL DEFAULT 0,
  last_outcome_at INTEGER NOT NULL,
  PRIMARY KEY (persona_id, skill_id, task_signature)
);
CREATE INDEX IF NOT EXISTS idx_skill_outcomes_persona ON skill_outcomes(persona_id);
CREATE INDEX IF NOT EXISTS idx_skill_outcomes_skill ON skill_outcomes(skill_id);
CREATE INDEX IF NOT EXISTS idx_skill_outcomes_task ON skill_outcomes(task_signature);
`;
