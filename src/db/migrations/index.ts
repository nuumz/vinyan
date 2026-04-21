/**
 * Migration Index — ordered list of all database migrations.
 *
 * As of the 2026-04-20 consolidation, the 41 historical migrations have
 * been squashed into a single `001_initial_schema.ts` that creates the
 * post-041 final schema in one pass. New schema changes append migrations
 * here in version order.
 */

export type { MigrateResult, Migration } from './migration-runner.ts';
export { MigrationRunner } from './migration-runner.ts';

import { migration001 } from './001_initial_schema.ts';
import { migration003 } from './003_memory_records.ts';
import { migration004 } from './004_skill_artifact.ts';
import { migration005 } from './005_trajectory_export.ts';
import { migration006 } from './006_gateway_tables.ts';
import { migration007 } from './007_plugin_audit.ts';
import type { Migration } from './migration-runner.ts';

/** All migrations in version order. */
export const ALL_MIGRATIONS: Migration[] = [
  migration001,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
];
