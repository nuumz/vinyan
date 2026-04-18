/**
 * Migration 033 — Team rosters + persistent team blackboards.
 *
 * A Team is a durable group of engines that share state across tasks
 * (unlike a Room, which is task-scoped and dissolves on close). Team
 * blackboards survive process restart — see docs/design/vinyan-os-ecosystem-plan.md §3.2.
 *
 * Schema aligns with `room_blackboard` (migration 016) — same
 * `(owner, key, version)` PK + `value_json` shape, keyed on `team_id`
 * instead of `room_id`.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration033: Migration = {
  version: 33,
  description: 'Add teams + team_members + team_blackboard tables (O3 ecosystem)',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS teams (
        team_id      TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        department_id TEXT,
        created_at   INTEGER NOT NULL,
        archived_at  INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_teams_department
        ON teams(department_id)
        WHERE department_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS team_members (
        team_id     TEXT NOT NULL REFERENCES teams(team_id),
        engine_id   TEXT NOT NULL,
        role        TEXT,
        joined_at   INTEGER NOT NULL,
        left_at     INTEGER,
        PRIMARY KEY (team_id, engine_id, joined_at)
      );
      CREATE INDEX IF NOT EXISTS idx_team_members_engine
        ON team_members(engine_id);

      CREATE TABLE IF NOT EXISTS team_blackboard (
        team_id     TEXT NOT NULL REFERENCES teams(team_id),
        key         TEXT NOT NULL,
        version     INTEGER NOT NULL,
        value_json  TEXT NOT NULL,
        author_id   TEXT NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (team_id, key, version)
      );
      CREATE INDEX IF NOT EXISTS idx_team_blackboard_team_key
        ON team_blackboard(team_id, key);
    `);
  },
};
