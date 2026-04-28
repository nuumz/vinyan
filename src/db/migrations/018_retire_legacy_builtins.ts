/**
 * Migration 018 — Retire legacy builtin persona ids.
 *
 * The Phase-1 agent redesign hard-cut the prior domain-locked persona roster
 * (ts-coder, system-designer, secretary, writer, creative-director,
 * plot-architect, story-strategist, novelist, editor, critic) and replaced it
 * with role-pure templates (coordinator, developer, architect, author,
 * reviewer, assistant). Persisted `agent_proposals` rows that targeted any of
 * the retired ids are no longer addressable, so we drop them rather than
 * leaving orphans the new code path cannot resolve.
 *
 * No alias rewrite is performed. The redesign is intentionally a hard cut —
 * users who had custom proposals on the legacy roster need to re-propose
 * against the new roles. See CHANGELOG and `docs/design/agent-redesign.md`.
 */

import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

const RETIRED_IDS = [
  'ts-coder',
  'system-designer',
  'secretary',
  'writer',
  'creative-director',
  'plot-architect',
  'story-strategist',
  'novelist',
  'editor',
  'critic',
] as const;

export const migration018: Migration = {
  version: 18,
  description: 'Retire legacy builtin persona ids — drop agent_proposals rows targeting the pre-redesign roster',
  up(db: Database) {
    const placeholders = RETIRED_IDS.map(() => '?').join(',');
    db.prepare(`DELETE FROM agent_proposals WHERE suggested_agent_id IN (${placeholders})`).run(...RETIRED_IDS);
  },
};
