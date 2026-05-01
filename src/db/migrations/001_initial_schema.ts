/**
 * Migration 001 — Initial schema (consolidated post-035).
 *
 * Replaces what used to be a chain of 41 + 29 historical migrations with
 * the single post-035 final schema. The 2026-04-20 consolidation rolled
 * up the pre-1.0 chain (1-41) into the §1-§11 SQL block below. The
 * 2026-05-02 consolidation rolls up the post-041 incremental DDL
 * migrations (003-033) by importing each one from the `./_squashed/`
 * directory and running them in version order at the end of `up()`.
 *
 * Why subfolder + import instead of inlining all SQL:
 *   - Per-migration tests (`tests/db/migration-runner.test.ts`,
 *     `tests/db/skill-trust-ledger-store.test.ts`, etc.) import the
 *     migration object by name to wire only the schema they need. Keeping
 *     the source files preserves that contract — they just live one
 *     directory deeper.
 *   - The migration runner's `ALL_MIGRATIONS` list (in `index.ts`) NO
 *     LONGER lists migrations 003-033 individually. They run as part of
 *     `migration001.up()` on fresh installs, exactly once, gated by the
 *     runner's `version <= currentVersion` check.
 *
 * History was archaeological noise from pre-1.0 iteration (add column,
 * drop column, rename, etc.); nothing externally depended on the
 * intermediate states. Squashing gives:
 *
 *   - 1 ALTER-free CREATE pass on fresh DBs (fast, clean).
 *   - A schema file anyone can read top-to-bottom to understand storage.
 *   - No cross-migration dependency puzzles.
 *
 * NOTE: every step is idempotent — every CREATE is `IF NOT EXISTS`,
 * every backfill INSERT is `OR IGNORE`, every column add is gated by a
 * try/catch in the underlying migration where applicable.
 *
 * Tables grouped by subsystem (reading order):
 *   §1 Core telemetry:         execution_traces
 *   §2 Self-model & patterns:  self_model_params, model_parameters,
 *                              extracted_patterns, sleep_cycle_runs,
 *                              evolutionary_rules, cached_skills,
 *                              rejected_approaches, shadow_jobs, causal_edges
 *   §3 Fleet:                  worker_profiles, local_oracle_profiles
 *   §4 A2A / federation:       instance_registry, oracle_profiles,
 *                              peer_pricing, federation_budget
 *   §5 Economy / market:       cost_ledger, budget_snapshots, bid_records,
 *                              settlement_records, bid_accuracy,
 *                              auction_records, market_phase
 *   §6 Session / conversation: session_store, session_tasks, session_turns
 *   §7 Rooms:                  room_sessions, room_participants,
 *                              room_ledger, room_blackboard
 *   §8 Agent identity:         agent_profile, agent_contexts
 *   §9 Comprehension learning: comprehension_records
 *   §10 Ecosystem (O1-O4):     agent_runtime, agent_runtime_transitions,
 *                              commitments, teams, team_members,
 *                              volunteer_offers, engine_helpfulness
 *   §11 Semantic retrieval:    turn_embeddings (sqlite-vec; conditional)
 *   §12 Squashed post-041:     migrations 003-033 — see `./_squashed/`
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';
import { AGENT_PROPOSAL_SCHEMA_SQL } from '../agent-proposal-schema.ts';
import { PERSONA_OVERCLAIM_SCHEMA_SQL } from '../persona-overclaim-schema.ts';
import { SKILL_OUTCOME_SCHEMA_SQL } from '../skill-outcome-schema.ts';

export const EMBEDDING_DIMENSION = 1024;

export const migration001: Migration = {
  version: 1,
  description: 'Initial consolidated schema (squashed from 41 historical migrations + 29 post-041 DDL)',
  up(db: Database) {
    db.exec(`
      -- §1 Core telemetry --------------------------------------------------

      CREATE TABLE IF NOT EXISTS execution_traces (
        id                        TEXT PRIMARY KEY,
        task_id                   TEXT NOT NULL,
        session_id                TEXT,
        worker_id                 TEXT,
        agent_id                  TEXT,
        timestamp                 INTEGER NOT NULL,
        routing_level             INTEGER NOT NULL,
        task_type_signature       TEXT,
        approach                  TEXT NOT NULL,
        approach_description      TEXT,
        risk_score                REAL,
        quality_composite         REAL,
        quality_arch              REAL,
        quality_efficiency        REAL,
        quality_simplification    REAL,
        quality_testmutation      REAL,
        model_used                TEXT NOT NULL,
        tokens_consumed           INTEGER NOT NULL,
        duration_ms               INTEGER NOT NULL,
        outcome                   TEXT NOT NULL
                                    CHECK(outcome IN ('success','failure','timeout','escalated')),
        failure_reason            TEXT,
        oracle_verdicts           TEXT NOT NULL,
        affected_files            TEXT NOT NULL,
        prediction_error          TEXT,
        validation_depth          TEXT,
        shadow_validation         TEXT,
        exploration               INTEGER,
        framework_markers         TEXT,
        worker_selection_audit    TEXT,
        understanding_depth       INTEGER,
        understanding_intent      TEXT,
        resolved_entities         TEXT,
        understanding_verified    INTEGER DEFAULT 0,
        understanding_primary_action TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_et_task_type     ON execution_traces(task_type_signature);
      CREATE INDEX IF NOT EXISTS idx_et_outcome       ON execution_traces(outcome);
      CREATE INDEX IF NOT EXISTS idx_et_approach      ON execution_traces(task_type_signature, approach);
      CREATE INDEX IF NOT EXISTS idx_et_quality       ON execution_traces(quality_composite);
      CREATE INDEX IF NOT EXISTS idx_et_timestamp     ON execution_traces(timestamp);
      CREATE INDEX IF NOT EXISTS idx_et_worker_id     ON execution_traces(worker_id);
      CREATE INDEX IF NOT EXISTS idx_et_agent_id      ON execution_traces(agent_id);
      CREATE INDEX IF NOT EXISTS idx_primary_action   ON execution_traces(understanding_primary_action);

      -- §2 Self-model & patterns -----------------------------------------

      CREATE TABLE IF NOT EXISTS self_model_params (
        task_type_signature    TEXT PRIMARY KEY,
        observation_count      INTEGER NOT NULL DEFAULT 0,
        avg_quality_score      REAL NOT NULL DEFAULT 0.5,
        avg_duration_per_file  REAL NOT NULL DEFAULT 2000,
        prediction_accuracy    REAL NOT NULL DEFAULT 0.5,
        fail_rate              REAL NOT NULL DEFAULT 0.0,
        partial_rate           REAL NOT NULL DEFAULT 0.1,
        last_updated           INTEGER NOT NULL,
        basis                  TEXT NOT NULL DEFAULT 'static-heuristic'
      );

      CREATE TABLE IF NOT EXISTS model_parameters (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS extracted_patterns (
        id                  TEXT PRIMARY KEY,
        type                TEXT NOT NULL
                              CHECK(type IN ('anti-pattern','success-pattern','worker-performance','decomposition-pattern')),
        description         TEXT NOT NULL,
        frequency           INTEGER NOT NULL,
        confidence          REAL NOT NULL,
        task_type_signature TEXT NOT NULL,
        approach            TEXT,
        compared_approach   TEXT,
        quality_delta       REAL,
        source_trace_ids    TEXT NOT NULL,
        created_at          INTEGER NOT NULL,
        expires_at          INTEGER,
        decay_weight        REAL NOT NULL DEFAULT 1.0,
        derived_from        TEXT,
        worker_id           TEXT,
        compared_worker_id  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_patterns_type      ON extracted_patterns(type);
      CREATE INDEX IF NOT EXISTS idx_patterns_task_sig  ON extracted_patterns(task_type_signature);
      CREATE INDEX IF NOT EXISTS idx_patterns_created   ON extracted_patterns(created_at);

      CREATE TABLE IF NOT EXISTS sleep_cycle_runs (
        id              TEXT PRIMARY KEY,
        startedAt       INTEGER NOT NULL,
        completed_at    INTEGER,
        traces_analyzed INTEGER NOT NULL DEFAULT 0,
        patterns_found  INTEGER NOT NULL DEFAULT 0,
        status          TEXT NOT NULL
                          CHECK(status IN ('running','completed','failed'))
      );

      CREATE TABLE IF NOT EXISTS evolutionary_rules (
        id            TEXT PRIMARY KEY,
        source        TEXT NOT NULL CHECK(source IN ('sleep-cycle','manual')),
        condition     TEXT NOT NULL,
        action        TEXT NOT NULL
                        CHECK(action IN ('escalate','require-oracle','prefer-model','adjust-threshold','assign-worker','promote-capability')),
        parameters    TEXT NOT NULL,
        status        TEXT NOT NULL CHECK(status IN ('probation','active','retired')),
        created_at    INTEGER NOT NULL,
        effectiveness REAL NOT NULL DEFAULT 0.0,
        specificity   INTEGER NOT NULL DEFAULT 0,
        superseded_by TEXT,
        origin        TEXT CHECK(origin IN ('local','a2a','mcp')) DEFAULT 'local'
      );
      CREATE INDEX IF NOT EXISTS idx_rules_status ON evolutionary_rules(status);
      CREATE INDEX IF NOT EXISTS idx_rules_action ON evolutionary_rules(action);

      CREATE TABLE IF NOT EXISTS cached_skills (
        task_signature       TEXT PRIMARY KEY,
        approach             TEXT NOT NULL,
        success_rate         REAL NOT NULL,
        status               TEXT NOT NULL CHECK(status IN ('probation','active','demoted')),
        probation_remaining  INTEGER NOT NULL DEFAULT 10,
        usage_count          INTEGER NOT NULL DEFAULT 0,
        risk_at_creation     REAL NOT NULL,
        dep_cone_hashes      TEXT NOT NULL,
        last_verified_at     INTEGER NOT NULL,
        verification_profile TEXT NOT NULL
                              CHECK(verification_profile IN ('hash-only','structural','full')),
        origin               TEXT CHECK(origin IN ('local','a2a','mcp')) DEFAULT 'local',
        composed_of          TEXT DEFAULT NULL,
        agent_id             TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_skills_task_sig   ON cached_skills(task_signature);
      CREATE INDEX IF NOT EXISTS idx_skills_status     ON cached_skills(status);
      CREATE INDEX IF NOT EXISTS idx_skills_agent_sig  ON cached_skills(agent_id, task_signature);

      CREATE TABLE IF NOT EXISTS rejected_approaches (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id            TEXT NOT NULL,
        task_type          TEXT,
        file_target        TEXT,
        file_hash          TEXT,
        approach           TEXT NOT NULL,
        oracle_verdict     TEXT NOT NULL,
        verdict_confidence REAL,
        failure_oracle     TEXT,
        routing_level      INTEGER,
        source             TEXT DEFAULT 'task-end',
        created_at         INTEGER NOT NULL,
        expires_at         INTEGER,
        action_verb        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_rejected_file_type    ON rejected_approaches(file_target, task_type);
      CREATE INDEX IF NOT EXISTS idx_rejected_expires      ON rejected_approaches(expires_at);
      CREATE INDEX IF NOT EXISTS idx_rejected_action_verb  ON rejected_approaches(file_target, task_type, action_verb);

      CREATE TABLE IF NOT EXISTS shadow_jobs (
        id           TEXT PRIMARY KEY,
        task_id      TEXT NOT NULL,
        status       TEXT NOT NULL CHECK(status IN ('pending','running','done','failed')),
        enqueued_at  INTEGER NOT NULL,
        started_at   INTEGER,
        completed_at INTEGER,
        result       TEXT,
        mutations    TEXT NOT NULL,
        retry_count  INTEGER NOT NULL DEFAULT 0,
        max_retries  INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_shadow_status   ON shadow_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_shadow_task_id  ON shadow_jobs(task_id);

      CREATE TABLE IF NOT EXISTS causal_edges (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        source_file        TEXT NOT NULL,
        target_file        TEXT NOT NULL,
        oracle_name        TEXT NOT NULL,
        confidence         REAL NOT NULL,
        observed_at        INTEGER NOT NULL,
        observation_count  INTEGER DEFAULT 1,
        last_observed_at   INTEGER NOT NULL,
        UNIQUE(source_file, target_file, oracle_name)
      );
      CREATE INDEX IF NOT EXISTS idx_causal_source ON causal_edges(source_file);
      CREATE INDEX IF NOT EXISTS idx_causal_target ON causal_edges(target_file);

      -- §3 Fleet -----------------------------------------------------------

      CREATE TABLE IF NOT EXISTS worker_profiles (
        id              TEXT PRIMARY KEY,
        model_id        TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'probation'
                          CHECK(status IN ('probation','active','demoted','retired')),
        created_at      INTEGER NOT NULL,
        promoted_at     INTEGER,
        demoted_at      INTEGER,
        demotion_reason TEXT,
        demotion_count  INTEGER NOT NULL DEFAULT 0,
        engine_config   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_wp_model  ON worker_profiles(model_id);
      CREATE INDEX IF NOT EXISTS idx_wp_status ON worker_profiles(status);

      CREATE TABLE IF NOT EXISTS local_oracle_profiles (
        id              TEXT PRIMARY KEY,
        oracle_name     TEXT NOT NULL UNIQUE,
        status          TEXT NOT NULL DEFAULT 'probation',
        created_at      INTEGER NOT NULL,
        promoted_at     INTEGER,
        demoted_at      INTEGER,
        demotion_reason TEXT,
        demotion_count  INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_local_oracle_profiles_status ON local_oracle_profiles(status);

      -- §4 A2A / federation ----------------------------------------------

      CREATE TABLE IF NOT EXISTS instance_registry (
        instance_id        TEXT PRIMARY KEY,
        public_key         TEXT NOT NULL,
        endpoint           TEXT,
        trust_level        TEXT NOT NULL DEFAULT 'untrusted'
                            CHECK(trust_level IN ('untrusted','provisional','established','trusted')),
        capabilities_json  TEXT,
        health_json        TEXT,
        verdicts_requested INTEGER NOT NULL DEFAULT 0,
        verdicts_accurate  INTEGER NOT NULL DEFAULT 0,
        last_seen_at       INTEGER,
        created_at         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ir_trust ON instance_registry(trust_level);

      CREATE TABLE IF NOT EXISTS oracle_profiles (
        id                   TEXT PRIMARY KEY,
        instance_id          TEXT NOT NULL,
        oracle_name          TEXT NOT NULL,
        status               TEXT NOT NULL
                              CHECK(status IN ('probation','active','demoted','retired'))
                              DEFAULT 'probation',
        verdicts_requested   INTEGER NOT NULL DEFAULT 0,
        verdicts_accurate    INTEGER NOT NULL DEFAULT 0,
        false_positive_count INTEGER NOT NULL DEFAULT 0,
        timeout_count        INTEGER NOT NULL DEFAULT 0,
        contradiction_count  INTEGER NOT NULL DEFAULT 0,
        last_used_at         INTEGER NOT NULL DEFAULT 0,
        created_at           INTEGER NOT NULL,
        demoted_at           INTEGER,
        demotion_reason      TEXT,
        UNIQUE(instance_id, oracle_name)
      );
      CREATE INDEX IF NOT EXISTS idx_oracle_profiles_instance ON oracle_profiles(instance_id);
      CREATE INDEX IF NOT EXISTS idx_oracle_profiles_status   ON oracle_profiles(status);

      CREATE TABLE IF NOT EXISTS peer_pricing (
        id              TEXT PRIMARY KEY,
        instance_id     TEXT NOT NULL,
        task_type       TEXT NOT NULL,
        price_input     REAL NOT NULL,
        price_output    REAL NOT NULL,
        min_charge_usd  REAL NOT NULL DEFAULT 0,
        valid_until     INTEGER NOT NULL,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pp_instance  ON peer_pricing(instance_id);
      CREATE INDEX IF NOT EXISTS idx_pp_task_type ON peer_pricing(task_type);

      CREATE TABLE IF NOT EXISTS federation_budget (
        id              INTEGER PRIMARY KEY DEFAULT 1,
        contributed_usd REAL NOT NULL DEFAULT 0,
        consumed_usd    REAL NOT NULL DEFAULT 0,
        last_updated    INTEGER NOT NULL
      );

      -- §5 Economy / market ----------------------------------------------

      CREATE TABLE IF NOT EXISTS cost_ledger (
        id                    TEXT PRIMARY KEY,
        task_id               TEXT NOT NULL,
        worker_id             TEXT,
        engine_id             TEXT NOT NULL,
        timestamp             INTEGER NOT NULL,
        tokens_input          INTEGER NOT NULL DEFAULT 0,
        tokens_output         INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        duration_ms           INTEGER NOT NULL DEFAULT 0,
        oracle_invocations    INTEGER NOT NULL DEFAULT 0,
        computed_usd          REAL NOT NULL,
        cost_tier             TEXT NOT NULL CHECK(cost_tier IN ('billing','estimated')),
        routing_level         INTEGER NOT NULL,
        task_type_signature   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_cl_task_id   ON cost_ledger(task_id);
      CREATE INDEX IF NOT EXISTS idx_cl_engine_id ON cost_ledger(engine_id);
      CREATE INDEX IF NOT EXISTS idx_cl_timestamp ON cost_ledger(timestamp);

      CREATE TABLE IF NOT EXISTS budget_snapshots (
        id         TEXT PRIMARY KEY,
        window     TEXT NOT NULL CHECK(window IN ('hour','day','month')),
        period_key TEXT NOT NULL,
        spent_usd  REAL NOT NULL,
        limit_usd  REAL,
        timestamp  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bs_period ON budget_snapshots(window, period_key);

      CREATE TABLE IF NOT EXISTS bid_records (
        id                    TEXT PRIMARY KEY,
        auction_id            TEXT NOT NULL,
        bidder_id             TEXT NOT NULL,
        bidder_type           TEXT NOT NULL CHECK(bidder_type IN ('local','remote')),
        task_id               TEXT NOT NULL,
        estimated_tokens_in   INTEGER NOT NULL DEFAULT 0,
        estimated_tokens_out  INTEGER NOT NULL,
        estimated_duration_ms INTEGER NOT NULL,
        estimated_usd         REAL,
        declared_confidence   REAL NOT NULL,
        accepts_token_budget  INTEGER NOT NULL,
        accepts_time_limit_ms INTEGER NOT NULL,
        score                 REAL,
        is_winner             INTEGER NOT NULL DEFAULT 0,
        submitted_at          INTEGER NOT NULL,
        expires_at            INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_br_auction ON bid_records(auction_id);
      CREATE INDEX IF NOT EXISTS idx_br_bidder  ON bid_records(bidder_id);

      CREATE TABLE IF NOT EXISTS settlement_records (
        id                 TEXT PRIMARY KEY,
        bid_id             TEXT NOT NULL,
        engine_id          TEXT NOT NULL,
        task_id            TEXT NOT NULL,
        bid_usd            REAL NOT NULL,
        actual_usd         REAL NOT NULL,
        cost_accuracy      REAL NOT NULL,
        duration_accuracy  REAL NOT NULL,
        composite_accuracy REAL NOT NULL,
        penalty_type       TEXT,
        settled_at         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sr_engine ON settlement_records(engine_id);

      CREATE TABLE IF NOT EXISTS bid_accuracy (
        bidder_id                  TEXT PRIMARY KEY,
        accuracy_ema               REAL NOT NULL DEFAULT 0.5,
        total_settled_bids         INTEGER NOT NULL DEFAULT 0,
        underbid_violations        INTEGER NOT NULL DEFAULT 0,
        overclaim_violations       INTEGER NOT NULL DEFAULT 0,
        free_ride_violations       INTEGER NOT NULL DEFAULT 0,
        penalty_active             INTEGER NOT NULL DEFAULT 0,
        penalty_auctions_remaining INTEGER NOT NULL DEFAULT 0,
        last_settled_at            INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS auction_records (
        id           TEXT PRIMARY KEY,
        task_id      TEXT NOT NULL,
        phase        TEXT NOT NULL CHECK(phase IN ('A','B','C','D')),
        bidder_count INTEGER NOT NULL,
        winner_id    TEXT,
        winner_score REAL,
        second_score REAL,
        budget_cap   INTEGER,
        started_at   INTEGER NOT NULL,
        completed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ar_task ON auction_records(task_id);

      CREATE TABLE IF NOT EXISTS market_phase (
        id                 INTEGER PRIMARY KEY DEFAULT 1,
        current_phase      TEXT NOT NULL DEFAULT 'A'
                             CHECK(current_phase IN ('A','B','C','D')),
        activated_at       INTEGER NOT NULL,
        auction_count      INTEGER NOT NULL DEFAULT 0,
        last_evaluated_at  INTEGER NOT NULL
      );

      -- §6 Session / conversation ----------------------------------------

      CREATE TABLE IF NOT EXISTS session_store (
        id                  TEXT PRIMARY KEY,
        source              TEXT NOT NULL,
        created_at          INTEGER NOT NULL,
        status              TEXT NOT NULL DEFAULT 'active'
                              CHECK(status IN ('active','suspended','compacted','closed')),
        working_memory_json TEXT,
        compaction_json     TEXT,
        updated_at          INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ss_status ON session_store(status);

      CREATE TABLE IF NOT EXISTS session_tasks (
        session_id       TEXT NOT NULL REFERENCES session_store(id),
        task_id          TEXT NOT NULL,
        task_input_json  TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'pending'
                           CHECK(status IN ('pending','running','completed','failed','cancelled')),
        result_json      TEXT,
        created_at       INTEGER NOT NULL,
        PRIMARY KEY (session_id, task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_st_session ON session_tasks(session_id);
      CREATE INDEX IF NOT EXISTS idx_st_status  ON session_tasks(status);

      CREATE TABLE IF NOT EXISTS session_turns (
        id               TEXT PRIMARY KEY,
        session_id       TEXT NOT NULL REFERENCES session_store(id),
        seq              INTEGER NOT NULL,
        role             TEXT NOT NULL CHECK(role IN ('user','assistant')),
        blocks_json      TEXT NOT NULL,
        cancelled_at     INTEGER,
        token_count_json TEXT NOT NULL,
        task_id          TEXT,
        created_at       INTEGER NOT NULL,
        UNIQUE(session_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_session_turns_session_seq  ON session_turns(session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_session_turns_session_time ON session_turns(session_id, created_at);

      -- §7 Rooms ---------------------------------------------------------

      CREATE TABLE IF NOT EXISTS room_sessions (
        id              TEXT PRIMARY KEY,
        parent_task_id  TEXT NOT NULL,
        contract_json   TEXT NOT NULL,
        status          TEXT NOT NULL
                          CHECK(status IN ('opening','active','converging','converged','partial','failed','awaiting-user')),
        rounds_used     INTEGER NOT NULL DEFAULT 0,
        tokens_consumed INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL,
        closed_at       INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_room_sessions_parent ON room_sessions(parent_task_id);
      CREATE INDEX IF NOT EXISTS idx_room_sessions_status ON room_sessions(status);

      CREATE TABLE IF NOT EXISTS room_participants (
        id              TEXT PRIMARY KEY,
        room_id         TEXT NOT NULL REFERENCES room_sessions(id),
        role_name       TEXT NOT NULL,
        worker_id       TEXT NOT NULL,
        worker_model_id TEXT NOT NULL,
        turns_used      INTEGER NOT NULL DEFAULT 0,
        tokens_used     INTEGER NOT NULL DEFAULT 0,
        status          TEXT NOT NULL
                          CHECK(status IN ('admitted','active','yielded','failed')),
        admitted_at     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_room_participants_room ON room_participants(room_id);

      CREATE TABLE IF NOT EXISTS room_ledger (
        room_id               TEXT NOT NULL REFERENCES room_sessions(id),
        seq                   INTEGER NOT NULL,
        timestamp             INTEGER NOT NULL,
        author_participant_id TEXT NOT NULL,
        author_role           TEXT NOT NULL,
        entry_type            TEXT NOT NULL
                                CHECK(entry_type IN ('propose','affirm','reject','claim','query','answer','uncertain-turn','violation','converge-vote')),
        content_hash          TEXT NOT NULL,
        prev_hash             TEXT NOT NULL,
        payload_json          TEXT NOT NULL,
        PRIMARY KEY (room_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_room_ledger_author ON room_ledger(author_participant_id);

      CREATE TABLE IF NOT EXISTS room_blackboard (
        room_id     TEXT NOT NULL REFERENCES room_sessions(id),
        key         TEXT NOT NULL,
        version     INTEGER NOT NULL,
        value_json  TEXT NOT NULL,
        author_role TEXT NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (room_id, key, version)
      );
      CREATE INDEX IF NOT EXISTS idx_room_blackboard_room_key ON room_blackboard(room_id, key);

      -- §8 Agent identity ------------------------------------------------

      CREATE TABLE IF NOT EXISTS agent_profile (
        id                 TEXT PRIMARY KEY,
        instance_id        TEXT NOT NULL,
        display_name       TEXT NOT NULL DEFAULT 'vinyan',
        description        TEXT,
        workspace_path     TEXT NOT NULL,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL,
        preferences_json   TEXT NOT NULL DEFAULT '{}',
        capabilities_json  TEXT NOT NULL DEFAULT '[]',
        vinyan_md_path     TEXT,
        vinyan_md_hash     TEXT,
        role               TEXT DEFAULT NULL,
        specialization     TEXT DEFAULT NULL,
        persona            TEXT DEFAULT NULL
      );

      -- Machine slice only — narrative (persona, antiPatterns, winningStrategies,
      -- etc.) lives in .vinyan/souls/{agentId}.soul.md (SoulStore).
      CREATE TABLE IF NOT EXISTS agent_contexts (
        agent_id         TEXT PRIMARY KEY,
        episodes         TEXT NOT NULL DEFAULT '[]',
        proficiencies    TEXT NOT NULL DEFAULT '{}',
        pending_insights TEXT NOT NULL DEFAULT '[]',
        updated_at       INTEGER NOT NULL
      );

      -- §9 Comprehension learning ----------------------------------------

      CREATE TABLE IF NOT EXISTS comprehension_records (
        input_hash       TEXT NOT NULL,
        task_id          TEXT NOT NULL,
        session_id       TEXT,
        engine_id        TEXT NOT NULL,
        engine_type      TEXT,
        tier             TEXT NOT NULL,
        type             TEXT NOT NULL,
        confidence       REAL NOT NULL,
        verdict_pass     INTEGER NOT NULL,
        verdict_reason   TEXT,
        envelope_json    TEXT NOT NULL,
        created_at       INTEGER NOT NULL,
        outcome          TEXT,
        outcome_evidence TEXT,
        outcome_at       INTEGER,
        PRIMARY KEY (input_hash, engine_id)
      );
      CREATE INDEX IF NOT EXISTS idx_cr_session_created  ON comprehension_records(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_cr_engine_outcome   ON comprehension_records(engine_id, outcome, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_cr_engine_type      ON comprehension_records(engine_type, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_cr_pending_sweep
        ON comprehension_records(outcome, created_at)
        WHERE outcome IS NULL;

      -- §10 Ecosystem (O1-O4) --------------------------------------------

      CREATE TABLE IF NOT EXISTS agent_runtime (
        agent_id               TEXT PRIMARY KEY,
        state                  TEXT NOT NULL
                                 CHECK(state IN ('dormant','awakening','standby','working')),
        active_task_count      INTEGER NOT NULL DEFAULT 0,
        capacity_max           INTEGER NOT NULL DEFAULT 1,
        last_transition_at     INTEGER NOT NULL,
        last_transition_reason TEXT,
        last_heartbeat_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_runtime_state ON agent_runtime(state);

      CREATE TABLE IF NOT EXISTS agent_runtime_transitions (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id   TEXT NOT NULL,
        from_state TEXT NOT NULL,
        to_state   TEXT NOT NULL,
        reason     TEXT NOT NULL,
        task_id    TEXT,
        at         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_art_agent_at ON agent_runtime_transitions(agent_id, at);
      CREATE INDEX IF NOT EXISTS idx_art_task
        ON agent_runtime_transitions(task_id)
        WHERE task_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS commitments (
        commitment_id       TEXT PRIMARY KEY,
        engine_id           TEXT NOT NULL,
        task_id             TEXT NOT NULL,
        deliverable_hash    TEXT NOT NULL,
        deadline_at         INTEGER NOT NULL,
        accepted_at         INTEGER NOT NULL,
        resolved_at         INTEGER,
        resolution_kind     TEXT
                              CHECK(resolution_kind IN ('delivered','failed','transferred')
                                    OR resolution_kind IS NULL),
        resolution_evidence TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_commitments_engine ON commitments(engine_id);
      CREATE INDEX IF NOT EXISTS idx_commitments_task   ON commitments(task_id);
      CREATE INDEX IF NOT EXISTS idx_commitments_open
        ON commitments(engine_id)
        WHERE resolved_at IS NULL;

      CREATE TABLE IF NOT EXISTS teams (
        team_id       TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        department_id TEXT,
        created_at    INTEGER NOT NULL,
        archived_at   INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_teams_department
        ON teams(department_id)
        WHERE department_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS team_members (
        team_id   TEXT NOT NULL REFERENCES teams(team_id),
        engine_id TEXT NOT NULL,
        role      TEXT,
        joined_at INTEGER NOT NULL,
        left_at   INTEGER,
        PRIMARY KEY (team_id, engine_id, joined_at)
      );
      CREATE INDEX IF NOT EXISTS idx_team_members_engine ON team_members(engine_id);

      -- NOTE: team_blackboard was intentionally dropped — filesystem
      -- (src/orchestrator/ecosystem/team-blackboard-fs.ts) is the sole
      -- source of truth going forward.

      CREATE TABLE IF NOT EXISTS volunteer_offers (
        offer_id        TEXT PRIMARY KEY,
        task_id         TEXT NOT NULL,
        engine_id       TEXT NOT NULL,
        offered_at      INTEGER NOT NULL,
        accepted_at     INTEGER,
        commitment_id   TEXT,
        declined_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_volunteer_offers_task   ON volunteer_offers(task_id);
      CREATE INDEX IF NOT EXISTS idx_volunteer_offers_engine ON volunteer_offers(engine_id);
      CREATE INDEX IF NOT EXISTS idx_volunteer_offers_commitment
        ON volunteer_offers(commitment_id)
        WHERE commitment_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS engine_helpfulness (
        engine_id            TEXT PRIMARY KEY,
        offers_made          INTEGER NOT NULL DEFAULT 0,
        offers_accepted      INTEGER NOT NULL DEFAULT 0,
        deliveries_completed INTEGER NOT NULL DEFAULT 0,
        last_updated_at      INTEGER NOT NULL
      );
    `);

    // §12 Squashed post-041 DDL — every migration that used to live as
    // its own file in `migrations/0NN_*.ts` between versions 003 and
    // 033 (excluding 018, 025, 034 — which stay in the top-level chain
    // because they perform operational data ops).
    //
    // Idempotency guard: several of the squashed migrations (014, 015,
    // 020, 021, 022, 027 etc.) use `ALTER TABLE ADD COLUMN`, which is
    // NOT idempotent in SQLite — re-running raises `duplicate column
    // name`. The migration runner only calls `up()` once via the
    // `version <= currentVersion` check, but tests sometimes invoke
    // `migration001.up()` directly to set up an in-memory DB, and may
    // call it more than once in the same connection. Guarding on the
    // post-016 `agent_proposals` marker table makes the squashed bundle
    // safe to re-run end-to-end without changing every individual
    // ALTER to a try/catch.
    //
    // IMPORTANT: this block must run BEFORE the §11 sqlite-vec block —
    // §11 has an early `return` when the extension isn't loaded that
    // would otherwise skip §12 entirely.
    const squashedAlreadyApplied = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_proposals' LIMIT 1",
      )
      .get();
    if (!squashedAlreadyApplied) {
    // §12.003 memory_records
    {
          db.exec(`
            CREATE TABLE IF NOT EXISTS memory_records (
              id              TEXT PRIMARY KEY,
              profile         TEXT NOT NULL DEFAULT 'default',
              kind            TEXT NOT NULL
                                CHECK(kind IN ('fact','preference','user-section','episodic')),
              content         TEXT NOT NULL,
              confidence      REAL NOT NULL,
              evidence_tier   TEXT NOT NULL
                                CHECK(evidence_tier IN ('deterministic','heuristic','probabilistic','speculative')),
              evidence_chain  TEXT NOT NULL,     -- JSON array of EvidenceRef
              content_hash    TEXT,
              created_at      INTEGER NOT NULL,
              valid_from      INTEGER,
              valid_until     INTEGER,
              session_id      TEXT,
              metadata_json   TEXT,
              embedding       BLOB               -- optional; provider-specific
            );
            CREATE INDEX IF NOT EXISTS idx_memrec_profile_kind
              ON memory_records(profile, kind);
            CREATE INDEX IF NOT EXISTS idx_memrec_profile_tier
              ON memory_records(profile, evidence_tier);
            CREATE INDEX IF NOT EXISTS idx_memrec_content_hash
              ON memory_records(content_hash)
              WHERE content_hash IS NOT NULL;

            CREATE VIRTUAL TABLE IF NOT EXISTS memory_records_fts USING fts5(
              id UNINDEXED,
              profile UNINDEXED,
              kind UNINDEXED,
              content,
              tokenize = 'porter unicode61'
            );

            -- Triggers keep the FTS5 virtual table in lockstep with the base table.
            CREATE TRIGGER IF NOT EXISTS memrec_ai AFTER INSERT ON memory_records BEGIN
              INSERT INTO memory_records_fts (id, profile, kind, content)
              VALUES (new.id, new.profile, new.kind, new.content);
            END;

            CREATE TRIGGER IF NOT EXISTS memrec_ad AFTER DELETE ON memory_records BEGIN
              DELETE FROM memory_records_fts WHERE id = old.id;
            END;

            CREATE TRIGGER IF NOT EXISTS memrec_au AFTER UPDATE ON memory_records BEGIN
              UPDATE memory_records_fts
                 SET profile = new.profile,
                     kind    = new.kind,
                     content = new.content
               WHERE id = old.id;
            END;
          `);
        
    }

    // §12.004 skill_artifact
    (() => {
      interface ColumnSpec {
        name: string;
        /** DDL fragment with CHECK clause (preferred). */
        ddlWithCheck: string;
        /** Fallback DDL with no CHECK — used if the runtime rejects the CHECK form. */
        ddlPlain: string;
      }

      const CONFIDENCE_TIER_CHECK = "CHECK(confidence_tier IN ('deterministic','heuristic','probabilistic','speculative'))";

      const COLUMNS: ColumnSpec[] = [
        {
          name: 'confidence_tier',
          ddlWithCheck: `TEXT NOT NULL DEFAULT 'probabilistic' ${CONFIDENCE_TIER_CHECK}`,
          ddlPlain: "TEXT NOT NULL DEFAULT 'probabilistic'",
        },
        { name: 'skill_md_path', ddlWithCheck: 'TEXT', ddlPlain: 'TEXT' },
        { name: 'content_hash', ddlWithCheck: 'TEXT', ddlPlain: 'TEXT' },
        { name: 'expected_error_reduction', ddlWithCheck: 'REAL', ddlPlain: 'REAL' },
        { name: 'backtest_id', ddlWithCheck: 'TEXT', ddlPlain: 'TEXT' },
        { name: 'quarantined_at', ddlWithCheck: 'INTEGER', ddlPlain: 'INTEGER' },
      ];

      /** Fetch existing column names from `cached_skills`. */
      function existingColumnNames(db: Database): Set<string> {
        const rows = db.query('PRAGMA table_info(cached_skills)').all() as Array<{ name: string }>;
        return new Set(rows.map((r) => r.name));
      }

      /** Try DDL with CHECK; fall back to plain DDL if runtime rejects the CHECK. */
      function addColumn(db: Database, column: ColumnSpec): void {
        try {
          db.exec(`ALTER TABLE cached_skills ADD COLUMN ${column.name} ${column.ddlWithCheck}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/check|constraint|syntax/i.test(msg) && column.ddlWithCheck !== column.ddlPlain) {
            // Older SQLite builds disallow CHECK in ALTER TABLE ADD COLUMN.
            // The application layer (Zod + SkillStore) enforces the invariant.
            db.exec(`ALTER TABLE cached_skills ADD COLUMN ${column.name} ${column.ddlPlain}`);
            return;
          }
          throw err;
        }
      }
          const existing = existingColumnNames(db);
          for (const column of COLUMNS) {
            if (!existing.has(column.name)) {
              addColumn(db, column);
            }
          }
          db.exec(
            'CREATE INDEX IF NOT EXISTS idx_cached_skills_content_hash ON cached_skills(content_hash) WHERE content_hash IS NOT NULL',
          );
          db.exec('CREATE INDEX IF NOT EXISTS idx_cached_skills_tier ON cached_skills(confidence_tier)');
        
    })();

    // §12.005 trajectory_export
    {
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
        
    }

    // §12.006 gateway_tables
    {
          db.exec(`
            CREATE TABLE IF NOT EXISTS gateway_identity (
              gateway_user_id    TEXT PRIMARY KEY,
              profile            TEXT NOT NULL DEFAULT 'default',
              platform           TEXT NOT NULL,
              platform_user_id   TEXT NOT NULL,
              display_name       TEXT,
              trust_tier         TEXT NOT NULL
                                   CHECK(trust_tier IN ('unknown','pairing','paired','admin')),
              paired_at          INTEGER,
              last_seen_at       INTEGER,
              UNIQUE(platform, platform_user_id)
            );
            CREATE INDEX IF NOT EXISTS idx_gateway_identity_profile_platform
              ON gateway_identity(profile, platform);

            CREATE TABLE IF NOT EXISTS gateway_pairing_tokens (
              token              TEXT PRIMARY KEY,
              profile            TEXT NOT NULL DEFAULT 'default',
              platform           TEXT NOT NULL,
              issued_at          INTEGER NOT NULL,
              expires_at         INTEGER NOT NULL,
              consumed_at        INTEGER,
              consumed_by        TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_gateway_pairing_expires
              ON gateway_pairing_tokens(expires_at);

            CREATE TABLE IF NOT EXISTS gateway_schedules (
              id                 TEXT PRIMARY KEY,
              profile            TEXT NOT NULL DEFAULT 'default',
              created_at         INTEGER NOT NULL,
              cron               TEXT NOT NULL,
              timezone           TEXT NOT NULL,
              goal               TEXT NOT NULL,
              origin_json        TEXT NOT NULL,
              status             TEXT NOT NULL DEFAULT 'active',
              next_fire_at       INTEGER,
              run_history_json   TEXT DEFAULT '[]'
            );
            CREATE INDEX IF NOT EXISTS idx_gateway_schedules_profile_next
              ON gateway_schedules(profile, next_fire_at);
          `);
        
    }

    // §12.007 plugin_audit
    {
          db.exec(`
            CREATE TABLE IF NOT EXISTS plugin_audit (
              audit_id       INTEGER PRIMARY KEY AUTOINCREMENT,
              profile        TEXT NOT NULL DEFAULT 'default',
              plugin_id      TEXT NOT NULL,
              plugin_version TEXT NOT NULL,
              category       TEXT NOT NULL,
              event          TEXT NOT NULL
                               CHECK(event IN (
                                 'discovered','integrity_ok','integrity_fail',
                                 'signature_ok','signature_fail',
                                 'loaded','activated','deactivated','rejected','unloaded'
                               )),
              tier           TEXT,
              from_state     TEXT,
              to_state       TEXT,
              detail_json    TEXT,
              created_at     INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_plugin_audit_profile_plugin
              ON plugin_audit(profile, plugin_id);
            CREATE INDEX IF NOT EXISTS idx_plugin_audit_created
              ON plugin_audit(created_at);
          `);
        
    }

    // §12.008 skill_trust_ledger
    {
          db.exec(`
            CREATE TABLE IF NOT EXISTS skill_trust_ledger (
              ledger_id        INTEGER PRIMARY KEY AUTOINCREMENT,
              profile          TEXT NOT NULL DEFAULT 'default',
              skill_id         TEXT NOT NULL,
              event            TEXT NOT NULL CHECK(event IN
                ('fetched','scanned','quarantined','dry_run','critic_reviewed',
                 'promoted','demoted','retired','rejected')),
              from_status      TEXT,
              to_status        TEXT,
              from_tier        TEXT,
              to_tier          TEXT,
              evidence_json    TEXT NOT NULL,
              rule_id          TEXT,
              created_at       INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_skill_trust_ledger_profile_skill
              ON skill_trust_ledger(profile, skill_id);
            CREATE INDEX IF NOT EXISTS idx_skill_trust_ledger_created
              ON skill_trust_ledger(created_at);
          `);
        
    }

    // §12.009 user_md_dialectic
    {
          db.exec(`
            CREATE TABLE IF NOT EXISTS user_md_sections (
              slug               TEXT NOT NULL,
              profile            TEXT NOT NULL DEFAULT 'default',
              heading            TEXT NOT NULL,
              body               TEXT NOT NULL,
              predicted_response TEXT NOT NULL,
              evidence_tier      TEXT NOT NULL
                                   CHECK(evidence_tier IN (
                                     'deterministic','heuristic','probabilistic','speculative'
                                   )),
              confidence         REAL NOT NULL,
              last_revised_at    INTEGER,
              PRIMARY KEY (profile, slug)
            );

            CREATE TABLE IF NOT EXISTS user_md_prediction_errors (
              error_id  INTEGER PRIMARY KEY AUTOINCREMENT,
              profile   TEXT NOT NULL DEFAULT 'default',
              slug      TEXT NOT NULL,
              observed  TEXT NOT NULL,
              predicted TEXT NOT NULL,
              delta     REAL NOT NULL,
              turn_id   TEXT,
              ts        INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_ume_profile_slug_ts
              ON user_md_prediction_errors(profile, slug, ts);
          `);
        
    }

    // §12.010 commonsense_rules
    {
          db.exec(`
            CREATE TABLE IF NOT EXISTS commonsense_rules (
              id                       TEXT PRIMARY KEY,
              microtheory_lang         TEXT NOT NULL,
              microtheory_domain       TEXT NOT NULL,
              microtheory_action       TEXT NOT NULL,
              pattern                  TEXT NOT NULL,
              default_outcome          TEXT NOT NULL
                                         CHECK(default_outcome IN (
                                           'allow','block','needs-confirmation','escalate'
                                         )),
              abnormality_predicate    TEXT,
              priority                 INTEGER NOT NULL DEFAULT 50
                                         CHECK(priority BETWEEN 0 AND 100),
              confidence               REAL NOT NULL
                                         CHECK(confidence BETWEEN 0.5 AND 0.7),
              source                   TEXT NOT NULL
                                         CHECK(source IN (
                                           'innate','configured','promoted-from-pattern'
                                         )),
              evidence_hash            TEXT,
              promoted_from_pattern_id TEXT,
              created_at               INTEGER NOT NULL,
              rationale                TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_commonsense_microtheory
              ON commonsense_rules(microtheory_lang, microtheory_domain, microtheory_action);
            CREATE INDEX IF NOT EXISTS idx_commonsense_priority
              ON commonsense_rules(priority DESC);
            CREATE INDEX IF NOT EXISTS idx_commonsense_source
              ON commonsense_rules(source);
          `);
        
    }

    // §12.011 commonsense_rule_telemetry
    (() => {
      interface ColumnSpec {
        name: string;
        ddl: string;
      }

      const COLUMNS: ColumnSpec[] = [
        { name: 'firing_count', ddl: 'INTEGER NOT NULL DEFAULT 0' },
        { name: 'override_count', ddl: 'INTEGER NOT NULL DEFAULT 0' },
        { name: 'last_fired_at', ddl: 'INTEGER' },
        { name: 'retired_at', ddl: 'INTEGER' },
      ];

      function existingColumnNames(db: Database): Set<string> {
        const rows = db.query('PRAGMA table_info(commonsense_rules)').all() as Array<{ name: string }>;
        return new Set(rows.map((r) => r.name));
      }
          const existing = existingColumnNames(db);
          for (const column of COLUMNS) {
            if (existing.has(column.name)) continue;
            db.exec(`ALTER TABLE commonsense_rules ADD COLUMN ${column.name} ${column.ddl}`);
          }

          db.exec(`
            CREATE INDEX IF NOT EXISTS idx_commonsense_retired_at
              ON commonsense_rules(retired_at);
            CREATE INDEX IF NOT EXISTS idx_commonsense_firing_count
              ON commonsense_rules(firing_count DESC);
          `);
        
    })();

    // §12.012 capability_trace_metadata
    (() => {
      interface ColumnSpec {
        name: string;
        ddl: string;
      }

      const COLUMNS: ColumnSpec[] = [
        { name: 'capability_requirements', ddl: 'TEXT' },
        { name: 'capability_analysis', ddl: 'TEXT' },
        { name: 'synthetic_agent_id', ddl: 'TEXT' },
        { name: 'knowledge_used', ddl: 'TEXT' },
      ];

      function existingColumnNames(db: Database): Set<string> {
        const rows = db.query('PRAGMA table_info(execution_traces)').all() as Array<{ name: string }>;
        return new Set(rows.map((r) => r.name));
      }
          const existing = existingColumnNames(db);
          for (const column of COLUMNS) {
            if (existing.has(column.name)) continue;
            db.exec(`ALTER TABLE execution_traces ADD COLUMN ${column.name} ${column.ddl}`);
          }
        
    })();

    // §12.013 rule_promote_capability_action
    (() => {
      const ACTION_CHECK =
        "'escalate','require-oracle','prefer-model','adjust-threshold','assign-worker','promote-capability'";

      function currentTableSql(db: Database): string | null {
        const row = db
          .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'evolutionary_rules'")
          .get() as { sql: string } | null;
        return row?.sql ?? null;
      }
          const sql = currentTableSql(db);
          if (!sql || sql.includes('promote-capability')) return;

          db.exec(`
            DROP INDEX IF EXISTS idx_rules_status;
            DROP INDEX IF EXISTS idx_rules_action;

            ALTER TABLE evolutionary_rules RENAME TO evolutionary_rules_old;

            CREATE TABLE evolutionary_rules (
              id            TEXT PRIMARY KEY,
              source        TEXT NOT NULL CHECK(source IN ('sleep-cycle','manual')),
              condition     TEXT NOT NULL,
              action        TEXT NOT NULL CHECK(action IN (${ACTION_CHECK})),
              parameters    TEXT NOT NULL,
              status        TEXT NOT NULL CHECK(status IN ('probation','active','retired')),
              created_at    INTEGER NOT NULL,
              effectiveness REAL NOT NULL DEFAULT 0.0,
              specificity   INTEGER NOT NULL DEFAULT 0,
              superseded_by TEXT,
              origin        TEXT CHECK(origin IN ('local','a2a','mcp')) DEFAULT 'local'
            );

            INSERT INTO evolutionary_rules (
              id, source, condition, action, parameters,
              status, created_at, effectiveness, specificity, superseded_by, origin
            )
            SELECT
              id, source, condition, action, parameters,
              status, created_at, effectiveness, specificity, superseded_by, origin
            FROM evolutionary_rules_old;

            DROP TABLE evolutionary_rules_old;

            CREATE INDEX IF NOT EXISTS idx_rules_status ON evolutionary_rules(status);
            CREATE INDEX IF NOT EXISTS idx_rules_action ON evolutionary_rules(action);
          `);
        
    })();

    // §12.014 session_metadata
    (() => {
      interface PragmaColumn {
        name: string;
      }

      function hasColumn(db: Database, table: string, column: string): boolean {
        const rows = db.query(`PRAGMA table_info(${table})`).all() as PragmaColumn[];
        return rows.some((r) => r.name === column);
      }
          if (!hasColumn(db, 'session_store', 'title')) {
            db.exec('ALTER TABLE session_store ADD COLUMN title TEXT');
          }
          if (!hasColumn(db, 'session_store', 'description')) {
            db.exec('ALTER TABLE session_store ADD COLUMN description TEXT');
          }
          if (!hasColumn(db, 'session_store', 'archived_at')) {
            db.exec('ALTER TABLE session_store ADD COLUMN archived_at INTEGER');
          }
          if (!hasColumn(db, 'session_store', 'deleted_at')) {
            db.exec('ALTER TABLE session_store ADD COLUMN deleted_at INTEGER');
          }

          db.exec(`
            CREATE INDEX IF NOT EXISTS idx_ss_archived_at ON session_store(archived_at);
            CREATE INDEX IF NOT EXISTS idx_ss_deleted_at ON session_store(deleted_at);
            CREATE INDEX IF NOT EXISTS idx_ss_updated_at ON session_store(updated_at);
          `);
        
    })();

    // §12.015 capability_route_audit
    (() => {
      interface ColumnSpec {
        name: string;
        ddl: string;
      }

      const COLUMNS: ColumnSpec[] = [
        { name: 'agent_selection_reason', ddl: 'TEXT' },
        { name: 'selected_capability_profile_id', ddl: 'TEXT' },
        { name: 'selected_capability_profile_source', ddl: 'TEXT' },
        { name: 'selected_capability_profile_trust_tier', ddl: 'TEXT' },
        { name: 'capability_fit_score', ddl: 'REAL' },
        { name: 'unmet_capability_ids', ddl: 'TEXT' },
      ];

      function existingColumnNames(db: Database): Set<string> {
        const rows = db.query('PRAGMA table_info(execution_traces)').all() as Array<{ name: string }>;
        return new Set(rows.map((row) => row.name));
      }
          const existing = existingColumnNames(db);
          for (const column of COLUMNS) {
            if (existing.has(column.name)) continue;
            db.exec(`ALTER TABLE execution_traces ADD COLUMN ${column.name} ${column.ddl}`);
          }
        
    })();

    // §12.016 agent_proposals
    {
          db.exec(AGENT_PROPOSAL_SCHEMA_SQL);
        
    }

    // §12.017 task_events
    (() => {
      const TASK_EVENTS_SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS task_events (
        id           TEXT    PRIMARY KEY,
        task_id      TEXT    NOT NULL,
        session_id   TEXT,
        seq          INTEGER NOT NULL,
        event_type   TEXT    NOT NULL,
        payload_json TEXT    NOT NULL,
        ts           INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_task_events_task_seq
        ON task_events (task_id, seq);

      CREATE INDEX IF NOT EXISTS idx_task_events_session_ts
        ON task_events (session_id, ts);
      `;
          db.exec(TASK_EVENTS_SCHEMA_SQL);
        
    })();

    // §12.019 skill_outcomes
    {
          db.exec(SKILL_OUTCOME_SCHEMA_SQL);
        
    }

    // §12.020 a8_governance_provenance
    (() => {
      interface ColumnSpec {
        name: string;
        ddl: string;
      }

      const COLUMNS: ColumnSpec[] = [
        { name: 'governance_provenance', ddl: 'TEXT' },
        { name: 'routing_decision_id', ddl: 'TEXT' },
        { name: 'policy_version', ddl: 'TEXT' },
        { name: 'governance_actor', ddl: 'TEXT' },
        { name: 'decision_timestamp', ddl: 'INTEGER' },
        { name: 'evidence_observed_at', ddl: 'INTEGER' },
      ];

      function existingColumnNames(db: Database): Set<string> {
        const rows = db.query('PRAGMA table_info(execution_traces)').all() as Array<{ name: string }>;
        return new Set(rows.map((row) => row.name));
      }
          const existing = existingColumnNames(db);
          for (const column of COLUMNS) {
            if (existing.has(column.name)) continue;
            db.exec(`ALTER TABLE execution_traces ADD COLUMN ${column.name} ${column.ddl}`);
          }

          db.exec('CREATE INDEX IF NOT EXISTS idx_et_routing_decision_id ON execution_traces(routing_decision_id)');
          db.exec('CREATE INDEX IF NOT EXISTS idx_et_policy_version ON execution_traces(policy_version)');
          db.exec('CREATE INDEX IF NOT EXISTS idx_et_governance_actor ON execution_traces(governance_actor)');
          db.exec('CREATE INDEX IF NOT EXISTS idx_et_decision_timestamp ON execution_traces(decision_timestamp)');
        
    })();

    // §12.021 a10_goal_grounding
    (() => {
      function existingColumnNames(db: Database): Set<string> {
        const rows = db.query('PRAGMA table_info(execution_traces)').all() as Array<{ name: string }>;
        return new Set(rows.map((row) => row.name));
      }
          const existing = existingColumnNames(db);
          if (!existing.has('goal_grounding')) {
            db.exec('ALTER TABLE execution_traces ADD COLUMN goal_grounding TEXT');
          }
        
    })();

    // §12.022 a5_oracle_independence
    (() => {
      function existingColumnNames(db: Database): Set<string> {
        const rows = db.query('PRAGMA table_info(execution_traces)').all() as Array<{ name: string }>;
        return new Set(rows.map((row) => row.name));
      }
          const existing = existingColumnNames(db);
          if (!existing.has('oracle_independence')) {
            db.exec('ALTER TABLE execution_traces ADD COLUMN oracle_independence TEXT');
          }
        
    })();

    // §12.023 persona_overclaim
    {
          db.exec(PERSONA_OVERCLAIM_SCHEMA_SQL);
        
    }

    // §12.024 coding_cli
    (() => {
      const CODING_CLI_SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS coding_cli_sessions (
        id                      TEXT PRIMARY KEY,
        task_id                 TEXT NOT NULL,
        session_id              TEXT,
        provider_id             TEXT NOT NULL,
        binary_path             TEXT NOT NULL,
        binary_version          TEXT,
        capabilities_json       TEXT NOT NULL,
        cwd                     TEXT NOT NULL,
        pid                     INTEGER,
        state                   TEXT NOT NULL,
        started_at              INTEGER NOT NULL,
        updated_at              INTEGER NOT NULL,
        ended_at                INTEGER,
        last_output_at          INTEGER,
        last_hook_at            INTEGER,
        transcript_path         TEXT,
        event_log_path          TEXT,
        files_changed_json      TEXT NOT NULL DEFAULT '[]',
        commands_requested_json TEXT NOT NULL DEFAULT '[]',
        final_result_json       TEXT,
        raw_meta_json           TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_coding_cli_sessions_task
        ON coding_cli_sessions (task_id);

      CREATE INDEX IF NOT EXISTS idx_coding_cli_sessions_session
        ON coding_cli_sessions (session_id);

      CREATE INDEX IF NOT EXISTS idx_coding_cli_sessions_state
        ON coding_cli_sessions (state, updated_at);

      CREATE TABLE IF NOT EXISTS coding_cli_events (
        id                      TEXT PRIMARY KEY,
        coding_cli_session_id   TEXT NOT NULL,
        task_id                 TEXT NOT NULL,
        seq                     INTEGER NOT NULL,
        event_type              TEXT NOT NULL,
        payload_json            TEXT NOT NULL,
        ts                      INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_coding_cli_events_session_seq
        ON coding_cli_events (coding_cli_session_id, seq);

      CREATE INDEX IF NOT EXISTS idx_coding_cli_events_task_ts
        ON coding_cli_events (task_id, ts);

      CREATE TABLE IF NOT EXISTS coding_cli_approvals (
        id                      TEXT PRIMARY KEY,
        coding_cli_session_id   TEXT NOT NULL,
        task_id                 TEXT NOT NULL,
        request_id              TEXT NOT NULL,
        command                 TEXT NOT NULL,
        reason                  TEXT NOT NULL,
        policy_decision         TEXT NOT NULL,
        human_decision          TEXT,
        decided_by              TEXT,
        decided_at              INTEGER,
        requested_at            INTEGER NOT NULL,
        raw_json                TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_coding_cli_approvals_session
        ON coding_cli_approvals (coding_cli_session_id);

      CREATE INDEX IF NOT EXISTS idx_coding_cli_approvals_request
        ON coding_cli_approvals (task_id, request_id);

      CREATE TABLE IF NOT EXISTS coding_cli_decisions (
        id                      TEXT PRIMARY KEY,
        coding_cli_session_id   TEXT NOT NULL,
        task_id                 TEXT NOT NULL,
        decision                TEXT NOT NULL,
        rationale               TEXT NOT NULL,
        alternatives_json       TEXT NOT NULL DEFAULT '[]',
        ts                      INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_coding_cli_decisions_session
        ON coding_cli_decisions (coding_cli_session_id, ts);
      `;
          db.exec(CODING_CLI_SCHEMA_SQL);
        
    })();

    // §12.026 memory_wiki
    {
          db.exec(`
            CREATE TABLE IF NOT EXISTS memory_wiki_sources (
              id            TEXT PRIMARY KEY,
              profile       TEXT NOT NULL DEFAULT 'default',
              kind          TEXT NOT NULL
                              CHECK(kind IN ('session','trace','user-note','web-capture','coding-cli-run','verification','approval')),
              content_hash  TEXT NOT NULL,
              created_at    INTEGER NOT NULL,
              session_id    TEXT,
              task_id       TEXT,
              agent_id      TEXT,
              user_id       TEXT,
              body          TEXT NOT NULL,
              metadata_json TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_mwsrc_profile_kind  ON memory_wiki_sources(profile, kind);
            CREATE INDEX IF NOT EXISTS idx_mwsrc_content_hash  ON memory_wiki_sources(content_hash);
            CREATE INDEX IF NOT EXISTS idx_mwsrc_session       ON memory_wiki_sources(session_id) WHERE session_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_mwsrc_task          ON memory_wiki_sources(task_id) WHERE task_id IS NOT NULL;

            CREATE TABLE IF NOT EXISTS memory_wiki_pages (
              id              TEXT PRIMARY KEY,
              profile         TEXT NOT NULL DEFAULT 'default',
              type            TEXT NOT NULL
                                CHECK(type IN ('concept','entity','project','decision','failure-pattern',
                                               'workflow-pattern','source-summary','task-memory',
                                               'persona-profile','worker-profile','cli-delegate-profile',
                                               'peer-profile','open-question')),
              title           TEXT NOT NULL,
              aliases_json    TEXT NOT NULL DEFAULT '[]',
              tags_json       TEXT NOT NULL DEFAULT '[]',
              body            TEXT NOT NULL,
              evidence_tier   TEXT NOT NULL
                                CHECK(evidence_tier IN ('deterministic','heuristic','pragmatic','probabilistic','speculative')),
              confidence      REAL NOT NULL,
              lifecycle       TEXT NOT NULL
                                CHECK(lifecycle IN ('draft','canonical','stale','disputed','archived')),
              created_at      INTEGER NOT NULL,
              updated_at      INTEGER NOT NULL,
              valid_until     INTEGER,
              protected_json  TEXT NOT NULL DEFAULT '[]',
              body_hash       TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_mwpage_profile_type      ON memory_wiki_pages(profile, type);
            CREATE INDEX IF NOT EXISTS idx_mwpage_profile_lifecycle ON memory_wiki_pages(profile, lifecycle);
            CREATE INDEX IF NOT EXISTS idx_mwpage_updated           ON memory_wiki_pages(updated_at);

            CREATE TABLE IF NOT EXISTS memory_wiki_edges (
              from_id    TEXT NOT NULL,
              to_id      TEXT NOT NULL,
              edge_type  TEXT NOT NULL DEFAULT 'mentions'
                           CHECK(edge_type IN ('mentions','cites','supersedes','contradicts',
                                               'derived-from','implements','belongs-to')),
              confidence REAL NOT NULL DEFAULT 0.5,
              created_at INTEGER NOT NULL,
              PRIMARY KEY (from_id, to_id, edge_type)
            );
            CREATE INDEX IF NOT EXISTS idx_mwedge_to ON memory_wiki_edges(to_id);

            CREATE TABLE IF NOT EXISTS memory_wiki_claims (
              id             TEXT PRIMARY KEY,
              page_id        TEXT NOT NULL,
              text           TEXT NOT NULL,
              source_ids     TEXT NOT NULL DEFAULT '[]',
              evidence_tier  TEXT NOT NULL,
              confidence     REAL NOT NULL,
              created_at     INTEGER NOT NULL,
              FOREIGN KEY (page_id) REFERENCES memory_wiki_pages(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_mwclaim_page ON memory_wiki_claims(page_id);

            CREATE TABLE IF NOT EXISTS memory_wiki_operations (
              id           INTEGER PRIMARY KEY AUTOINCREMENT,
              ts           INTEGER NOT NULL,
              op           TEXT NOT NULL
                             CHECK(op IN ('ingest','propose','write','reject','stale',
                                          'promote','demote','lint','archive','restore')),
              page_id      TEXT,
              source_id    TEXT,
              actor        TEXT NOT NULL,
              reason       TEXT,
              payload_json TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_mwop_ts        ON memory_wiki_operations(ts);
            CREATE INDEX IF NOT EXISTS idx_mwop_page      ON memory_wiki_operations(page_id) WHERE page_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_mwop_op        ON memory_wiki_operations(op);

            CREATE TABLE IF NOT EXISTS memory_wiki_lint_findings (
              id           INTEGER PRIMARY KEY AUTOINCREMENT,
              ts           INTEGER NOT NULL,
              code         TEXT NOT NULL,
              severity     TEXT NOT NULL
                             CHECK(severity IN ('error','warn','info')),
              page_id      TEXT,
              detail       TEXT,
              resolved_at  INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_mwlint_code ON memory_wiki_lint_findings(code);
            CREATE INDEX IF NOT EXISTS idx_mwlint_open ON memory_wiki_lint_findings(ts) WHERE resolved_at IS NULL;

            CREATE VIRTUAL TABLE IF NOT EXISTS memory_wiki_pages_fts USING fts5(
              id UNINDEXED,
              profile UNINDEXED,
              type UNINDEXED,
              title,
              body,
              tags,
              tokenize='porter unicode61'
            );

            CREATE TRIGGER IF NOT EXISTS mwpage_ai AFTER INSERT ON memory_wiki_pages BEGIN
              INSERT INTO memory_wiki_pages_fts (id, profile, type, title, body, tags)
              VALUES (new.id, new.profile, new.type, new.title, new.body, new.tags_json);
            END;

            CREATE TRIGGER IF NOT EXISTS mwpage_ad AFTER DELETE ON memory_wiki_pages BEGIN
              DELETE FROM memory_wiki_pages_fts WHERE id = old.id;
            END;

            CREATE TRIGGER IF NOT EXISTS mwpage_au AFTER UPDATE ON memory_wiki_pages BEGIN
              UPDATE memory_wiki_pages_fts
                 SET profile = new.profile,
                     type    = new.type,
                     title   = new.title,
                     body    = new.body,
                     tags    = new.tags_json
               WHERE id = old.id;
            END;
          `);
        
    }

    // §12.027 task_archive_metadata
    {
          db.exec(`
            ALTER TABLE session_tasks ADD COLUMN archived_at INTEGER;
            ALTER TABLE session_tasks ADD COLUMN updated_at INTEGER;
            UPDATE session_tasks SET updated_at = created_at WHERE updated_at IS NULL;
            CREATE INDEX IF NOT EXISTS idx_st_archived_created
              ON session_tasks(archived_at, created_at);
            CREATE INDEX IF NOT EXISTS idx_st_status_created
              ON session_tasks(status, created_at);
            CREATE INDEX IF NOT EXISTS idx_st_task_id
              ON session_tasks(task_id);
          `);
        
    }

    // §12.028 session_tasks_fts
    {
          db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS session_tasks_fts USING fts5(
              task_id UNINDEXED,
              session_id UNINDEXED,
              status UNINDEXED,
              searchable_text,
              tokenize = 'porter unicode61'
            );

            -- Backfill: combine task_id + session_id + extracted goal so a free
            -- text search hits the operator-visible surface. COALESCE so a NULL
            -- goal does not produce a literal "null" token in the index.
            INSERT INTO session_tasks_fts (task_id, session_id, status, searchable_text)
            SELECT
              task_id,
              session_id,
              status,
              COALESCE(task_id, '')
                || ' ' || COALESCE(session_id, '')
                || ' ' || COALESCE(json_extract(task_input_json, '$.goal'), '')
            FROM session_tasks;

            -- INSERT trigger — index a new row using the same projection as
            -- backfill so the two paths cannot drift.
            CREATE TRIGGER IF NOT EXISTS session_tasks_fts_ai
            AFTER INSERT ON session_tasks BEGIN
              INSERT INTO session_tasks_fts (task_id, session_id, status, searchable_text)
              VALUES (
                new.task_id,
                new.session_id,
                new.status,
                COALESCE(new.task_id, '')
                  || ' ' || COALESCE(new.session_id, '')
                  || ' ' || COALESCE(json_extract(new.task_input_json, '$.goal'), '')
              );
            END;

            -- DELETE trigger — keep FTS in lockstep when a row is hard-deleted
            -- (session purge, test cleanup). Match by (session_id, task_id) which
            -- is the effective unique key on session_tasks.
            CREATE TRIGGER IF NOT EXISTS session_tasks_fts_ad
            AFTER DELETE ON session_tasks BEGIN
              DELETE FROM session_tasks_fts
              WHERE task_id = old.task_id AND session_id = old.session_id;
            END;

            -- UPDATE trigger — status transitions are the dominant write path
            -- (pending → running → completed/cancelled). Refresh status +
            -- searchable_text so a status filter stays accurate.
            CREATE TRIGGER IF NOT EXISTS session_tasks_fts_au
            AFTER UPDATE ON session_tasks BEGIN
              UPDATE session_tasks_fts
                 SET status = new.status,
                     searchable_text =
                       COALESCE(new.task_id, '')
                         || ' ' || COALESCE(new.session_id, '')
                         || ' ' || COALESCE(json_extract(new.task_input_json, '$.goal'), '')
               WHERE task_id = old.task_id AND session_id = old.session_id;
            END;
          `);
        
    }

    // §12.029 skill_proposals
    {
          db.exec(`
            CREATE TABLE IF NOT EXISTS skill_proposals (
              id                 TEXT PRIMARY KEY,
              profile            TEXT NOT NULL DEFAULT 'default',
              status             TEXT NOT NULL DEFAULT 'pending'
                                   CHECK(status IN ('pending','approved','rejected','quarantined')),
              proposed_name      TEXT NOT NULL,
              proposed_category  TEXT NOT NULL,
              skill_md           TEXT NOT NULL,
              capability_tags    TEXT NOT NULL DEFAULT '[]',
              tools_required     TEXT NOT NULL DEFAULT '[]',
              source_task_ids    TEXT NOT NULL DEFAULT '[]',
              evidence_event_ids TEXT NOT NULL DEFAULT '[]',
              success_count      INTEGER NOT NULL DEFAULT 0,
              safety_flags       TEXT NOT NULL DEFAULT '[]',
              trust_tier         TEXT NOT NULL DEFAULT 'quarantined'
                                   CHECK(trust_tier IN ('quarantined','community','trusted','official','builtin')),
              created_at         INTEGER NOT NULL,
              decided_at         INTEGER,
              decided_by         TEXT,
              decision_reason    TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_skill_proposals_status
              ON skill_proposals(profile, status, created_at);
            CREATE INDEX IF NOT EXISTS idx_skill_proposals_name
              ON skill_proposals(profile, proposed_name);
          `);
        
    }

    // §12.030 parameter_ledger
    {
          db.exec(`
            CREATE TABLE IF NOT EXISTS parameter_adaptations (
              id              INTEGER PRIMARY KEY AUTOINCREMENT,
              ts              INTEGER NOT NULL,
              param_name      TEXT    NOT NULL,
              old_value       TEXT    NOT NULL,
              new_value       TEXT    NOT NULL,
              reason          TEXT    NOT NULL,
              owner_module    TEXT    NOT NULL,
              ledger_version  INTEGER NOT NULL DEFAULT 1
            );
            CREATE INDEX IF NOT EXISTS idx_param_ledger_name_ts
              ON parameter_adaptations(param_name, ts DESC);
            CREATE INDEX IF NOT EXISTS idx_param_ledger_owner
              ON parameter_adaptations(owner_module);
          `);
        
    }

    // §12.031 skill_autogen_state
    {
          db.exec(`
            CREATE TABLE IF NOT EXISTS skill_autogen_state (
              signature_key       TEXT NOT NULL,
              profile             TEXT NOT NULL DEFAULT 'default',
              successes           INTEGER NOT NULL DEFAULT 0,
              successes_at_boot   INTEGER NOT NULL DEFAULT 0,
              last_seen           INTEGER NOT NULL,
              boot_id             TEXT,
              cooldown_until      INTEGER NOT NULL DEFAULT 0,
              task_ids_json       TEXT NOT NULL DEFAULT '[]',
              state_version       INTEGER NOT NULL DEFAULT 1,
              last_emitted_at     INTEGER,
              PRIMARY KEY (profile, signature_key)
            );
            CREATE INDEX IF NOT EXISTS idx_skill_autogen_state_last_seen
              ON skill_autogen_state(last_seen);
            CREATE INDEX IF NOT EXISTS idx_skill_autogen_state_boot
              ON skill_autogen_state(boot_id);
          `);
        
    }

    // §12.032 skill_proposal_revisions
    {
          db.exec(`
            CREATE TABLE IF NOT EXISTS skill_proposal_revisions (
              id                  INTEGER PRIMARY KEY AUTOINCREMENT,
              profile             TEXT NOT NULL DEFAULT 'default',
              proposal_id         TEXT NOT NULL,
              revision            INTEGER NOT NULL,
              skill_md            TEXT NOT NULL,
              safety_flags_json   TEXT NOT NULL DEFAULT '[]',
              actor               TEXT NOT NULL,
              reason              TEXT,
              created_at          INTEGER NOT NULL,
              UNIQUE (profile, proposal_id, revision)
            );
            CREATE INDEX IF NOT EXISTS idx_skill_proposal_revisions_proposal
              ON skill_proposal_revisions(profile, proposal_id, revision DESC);

            -- G5: backfill revision 1 for any proposals that pre-date this
            -- migration. Without this, the proposals page would show "no
            -- history" for pre-existing rows. The backfill is idempotent —
            -- the UNIQUE (profile, proposal_id, revision) constraint
            -- ensures re-running this migration is a no-op.
            INSERT OR IGNORE INTO skill_proposal_revisions
              (profile, proposal_id, revision, skill_md, safety_flags_json,
               actor, reason, created_at)
            SELECT
              p.profile,
              p.id,
              1,
              p.skill_md,
              p.safety_flags,
              'auto-generator',
              'initial create (backfilled by migration 032)',
              p.created_at
            FROM skill_proposals p
            WHERE NOT EXISTS (
              SELECT 1 FROM skill_proposal_revisions r
               WHERE r.profile = p.profile AND r.proposal_id = p.id
            );
          `);
        
    }

    // §12.033 approval_ledger
    {
          db.exec(`
            CREATE TABLE IF NOT EXISTS approval_ledger (
              id                 TEXT PRIMARY KEY,
              task_id            TEXT NOT NULL,
              approval_key       TEXT NOT NULL,
              status             TEXT NOT NULL
                                   CHECK(status IN ('pending','approved','rejected','timed_out','shutdown_rejected','superseded')),
              risk_score         REAL NOT NULL,
              reason             TEXT NOT NULL,
              requested_at       INTEGER NOT NULL,
              resolved_at        INTEGER,
              resolved_by        TEXT,
              decision           TEXT,
              source             TEXT NOT NULL
                                   CHECK(source IN ('human','timeout','shutdown','system')),
              profile            TEXT,
              session_id         TEXT,
              retry_of_task_id   TEXT,
              provenance_json    TEXT,
              created_at         INTEGER NOT NULL,
              updated_at         INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_approval_ledger_task ON approval_ledger(task_id);
            CREATE INDEX IF NOT EXISTS idx_approval_ledger_status ON approval_ledger(status);
            CREATE INDEX IF NOT EXISTS idx_approval_ledger_requested ON approval_ledger(requested_at);
            CREATE INDEX IF NOT EXISTS idx_approval_ledger_profile_status
              ON approval_ledger(profile, status);
            CREATE INDEX IF NOT EXISTS idx_approval_ledger_session_status
              ON approval_ledger(session_id, status);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_ledger_pending_unique
              ON approval_ledger(task_id, approval_key)
              WHERE status = 'pending';
          `);
        
    }

    }

    // §11 Semantic retrieval — conditional on sqlite-vec availability.
    //     The extension must be loaded before this migration runs (see
    //     src/memory/sqlite-vec-loader.ts). Without it, semantic retrieval
    //     falls back to recency-only and we leave the virtual table absent.
    let vecAvailable = false;
    try {
      const row = db.query('SELECT vec_version() as version').get() as
        | { version: string }
        | undefined;
      vecAvailable = !!row?.version;
    } catch {
      vecAvailable = false;
    }

    if (!vecAvailable) {
      console.warn(
        '[vinyan] migration001: sqlite-vec extension not loaded — skipping turn_embeddings virtual table. Semantic retrieval will fall back to recency-only.',
      );
      return;
    }

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS turn_embeddings USING vec0(
        turn_id   TEXT PRIMARY KEY,
        embedding float[${EMBEDDING_DIMENSION}]
      );

      CREATE TABLE IF NOT EXISTS turn_embedding_meta (
        turn_id    TEXT PRIMARY KEY REFERENCES session_turns(id) ON DELETE CASCADE,
        model_id   TEXT NOT NULL,
        dimension  INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_turn_embedding_meta_model
        ON turn_embedding_meta(model_id);
    `);
  },
};
