/**
 * Migration 001 — Initial Schema (Phase 0-4 baseline)
 *
 * Consolidates all existing CREATE TABLE IF NOT EXISTS statements
 * from the 6 schema files into a single versioned migration.
 * Safe for both fresh installs and existing Phase 4 databases.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration001: Migration = {
  version: 1,
  description: 'Initial schema — Phase 0-4 baseline tables',
  up(db: Database) {
    // ── Trace Store (Phase 1) ─────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS execution_traces (
        id                     TEXT PRIMARY KEY,
        task_id                TEXT NOT NULL,
        session_id             TEXT,
        worker_id              TEXT,
        timestamp              INTEGER NOT NULL,
        routing_level          INTEGER NOT NULL,
        task_type_signature   TEXT,
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
        worker_selection_audit TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_et_task_type ON execution_traces(task_type_signature);
      CREATE INDEX IF NOT EXISTS idx_et_outcome ON execution_traces(outcome);
      CREATE INDEX IF NOT EXISTS idx_et_timestamp ON execution_traces(timestamp);
      CREATE INDEX IF NOT EXISTS idx_et_quality ON execution_traces(quality_composite);
      CREATE INDEX IF NOT EXISTS idx_et_approach ON execution_traces(task_type_signature, approach);
      CREATE INDEX IF NOT EXISTS idx_et_worker_id ON execution_traces(worker_id);
    `);

    // ── Model Parameters (Phase 1) ───────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS model_parameters (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // ── Self-Model Parameters (Phase 3) ──────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS self_model_params (
        task_type_signature  TEXT PRIMARY KEY,
        observation_count     INTEGER NOT NULL DEFAULT 0,
        avg_quality_score     REAL NOT NULL DEFAULT 0.5,
        avg_duration_per_file REAL NOT NULL DEFAULT 2000,
        prediction_accuracy   REAL NOT NULL DEFAULT 0.5,
        fail_rate             REAL NOT NULL DEFAULT 0.0,
        partial_rate          REAL NOT NULL DEFAULT 0.1,
        last_updated          INTEGER NOT NULL,
        basis                 TEXT NOT NULL DEFAULT 'static-heuristic'
      );
    `);

    // ── Patterns (Phase 2) ───────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS extracted_patterns (
        id                  TEXT PRIMARY KEY,
        type                TEXT NOT NULL CHECK(type IN ('anti-pattern', 'success-pattern', 'worker-performance')),
        description         TEXT NOT NULL,
        frequency           INTEGER NOT NULL,
        confidence          REAL NOT NULL,
        task_type_signature TEXT NOT NULL,
        approach            TEXT,
        compared_approach   TEXT,
        quality_delta       REAL,
        source_trace_ids    TEXT NOT NULL,
        created_at          INTEGER NOT NULL,
        expiresAt          INTEGER,
        decay_weight        REAL NOT NULL DEFAULT 1.0,
        derived_from        TEXT,
        worker_id           TEXT,
        compared_worker_id  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_patterns_type ON extracted_patterns(type);
      CREATE INDEX IF NOT EXISTS idx_patterns_task_sig ON extracted_patterns(task_type_signature);
      CREATE INDEX IF NOT EXISTS idx_patterns_created ON extracted_patterns(created_at);

      CREATE TABLE IF NOT EXISTS sleep_cycle_runs (
        id            TEXT PRIMARY KEY,
        startedAt    INTEGER NOT NULL,
        completed_at  INTEGER,
        traces_analyzed INTEGER NOT NULL DEFAULT 0,
        patterns_found  INTEGER NOT NULL DEFAULT 0,
        status        TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed'))
      );
    `);

    // ── Shadow Jobs (Phase 2) ────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS shadow_jobs (
        id           TEXT PRIMARY KEY,
        task_id      TEXT NOT NULL,
        status       TEXT NOT NULL CHECK(status IN ('pending', 'running', 'done', 'failed')),
        enqueued_at  INTEGER NOT NULL,
        started_at   INTEGER,
        completed_at INTEGER,
        result       TEXT,
        mutations    TEXT NOT NULL,
        retry_count  INTEGER NOT NULL DEFAULT 0,
        max_retries  INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_shadow_status ON shadow_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_shadow_task_id ON shadow_jobs(task_id);
    `);

    // ── Skills (Phase 2) ─────────────────────────────────
    db.exec(`
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
    `);

    // ── Rules (Phase 2) ──────────────────────────────────
    db.exec(`
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
        superseded_by   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_rules_status ON evolutionary_rules(status);
      CREATE INDEX IF NOT EXISTS idx_rules_action ON evolutionary_rules(action);
    `);

    // ── Worker Profiles (Phase 4) ────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS worker_profiles (
        id                 TEXT PRIMARY KEY,
        model_id           TEXT NOT NULL,
        model_version      TEXT,
        temperature        REAL NOT NULL DEFAULT 0.7,
        tool_allowlist     TEXT,
        system_prompt_tpl  TEXT DEFAULT 'default',
        max_context_tokens INTEGER,
        project_id         TEXT,
        status             TEXT NOT NULL DEFAULT 'probation'
                           CHECK(status IN ('probation','active','demoted','retired')),
        created_at         INTEGER NOT NULL,
        promoted_at        INTEGER,
        demoted_at         INTEGER,
        demotion_reason    TEXT,
        demotion_count     INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_wp_identity
        ON worker_profiles(model_id, temperature, system_prompt_tpl);
      CREATE INDEX IF NOT EXISTS idx_wp_status ON worker_profiles(status);
      CREATE INDEX IF NOT EXISTS idx_wp_model ON worker_profiles(model_id);
    `);
  },
};
