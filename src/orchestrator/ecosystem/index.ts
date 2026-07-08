/**
 * Public barrel for the Vinyan ecosystem layer.
 *
 * The ecosystem layer adds behaviour on top of Fleet + Market + Room to
 * let agents participate in a full work-cycle (bid → commit → deliver /
 * volunteer → deliver). See docs/design/vinyan-os-ecosystem-plan.md.
 */

export { type BuildEcosystemConfig, buildEcosystem, type EcosystemBundle } from './builder.ts';
export { CommitmentBridge, type TaskFacts } from './commitment-bridge.ts';
export {
  CommitmentLedger,
  type OpenCommitmentParams,
  type ResolveCommitmentParams,
} from './commitment-ledger.ts';
export {
  type Department,
  DepartmentIndex,
  type DepartmentMembership,
  type DepartmentSeed,
  deriveMembership,
  normalizeSeeds,
} from './department.ts';
export {
  type CoordinatorTimerImpl,
  EcosystemCoordinator,
  type EcosystemCoordinatorConfig,
  type InvariantId,
  type InvariantViolation,
  type ReconcileReport,
} from './ecosystem-coordinator.ts';
export { HelpfulnessTracker } from './helpfulness-tracker.ts';
export {
  type AgentRuntimeSnapshot,
  isTransitionAllowed,
  type RuntimeState,
  RuntimeStateManager,
  type RuntimeTransition,
} from './runtime-state.ts';
export { TaskFactsRegistry } from './task-facts-registry.ts';
export { type CreateTeamParams, TeamManager } from './team.ts';
export {
  type SelectionVerdict,
  scoreCandidate,
  selectVolunteer,
  type VolunteerCandidate,
  type VolunteerContext,
  type VolunteerOffer,
  VolunteerRegistry,
} from './volunteer-protocol.ts';
