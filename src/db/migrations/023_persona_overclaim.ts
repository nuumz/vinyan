/**
 * Migration 023 — Per-persona overclaim ledger persistence.
 *
 * Phase-14 (Item 3) backs `PersonaOverclaimTracker` (Phase 12) with a
 * SQLite-resident counter so the auction's `overclaimPenalty` survives
 * orchestrator restarts. Without this, a process bounce drops every persona
 * back to cold-start and the penalty curve never crosses
 * `MIN_OBSERVATIONS_FOR_PENALTY = 10`.
 */
import type { Database } from 'bun:sqlite';
import { PERSONA_OVERCLAIM_SCHEMA_SQL } from '../persona-overclaim-schema.ts';
import type { Migration } from './migration-runner.ts';

export const migration023: Migration = {
  version: 23,
  description: 'Per-persona overclaim ledger persistence (Phase-14 Item 3)',
  up(db: Database) {
    db.exec(PERSONA_OVERCLAIM_SCHEMA_SQL);
  },
};
