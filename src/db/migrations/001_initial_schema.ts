/**
 * Migration 001 — Initial schema (consolidated).
 *
 * Replaces what used to be a chain of 41 historical migrations with the
 * single post-041 final schema. History was archaeological noise from
 * pre-1.0 iteration (add column, drop column, rename, etc.); nothing
 * externally depended on the intermediate states. Squashing them gives:
 *
 *   - 1 ALTER-free CREATE pass on fresh DBs (fast, clean).
 *   - A schema file anyone can read top-to-bottom to understand storage.
 *   - No cross-migration dependency puzzles.
 *
 * Source of truth: the post-041 dump from the old 41-migration chain.
 *
 * NOTE: This migration is idempotent — every CREATE is `IF NOT EXISTS`.
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
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const EMBEDDING_DIMENSION = 1024;

export const migration001: Migration = {
  version: 1,
  description: 'Initial consolidated schema (squashed from 41 historical migrations)',
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
