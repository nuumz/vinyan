export const AGENT_PROPOSAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_proposals (
  id                         TEXT PRIMARY KEY,
  status                     TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','retired')),
  suggested_agent_id         TEXT NOT NULL,
  task_type_signature        TEXT NOT NULL,
  name                       TEXT NOT NULL,
  description                TEXT NOT NULL,
  unmet_capability_ids       TEXT NOT NULL,
  capability_claims          TEXT NOT NULL,
  roles                      TEXT NOT NULL,
  allowed_tools              TEXT NOT NULL,
  capability_overrides       TEXT NOT NULL,
  source_synthetic_agent_ids TEXT NOT NULL,
  evidence_trace_ids         TEXT NOT NULL,
  observation_count          INTEGER NOT NULL,
  success_count              INTEGER NOT NULL,
  wilson_lower_bound         REAL NOT NULL,
  trust_tier                 TEXT NOT NULL CHECK(trust_tier IN ('low','medium','high')),
  provenance                 TEXT NOT NULL,
  rationale                  TEXT NOT NULL,
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL,
  decided_at                 INTEGER,
  decision_reason            TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_proposals_status ON agent_proposals(status);
CREATE INDEX IF NOT EXISTS idx_agent_proposals_task_type ON agent_proposals(task_type_signature);
CREATE INDEX IF NOT EXISTS idx_agent_proposals_suggested_agent ON agent_proposals(suggested_agent_id);
`;
