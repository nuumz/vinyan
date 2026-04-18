/**
 * Migration 018 — Agent Context table.
 *
 * Stores persistent agent identity, episodic memory, and learned skills.
 * Each row corresponds to a EngineProfile.id — the agent_id foreign key
 * is logical (not enforced via FK) because worker_profiles may not exist
 * in all deployment modes.
 *
 * All compound fields (strengths, episodes, proficiencies, etc.) are stored
 * as JSON text columns — simple, portable, and queryable via json_extract().
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration018: Migration = {
  version: 18,
  description: 'Add agent_contexts table for persistent agent identity, memory, and skills',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_contexts (
        agent_id            TEXT PRIMARY KEY,
        persona             TEXT NOT NULL DEFAULT '',
        strengths           TEXT NOT NULL DEFAULT '[]',
        weaknesses          TEXT NOT NULL DEFAULT '[]',
        approach_style      TEXT NOT NULL DEFAULT '',
        episodes            TEXT NOT NULL DEFAULT '[]',
        lessons_summary     TEXT NOT NULL DEFAULT '',
        proficiencies       TEXT NOT NULL DEFAULT '{}',
        preferred_approaches TEXT NOT NULL DEFAULT '{}',
        anti_patterns       TEXT NOT NULL DEFAULT '[]',
        updated_at          INTEGER NOT NULL
      );
    `);
  },
};
