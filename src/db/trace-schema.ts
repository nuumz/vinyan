/**
 * SQLite schema for ExecutionTrace persistence.
 *
 * Denormalized QualityScore columns for efficient Sleep Cycle queries.
 * Source of truth: spec/tdd.md §12B, implementation-plan.md §2.3
 */

export const TRACE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS execution_traces (
  id                     TEXT PRIMARY KEY,
  task_id                TEXT NOT NULL,
  session_id             TEXT,
  worker_id              TEXT,
  agent_id               TEXT,
  timestamp              INTEGER NOT NULL,
  routing_level          INTEGER NOT NULL,
  task_type_signature    TEXT,
  approach               TEXT NOT NULL,
  approach_description   TEXT,
  risk_score             REAL,
  quality_composite      REAL,
  quality_arch           REAL,
  quality_efficiency     REAL,
  quality_simplification REAL,
  quality_testmutation   REAL,
  model_used             TEXT NOT NULL,
  tokens_consumed        INTEGER NOT NULL,
  duration_ms            INTEGER NOT NULL,
  outcome                TEXT NOT NULL CHECK(outcome IN ('success','failure','timeout','escalated')),
  failure_reason         TEXT,
  oracle_verdicts        TEXT NOT NULL,
  affected_files         TEXT NOT NULL,
  prediction_error       TEXT,
  validation_depth       TEXT,
  shadow_validation      TEXT,
  exploration            INTEGER,
  framework_markers      TEXT,
  worker_selection_audit TEXT,
  pipeline_confidence_composite REAL,
  confidence_decision    TEXT,
  transcript_gzip        BLOB,
  transcript_turns       INTEGER,
  thinking_mode          TEXT,
  thinking_tokens_used   INTEGER,
  thinking_meta          TEXT,
  understanding_depth    INTEGER,
  understanding_intent   TEXT,
  resolved_entities      TEXT,
  understanding_verified INTEGER DEFAULT 0,
  understanding_primary_action TEXT,
  agent_selection_reason TEXT,
  capability_requirements TEXT,
  capability_analysis     TEXT,
  selected_capability_profile_id TEXT,
  selected_capability_profile_source TEXT,
  selected_capability_profile_trust_tier TEXT,
  capability_fit_score REAL,
  unmet_capability_ids TEXT,
  synthetic_agent_id      TEXT,
  knowledge_used          TEXT,
  governance_provenance   TEXT,
  routing_decision_id     TEXT,
  policy_version          TEXT,
  governance_actor        TEXT,
  decision_timestamp      INTEGER,
  evidence_observed_at    INTEGER,
  goal_grounding          TEXT,
  oracle_independence     TEXT
);

CREATE INDEX IF NOT EXISTS idx_et_task_type ON execution_traces(task_type_signature);
CREATE INDEX IF NOT EXISTS idx_et_outcome ON execution_traces(outcome);
CREATE INDEX IF NOT EXISTS idx_et_timestamp ON execution_traces(timestamp);
CREATE INDEX IF NOT EXISTS idx_et_quality ON execution_traces(quality_composite);
CREATE INDEX IF NOT EXISTS idx_et_approach ON execution_traces(task_type_signature, approach);
CREATE INDEX IF NOT EXISTS idx_et_worker_id ON execution_traces(worker_id);
CREATE INDEX IF NOT EXISTS idx_et_agent_id ON execution_traces(agent_id);
CREATE INDEX IF NOT EXISTS idx_primary_action ON execution_traces(understanding_primary_action);
CREATE INDEX IF NOT EXISTS idx_et_routing_decision_id ON execution_traces(routing_decision_id);
CREATE INDEX IF NOT EXISTS idx_et_policy_version ON execution_traces(policy_version);
CREATE INDEX IF NOT EXISTS idx_et_governance_actor ON execution_traces(governance_actor);
CREATE INDEX IF NOT EXISTS idx_et_decision_timestamp ON execution_traces(decision_timestamp);
`;

/**
 * Safe migration for pipeline confidence columns.
 * Uses PRAGMA table_info to check if columns already exist before altering.
 */
export function migratePipelineConfidenceColumns(db: import('bun:sqlite').Database): void {
  const columns = db.prepare('PRAGMA table_info(execution_traces)').all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has('pipeline_confidence_composite')) {
    db.exec('ALTER TABLE execution_traces ADD COLUMN pipeline_confidence_composite REAL');
  }
  if (!columnNames.has('confidence_decision')) {
    db.exec('ALTER TABLE execution_traces ADD COLUMN confidence_decision TEXT');
  }
}

/**
 * Safe migration for transcript storage columns.
 * Uses PRAGMA table_info to check if columns already exist before altering.
 */
export function migrateTranscriptColumns(db: import('bun:sqlite').Database): void {
  const columns = db.prepare('PRAGMA table_info(execution_traces)').all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has('transcript_gzip')) {
    db.exec('ALTER TABLE execution_traces ADD COLUMN transcript_gzip BLOB');
  }
  if (!columnNames.has('transcript_turns')) {
    db.exec('ALTER TABLE execution_traces ADD COLUMN transcript_turns INTEGER');
  }
}

export const MODEL_PARAMS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS model_parameters (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/**
 * Safe migration for Extensible Thinking columns.
 * Phase 0: thinking_mode TEXT + thinking_tokens_used INTEGER
 * Phase 1b: thinking_meta TEXT (JSON metadata for thinking policy audit trail)
 */
export function migrateThinkingColumns(db: import('bun:sqlite').Database): void {
  const columns = db.prepare('PRAGMA table_info(execution_traces)').all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((c) => c.name));

  // Phase 0: minimal columns
  if (!columnNames.has('thinking_mode')) {
    db.exec('ALTER TABLE execution_traces ADD COLUMN thinking_mode TEXT');
  }
  if (!columnNames.has('thinking_tokens_used')) {
    db.exec('ALTER TABLE execution_traces ADD COLUMN thinking_tokens_used INTEGER');
  }
  // Phase 1b: JSON metadata column
  if (!columnNames.has('thinking_meta')) {
    db.exec('ALTER TABLE execution_traces ADD COLUMN thinking_meta TEXT');
  }
}

/** PH3.2: Per-task-type Self-Model parameter storage. */
export const SELF_MODEL_PARAMS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS self_model_params (
  task_type_signature   TEXT PRIMARY KEY,
  observation_count     INTEGER NOT NULL DEFAULT 0,
  avg_quality_score     REAL NOT NULL DEFAULT 0.5,
  avg_duration_per_file REAL NOT NULL DEFAULT 2000,
  prediction_accuracy   REAL NOT NULL DEFAULT 0.5,
  fail_rate             REAL NOT NULL DEFAULT 0.0,
  partial_rate          REAL NOT NULL DEFAULT 0.1,
  last_updated          INTEGER NOT NULL,
  basis                 TEXT NOT NULL DEFAULT 'static-heuristic'
);
`;
