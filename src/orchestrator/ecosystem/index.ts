/**
 * Public barrel for the Vinyan ecosystem layer.
 *
 * The ecosystem layer adds behaviour on top of Fleet + Market + Room to
 * let agents participate in a full work-cycle (bid → commit → deliver /
 * volunteer → deliver). See docs/design/vinyan-os-ecosystem-plan.md.
 */

export {
  RuntimeStateManager,
  isTransitionAllowed,
  type AgentRuntimeSnapshot,
  type RuntimeState,
  type RuntimeTransition,
} from './runtime-state.ts';

export {
  CommitmentLedger,
  type OpenCommitmentParams,
  type ResolveCommitmentParams,
} from './commitment-ledger.ts';
export { CommitmentBridge, type TaskFacts } from './commitment-bridge.ts';

export {
  DepartmentIndex,
  deriveMembership,
  normalizeSeeds,
  type Department,
  type DepartmentSeed,
  type DepartmentMembership,
} from './department.ts';

export { TeamManager, type CreateTeamParams } from './team.ts';

export {
  VolunteerRegistry,
  scoreCandidate,
  selectVolunteer,
  type SelectionVerdict,
  type VolunteerCandidate,
  type VolunteerContext,
  type VolunteerOffer,
} from './volunteer-protocol.ts';

export { HelpfulnessTracker } from './helpfulness-tracker.ts';

export {
  EcosystemCoordinator,
  type CoordinatorTimerImpl,
  type EcosystemCoordinatorConfig,
  type InvariantId,
  type InvariantViolation,
  type ReconcileReport,
} from './ecosystem-coordinator.ts';

export { buildEcosystem, type EcosystemBundle, type BuildEcosystemConfig } from './builder.ts';
