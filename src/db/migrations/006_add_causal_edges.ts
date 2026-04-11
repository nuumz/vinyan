/**
 * Migration 006 — Add `causal_edges` table to World Graph.
 *
 * Tracks causal relationships: "change to file A broke file B" as observed by oracles.
 * Supports BFS traversal for transitive impact analysis.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration006: Migration = {
  version: 6,
  description: 'Add causal_edges table for oracle-observed causal relationships',
  up(db: Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS causal_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_file TEXT NOT NULL,
        target_file TEXT NOT NULL,
        oracle_name TEXT NOT NULL,
        confidence REAL NOT NULL,
        observed_at INTEGER NOT NULL,
        observation_count INTEGER DEFAULT 1,
        last_observed_at INTEGER NOT NULL,
        UNIQUE(source_file, target_file, oracle_name)
      );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_causal_source ON causal_edges(source_file);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_causal_target ON causal_edges(target_file);');
  },
};
