/**
 * Migration 023 — Workspace Agent Identity (Vinyan Agent singleton).
 *
 * Creates `agent_profile` table — workspace-level identity card for THE Vinyan Agent.
 * Singleton: `CHECK(id = 'local')` enforces exactly one row per workspace.
 *
 * This is the "agent card" — distinct from:
 *   - `worker_profiles` (per-model engine configs for fleet governance)
 *   - `session_store` (per-session ephemeral state)
 *   - `.vinyan/instance-id` (A2A UUID)
 *
 * Stores: displayName, description, preferences, declared capabilities,
 * and a VINYAN.md link/hash to track memory freshness.
 * Aggregate counters are computed on-demand (not stored here).
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration023: Migration = {
  version: 23,
  description: 'Add agent_profile singleton table for workspace agent identity',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_profile (
        id                 TEXT PRIMARY KEY CHECK(id = 'local'),
        instance_id        TEXT NOT NULL,
        display_name       TEXT NOT NULL DEFAULT 'vinyan',
        description        TEXT,
        workspace_path     TEXT NOT NULL,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL,
        preferences_json   TEXT NOT NULL DEFAULT '{}',
        capabilities_json  TEXT NOT NULL DEFAULT '[]',
        vinyan_md_path     TEXT,
        vinyan_md_hash     TEXT
      );
    `);
  },
};
