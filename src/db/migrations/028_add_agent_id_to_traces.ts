/**
 * Migration 028 — Add `agent_id` column to `execution_traces`.
 *
 * Multi-agent trace partitioning: each trace is tagged with the specialist
 * agent that handled the task (e.g., 'ts-coder', 'writer'). Prior to this
 * migration, traces only carried `worker_id` (oracle id from the fleet),
 * so per-agent analytics (AgentEvolution, soul reflection, skill attribution)
 * read from a pool where specialist identity was opaque.
 *
 * Historical rows: `agent_id = NULL` is acceptable — pre-multi-agent
 * execution or workspace-default dispatch. Per-agent queries simply skip
 * them instead of misattributing them.
 *
 * Index: `idx_et_agent_id ON execution_traces(agent_id)` — the hot query is
 * "all traces for specialist X" during per-agent learning passes.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration028: Migration = {
  version: 28,
  description: 'Add agent_id to execution_traces for multi-agent trace partitioning',
  up(db: Database): void {
    const cols = db.prepare("PRAGMA table_info('execution_traces')").all() as Array<{ name: string }>;
    const hasAgentId = cols.some((c) => c.name === 'agent_id');
    if (!hasAgentId) {
      db.exec(`ALTER TABLE execution_traces ADD COLUMN agent_id TEXT`);
    }

    db.exec(`CREATE INDEX IF NOT EXISTS idx_et_agent_id ON execution_traces(agent_id)`);
  },
};
