/**
 * Migration Index — ordered list of top-level migrations.
 *
 * As of the 2026-04-20 consolidation, the 41 pre-1.0 historical
 * migrations were squashed into `001_initial_schema.ts`. As of the
 * 2026-05-02 consolidation, the post-041 incremental DDL migrations
 * (003-033, excluding the operational ones below) were folded into
 * the same file: their source still lives under `./_squashed/` and
 * `001_initial_schema.ts` imports + invokes them in version order.
 *
 * What stays in this top-level list:
 *   - 001 — consolidated initial schema (idempotent on every run).
 *   - 018 — legacy persona-id retirement (DELETE on agent_proposals).
 *   - 025 — task_events.session_id backfill from siblings.
 *   - 034 — skill_proposal_revisions backfill (re-run wave).
 *   - 035 — task_events cross-task session backfill via parent dispatch.
 *
 * Why those four stay separate: each performs an UPDATE / DELETE /
 * INSERT against existing rows. They are operational migrations that
 * upgrades depend on, not pure DDL. Bundling them into 001 would
 * either (a) re-run on every fresh install (harmless but wasteful)
 * or (b) lose their per-version application semantics on upgrades.
 */

export type { MigrateResult, Migration } from './migration-runner.ts';
export { MigrationRunner } from './migration-runner.ts';

import { migration001 } from './001_initial_schema.ts';
import { migration018 } from './018_retire_legacy_builtins.ts';
import { migration025 } from './025_task_events_session_backfill.ts';
import { migration034 } from './034_skill_proposal_revisions_rebackfill.ts';
import { migration035 } from './035_task_events_cross_task_session_backfill.ts';
import { migration036 } from './036_session_jsonl_index.ts';
import { migration039 } from './039_task_events_parent_task_id.ts';
import { migration040 } from './040_skill_admission_audit.ts';
import type { Migration } from './migration-runner.ts';

/** All migrations in version order. */
export const ALL_MIGRATIONS: Migration[] = [
  migration001,
  migration018,
  migration025,
  migration034,
  migration035,
  migration036,
  migration039,
  migration040,
];
