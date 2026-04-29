/**
 * Migration 019 — Per-(persona, skill, task-signature) outcome tracking.
 *
 * Phase-3 introduces a separate outcome store so the auction's
 * `BidAccuracyTracker` (provider-keyed) does not get conflated with
 * skill-level learning signals. The table lets the autonomous skill creator
 * (Phase 4) trigger per-(persona × task-signature) when sustained
 * prediction-error reduction is observed for a specific skill loadout.
 */

import type { Database } from 'bun:sqlite';
import { SKILL_OUTCOME_SCHEMA_SQL } from '../skill-outcome-schema.ts';
import type { Migration } from './migration-runner.ts';

export const migration019: Migration = {
  version: 19,
  description: 'Per-(persona, skill, task-signature) outcome tracking for Phase-3 skill awareness',
  up(db: Database) {
    db.exec(SKILL_OUTCOME_SCHEMA_SQL);
  },
};
