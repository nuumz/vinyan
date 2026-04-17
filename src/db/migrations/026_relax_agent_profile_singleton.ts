/**
 * Migration 026 — Relax `agent_profile` singleton constraint.
 *
 * Phase 1 pinned `agent_profile` to exactly one row (`CHECK(id = 'local')`),
 * modeling "the workspace's host agent". Phase 2 introduces specialist agents
 * (ts-coder, writer, etc.) that need their own profile rows with role /
 * specialization / persona metadata.
 *
 * SQLite cannot drop a CHECK constraint in-place — use the standard
 * table-rebuild pattern (CREATE new → INSERT SELECT → DROP old → RENAME).
 *
 * Idempotency: inspect `sqlite_master.sql` for the CHECK clause; skip
 * the rebuild if the constraint is already gone. The existing `'local'`
 * row is preserved unchanged — Phase 2 treats it as the host agent.
 *
 * No data loss: single SELECT copies all columns 1:1.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration026: Migration = {
  version: 26,
  description: 'Relax agent_profile singleton constraint (drop CHECK id=local)',
  up(db: Database): void {
    // Idempotency guard: if the CHECK clause is gone from sqlite_master, skip.
    const row = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_profile'`)
      .get() as { sql: string } | null;
    if (!row) return; // table not yet created (shouldn't happen at v26 but be defensive)
    if (!/CHECK\s*\(\s*id\s*=\s*'local'\s*\)/i.test(row.sql)) {
      // Already rebuilt on a previous run
      return;
    }

    db.exec(`
      CREATE TABLE agent_profile_new (
        id                  TEXT PRIMARY KEY,
        instance_id         TEXT NOT NULL,
        display_name        TEXT NOT NULL DEFAULT 'vinyan',
        description         TEXT,
        workspace_path      TEXT NOT NULL,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        preferences_json    TEXT NOT NULL DEFAULT '{}',
        capabilities_json   TEXT NOT NULL DEFAULT '[]',
        vinyan_md_path      TEXT,
        vinyan_md_hash      TEXT
      );

      INSERT INTO agent_profile_new (
        id, instance_id, display_name, description, workspace_path,
        created_at, updated_at, preferences_json, capabilities_json,
        vinyan_md_path, vinyan_md_hash
      )
      SELECT id, instance_id, display_name, description, workspace_path,
             created_at, updated_at, preferences_json, capabilities_json,
             vinyan_md_path, vinyan_md_hash
      FROM agent_profile;

      DROP TABLE agent_profile;
      ALTER TABLE agent_profile_new RENAME TO agent_profile;
    `);
  },
};
