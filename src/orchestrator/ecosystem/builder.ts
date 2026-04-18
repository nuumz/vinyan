/**
 * buildEcosystem — one-call factory for a complete ecosystem stack.
 *
 * Callers that want ecosystem behaviour wired up (factory.ts, tests, smoke
 * scripts) invoke this helper to get a single bundle of subsystems that
 * share storage + clock + bus. The returned `EcosystemCoordinator` is
 * already instantiated but NOT started — the caller decides when to
 * `start()` it (usually after all other DI is complete).
 */

import type { Database } from 'bun:sqlite';

import type { VinyanBus } from '../../core/bus.ts';
import { AgentRuntimeStore } from '../../db/agent-runtime-store.ts';
import { CommitmentStore } from '../../db/commitment-store.ts';
import { TeamStore } from '../../db/team-store.ts';
import { VolunteerStore } from '../../db/volunteer-store.ts';
import type { ReasoningEngine } from '../types.ts';

import { CommitmentLedger } from './commitment-ledger.ts';
import { DepartmentIndex, type DepartmentSeed } from './department.ts';
import { EcosystemCoordinator } from './ecosystem-coordinator.ts';
import { HelpfulnessTracker } from './helpfulness-tracker.ts';
import { RuntimeStateManager } from './runtime-state.ts';
import { TeamManager } from './team.ts';
import { VolunteerRegistry } from './volunteer-protocol.ts';
import type { TaskFacts } from './commitment-bridge.ts';

export interface BuildEcosystemConfig {
  readonly db: Database;
  readonly bus: VinyanBus;
  readonly departments?: readonly DepartmentSeed[];
  readonly taskResolver: (taskId: string) => TaskFacts | null;
  readonly engineRoster: () => readonly Pick<ReasoningEngine, 'id' | 'capabilities'>[];
  readonly now?: () => number;
}

export interface EcosystemBundle {
  readonly coordinator: EcosystemCoordinator;
  readonly runtime: RuntimeStateManager;
  readonly commitments: CommitmentLedger;
  readonly teams: TeamManager;
  readonly volunteers: VolunteerRegistry;
  readonly helpfulness: HelpfulnessTracker;
  readonly departments: DepartmentIndex;
}

/**
 * Instantiate every ecosystem subsystem against a shared SQLite handle and
 * event bus. The caller is responsible for running migrations first — the
 * helper assumes tables already exist.
 */
export function buildEcosystem(config: BuildEcosystemConfig): EcosystemBundle {
  const now = config.now ?? (() => Date.now());

  const runtime = new RuntimeStateManager({
    store: new AgentRuntimeStore(config.db),
    bus: config.bus,
    now,
  });

  const commitments = new CommitmentLedger({
    store: new CommitmentStore(config.db),
    bus: config.bus,
    now,
  });

  const teams = new TeamManager({
    store: new TeamStore(config.db),
    now,
  });

  const volunteerStore = new VolunteerStore(config.db);
  const volunteers = new VolunteerRegistry({ store: volunteerStore, bus: config.bus, now });
  const helpfulness = new HelpfulnessTracker({
    store: volunteerStore,
    bus: config.bus,
    now,
  });

  const departments = new DepartmentIndex(config.departments ?? []);

  const coordinator = new EcosystemCoordinator({
    bus: config.bus,
    runtime,
    commitments,
    teams,
    volunteers,
    helpfulness,
    departments,
    taskResolver: config.taskResolver,
    engineRoster: config.engineRoster,
    now,
  });

  return {
    coordinator,
    runtime,
    commitments,
    teams,
    volunteers,
    helpfulness,
    departments,
  };
}
