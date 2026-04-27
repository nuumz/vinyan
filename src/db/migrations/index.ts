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
import { migration008 } from './008_skill_trust_ledger.ts';
import { migration009 } from './009_user_md_dialectic.ts';
import { migration010 } from './010_commonsense_rules.ts';
import { migration011 } from './011_commonsense_rule_telemetry.ts';
import { migration012 } from './012_capability_trace_metadata.ts';
import { migration013 } from './013_rule_promote_capability_action.ts';
import { migration014 } from './014_session_metadata.ts';
import { migration015 } from './015_capability_route_audit.ts';
import type { Migration } from './migration-runner.ts';

/** All migrations in version order. */
export const ALL_MIGRATIONS: Migration[] = [
  migration001,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
  migration009,
  migration010,
  migration011,
  migration012,
  migration013,
  migration014,
  migration015,
];
