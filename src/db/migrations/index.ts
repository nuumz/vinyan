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
import { migration015 } from './015_add_session_messages.ts';
import { migration016 } from './016_add_room_tables.ts';
import { migration017 } from './017_add_decomposition_pattern_type.ts';
import { migration018 } from './018_add_agent_contexts.ts';
import { migration019 } from './019_add_soul_columns.ts';
import { migration020 } from './020_add_local_oracle_profiles.ts';
import { migration021 } from './021_drop_dead_worker_columns.ts';
import { migration022 } from './022_drop_legacy_worker_config_columns.ts';
import { migration023 } from './023_add_agent_profile.ts';
import { migration024 } from './024_cleanup_null_engine_config.ts';
import { migration025 } from './025_add_agent_id_to_skills.ts';
import { migration026 } from './026_relax_agent_profile_singleton.ts';
import { migration027 } from './027_add_agent_profile_role_columns.ts';
import { migration028 } from './028_add_agent_id_to_traces.ts';
import type { Migration } from './migration-runner.ts';

/** All migrations in version order. */
export const ALL_MIGRATIONS: Migration[] = [
  migration001,
  migration002,
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
  migration016,
  migration017,
  migration018,
  migration019,
  migration020,
  migration021,
  migration022,
  migration023,
  migration024,
  migration025,
  migration026,
  migration027,
  migration028,
];
