/**
 * Migration 016 — Persistent custom agent proposals.
 *
 * Stores quarantined AgentProposal records produced by the offline sleep-cycle
 * from repeated synthetic-agent success patterns. Activation is intentionally
 * not part of this migration or table writer.
 */

import type { Database } from 'bun:sqlite';
import { AGENT_PROPOSAL_SCHEMA_SQL } from '../agent-proposal-schema.ts';
import type { Migration } from './migration-runner.ts';

export const migration016: Migration = {
  version: 16,
  description: 'Persistent custom agent proposals from repeated synthetic-agent success patterns',
  up(db: Database) {
    db.exec(AGENT_PROPOSAL_SCHEMA_SQL);
  },
};
