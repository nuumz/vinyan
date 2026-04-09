/**
 * Migration Index — ordered list of all database migrations.
 *
 * Add new migrations here in version order.
 */

export type { MigrateResult, Migration } from './migration-runner.ts';
export { MigrationRunner } from './migration-runner.ts';

import { migration001 } from './001_initial_schema.ts';
import { migration002 } from './002_add_session_tables.ts';
import { migration003 } from './003_add_instance_registry.ts';
import { migration004 } from './004_add_origin_provenance.ts';
import { migration005 } from './005_add_oracle_profiles.ts';
import { migration006 } from './006_add_causal_edges.ts';
import { migration007 } from './007_add_skill_composition.ts';
import { migration008 } from './008_re_agnostic_worker_profiles.ts';
import { migration009 } from './009_add_evidence_archives.ts';
import { migration010 } from './010_add_action_verb_to_rejected.ts';
import { migration011 } from './011_add_understanding_trace.ts';
import { migration012 } from './012_add_economy_tables.ts';
import { migration013 } from './013_add_market_tables.ts';
import { migration014 } from './014_add_federation_economy.ts';
import type { Migration } from './migration-runner.ts';

/** All migrations in version order. */
export const ALL_MIGRATIONS: Migration[] = [migration001, migration002, migration003, migration004, migration005, migration006, migration007, migration008, migration009, migration010, migration011, migration012, migration013, migration014];
