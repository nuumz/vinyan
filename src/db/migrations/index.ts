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
import type { Migration } from './migration-runner.ts';

/** All migrations in version order. */
export const ALL_MIGRATIONS: Migration[] = [migration001];
