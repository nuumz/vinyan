/**
 * Spec Room Preset — role composition for collaborative specification refinement.
 *
 * Roles:
 *   - spec-author: drafts the SpecArtifact (summary, acceptance criteria, API
 *     shape) into `spec:draft:*` scope.
 *   - api-designer: refines API shape and data contracts into
 *     `spec:api:*` scope.
 *   - edge-case-critic: surfaces edge cases the author missed; writes into
 *     `spec:edge-cases:*` scope. Cannot rewrite the spec — only flag gaps.
 *   - spec-integrator: reconciles author + api-designer + critic outputs into
 *     the final SpecArtifact under `spec:final:*` and converges the room.
 *
 * The preset is pure data — A3 deterministic. Spec Room dispatch is
 * orchestrated by phase-spec.ts; the four roles enforce A1 separation
 * between drafting and review.
 */

import type { RoleSpec, RoomContract } from '../types.ts';

const SPEC_AUTHOR_ROLE: RoleSpec = {
  name: 'spec-author',
  responsibility:
    'Draft the initial SpecArtifact: summary, acceptance criteria, and API shape based on the goal. Write into `spec:draft:*`. Be explicit about what is in and out of scope.',
  writableBlackboardKeys: ['spec:draft:*'],
  maxTurns: 2,
  canWriteFiles: false,
};

const API_DESIGNER_ROLE: RoleSpec = {
  name: 'api-designer',
  responsibility:
    "Refine the author's API shape and data contracts. Add type signatures, invariants, and missing fields. Write into `spec:api:*`. Do NOT rewrite acceptance criteria.",
  writableBlackboardKeys: ['spec:api:*'],
  maxTurns: 2,
  canWriteFiles: false,
};

const EDGE_CASE_CRITIC_ROLE: RoleSpec = {
  name: 'edge-case-critic',
  responsibility:
    'Identify edge cases the author missed: failure modes, boundary conditions, concurrency hazards, security risks. Write into `spec:edge-cases:*`. Flag concerns; do NOT propose alternative criteria.',
  writableBlackboardKeys: ['spec:edge-cases:*'],
  maxTurns: 2,
  canWriteFiles: false,
};

const SPEC_INTEGRATOR_ROLE: RoleSpec = {
  name: 'spec-integrator',
  responsibility:
    'Reconcile drafter, api-designer, and critic outputs into a single SpecArtifact JSON conforming to SpecArtifactSchema. Resolve conflicts by favoring stricter criteria. Write into `spec:final:*` and converge the room when the artifact is complete.',
  writableBlackboardKeys: ['spec:final:*'],
  maxTurns: 2,
  canWriteFiles: false,
};

export const SPEC_ROOM_ROLES: RoleSpec[] = [
  SPEC_AUTHOR_ROLE,
  API_DESIGNER_ROLE,
  EDGE_CASE_CRITIC_ROLE,
  SPEC_INTEGRATOR_ROLE,
];

export interface SpecRoomOptions {
  roomId: string;
  parentTaskId: string;
  goal: string;
  tokenBudget: number;
  /** Override convergence threshold (default 0.7 — matches goal-alignment heuristic cap). */
  convergenceThreshold?: number;
  /** When set, the spec is scoped to a Team's persistent blackboard (Ecosystem O3). */
  teamId?: string;
  /** Keys imported from team blackboard at open + exported back at converged close. */
  teamSharedKeys?: string[];
}

/**
 * Build a RoomContract pre-configured for collaborative SpecArtifact production.
 * The contract is consumed by RoomDispatcher; outputs land in the
 * `spec:final:*` blackboard which phase-spec parses into a SpecArtifact.
 */
export function buildSpecRoomContract(options: SpecRoomOptions): RoomContract {
  return {
    roomId: options.roomId,
    parentTaskId: options.parentTaskId,
    goal: options.goal,
    roles: SPEC_ROOM_ROLES,
    maxRounds: 2,
    minRounds: 1,
    convergenceThreshold: options.convergenceThreshold ?? 0.7,
    tokenBudget: options.tokenBudget,
    teamId: options.teamId,
    teamSharedKeys: options.teamSharedKeys,
  };
}

/**
 * Heuristic: should this goal use the Spec Room rather than the generic
 * drafter/critic/integrator topology produced by room-selector?
 *
 * Conservative — fires on code-mutation goals where having a frozen spec
 * upstream of generation pays off. Pure regex; no LLM, no I/O.
 */
// Two regexes — \b cannot be relied on for Thai (Thai chars are \W).
const SPEC_ROOM_TRIGGER_REGEX_EN =
  /\b(implement|build|add|create|design|develop)\b[^.?!]{0,80}\b(feature|api|endpoint|service|module|component|tool|cli|migration|integration|workflow)\b/iu;
const SPEC_ROOM_TRIGGER_REGEX_TH =
  /(ทำ|สร้าง|พัฒนา)[^.?!]{0,80}(ฟีเจอร์|ระบบ|โมดูล|รายงาน|บริการ|เครื่องมือ)/u;

const SPEC_ROOM_MIN_GOAL_LENGTH = 15;

export function shouldUseSpecRoom(goal: string): boolean {
  if (goal.trim().length < SPEC_ROOM_MIN_GOAL_LENGTH) return false;
  return SPEC_ROOM_TRIGGER_REGEX_EN.test(goal) || SPEC_ROOM_TRIGGER_REGEX_TH.test(goal);
}
