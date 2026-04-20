/**
 * Migration 041 — Drop narrative columns from `agent_contexts`.
 *
 * These columns duplicated content already held authoritatively in
 * `.vinyan/souls/{agentId}.soul.md` (written by SoulStore + reflected
 * by soul-reflector). `AgentContextBuilder` now hydrates narrative
 * sections from SoulStore at build time; the DB row keeps only the
 * *machine* side of agent state:
 *
 *   Kept:
 *     - agent_id           (PK)
 *     - proficiencies      (numeric stats per task signature)
 *     - episodes           (bounded audit log)
 *     - pending_insights   (per-task queue awaiting sleep-cycle synthesis)
 *     - updated_at         (staleness clock)
 *
 *   Dropped:
 *     - persona              → soul.philosophy
 *     - strengths            → derived from CapabilityModel at build time
 *     - weaknesses           → derived from CapabilityModel at build time
 *     - approach_style       → soul.selfKnowledge
 *     - lessons_summary      → soul.domainExpertise (rendered narrative)
 *     - preferred_approaches → soul.winningStrategies
 *     - anti_patterns        → soul.antiPatterns
 *
 * Source: docs/plans/sqlite-joyful-lynx.md §Phase 5 (extended scope).
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration041: Migration = {
  version: 41,
  description:
    'Drop narrative columns from agent_contexts (soul.md is source of truth)',
  up(db: Database) {
    // Idempotent column drops — only remove if present. SQLite ≥ 3.35
    // supports DROP COLUMN; bun:sqlite ships a modern SQLite.
    const cols = db.prepare("PRAGMA table_info('agent_contexts')").all() as Array<{ name: string }>;
    const present = new Set(cols.map((c) => c.name));
    const toDrop = [
      'persona',
      'strengths',
      'weaknesses',
      'approach_style',
      'lessons_summary',
      'preferred_approaches',
      'anti_patterns',
    ];
    for (const col of toDrop) {
      if (present.has(col)) {
        db.exec(`ALTER TABLE agent_contexts DROP COLUMN ${col}`);
      }
    }
  },
};
