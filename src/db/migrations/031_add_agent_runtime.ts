/**
 * Migration 031 — Agent runtime state tables.
 *
 * Adds the orthogonal runtime-state axis (Dormant/Awakening/Standby/Working)
 * that lives alongside the existing career-state axis
 * (probation/active/demoted/retired on worker_profiles).
 *
 * Runtime state answers: "is this agent currently able to take work RIGHT NOW?"
 * Career state answers:  "does this agent have a trusted track record?"
 *
 * Source of truth: docs/design/vinyan-os-ecosystem-plan.md §3.2
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration031: Migration = {
  version: 31,
  description: 'Add agent_runtime + agent_runtime_transitions tables (O1 ecosystem)',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_runtime (
        agent_id                 TEXT PRIMARY KEY,
        state                    TEXT NOT NULL
                                  CHECK(state IN ('dormant','awakening','standby','working')),
        active_task_count        INTEGER NOT NULL DEFAULT 0,
        capacity_max             INTEGER NOT NULL DEFAULT 1,
        last_transition_at       INTEGER NOT NULL,
        last_transition_reason   TEXT,
        last_heartbeat_at        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_runtime_state
        ON agent_runtime(state);

      CREATE TABLE IF NOT EXISTS agent_runtime_transitions (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id   TEXT NOT NULL,
        from_state TEXT NOT NULL,
        to_state   TEXT NOT NULL,
        reason     TEXT NOT NULL,
        task_id    TEXT,
        at         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_art_agent_at
        ON agent_runtime_transitions(agent_id, at);
      CREATE INDEX IF NOT EXISTS idx_art_task
        ON agent_runtime_transitions(task_id)
        WHERE task_id IS NOT NULL;
    `);
  },
};
