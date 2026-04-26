/**
 * Brainstorm Room Preset — role composition for ideation tasks (BEFORE Spec).
 *
 * Roles:
 *   - drafter-{0..N}: each generates an independent candidate approach
 *     into `brainstorm:draft:{i}/*`. N capped by MAX_BRAINSTORM_DRAFTERS to
 *     bound token cost.
 *   - integrator: dedupes overlapping candidates, scores them against the
 *     goal, and writes the final ranked IdeationResult under
 *     `brainstorm:final:*`.
 *   - critic: reviews drafter output for missing trade-offs; writes into
 *     `brainstorm:critique:*`. Cannot propose new candidates — only flag
 *     concerns the integrator must address.
 *
 * A1: drafters / integrator / critic are distinct roles assigned to distinct
 * model ids (RoomDispatcher enforces). A3: this preset is pure data.
 */

import { MAX_BRAINSTORM_DRAFTERS } from '../../intent/ideation-classifier.ts';
import type { RoleSpec, RoomContract } from '../types.ts';

function buildDrafterRole(index: number): RoleSpec {
  return {
    name: `drafter-${index}`,
    responsibility: `Independently propose ONE candidate approach to the user's goal. Output an IdeationCandidate JSON (id, title, approach, rationale, riskNotes, estComplexity). Write into \`brainstorm:draft:${index}/*\`. Do NOT review other drafters' candidates — independence is the point.`,
    writableBlackboardKeys: [`brainstorm:draft:${index}/*`],
    maxTurns: 1,
    canWriteFiles: false,
  };
}

const CRITIC_ROLE: RoleSpec = {
  name: 'critic',
  responsibility:
    "Review every drafter's candidate. Flag missing trade-offs, hidden risks, and suspect feasibility claims. Write into `brainstorm:critique:*`. You may NOT propose new candidates — only critique existing ones.",
  writableBlackboardKeys: ['brainstorm:critique:*'],
  maxTurns: 1,
  canWriteFiles: false,
};

const INTEGRATOR_ROLE: RoleSpec = {
  name: 'integrator',
  responsibility:
    'Combine drafter candidates and critic feedback into a single IdeationResult JSON. Dedupe overlapping candidates, score each in [0,1], rank by score, and produce convergenceScore = top score - second score (clamped to [0,1]). Write into `brainstorm:final:*` and converge the room.',
  writableBlackboardKeys: ['brainstorm:final:*'],
  maxTurns: 2,
  canWriteFiles: false,
};

export interface BrainstormRoomOptions {
  roomId: string;
  parentTaskId: string;
  goal: string;
  tokenBudget: number;
  /** Number of drafter roles (clamped to [2, MAX_BRAINSTORM_DRAFTERS]). */
  drafterCount?: number;
  /** Override convergence threshold (default 0.6 — lower than spec/code rooms
   *  because ideation legitimately can stay diverse). */
  convergenceThreshold?: number;
}

/** Defaults exposed for tests + room-selector reuse. */
export const BRAINSTORM_ROOM_DEFAULTS = {
  drafterCount: 3,
  convergenceThreshold: 0.6,
  maxRounds: 2,
  minRounds: 1,
} as const;

/**
 * Build a RoomContract for the Brainstorm phase. Output is parsed by
 * phase-brainstorm.ts into an IdeationResult after convergence.
 */
export function buildBrainstormRoomContract(options: BrainstormRoomOptions): RoomContract {
  const requested = options.drafterCount ?? BRAINSTORM_ROOM_DEFAULTS.drafterCount;
  const drafterCount = Math.max(2, Math.min(MAX_BRAINSTORM_DRAFTERS, requested));

  const drafters: RoleSpec[] = [];
  for (let i = 0; i < drafterCount; i++) drafters.push(buildDrafterRole(i));

  const roles: RoleSpec[] = [...drafters, CRITIC_ROLE, INTEGRATOR_ROLE];

  return {
    roomId: options.roomId,
    parentTaskId: options.parentTaskId,
    goal: options.goal,
    roles,
    maxRounds: BRAINSTORM_ROOM_DEFAULTS.maxRounds,
    minRounds: BRAINSTORM_ROOM_DEFAULTS.minRounds,
    convergenceThreshold: options.convergenceThreshold ?? BRAINSTORM_ROOM_DEFAULTS.convergenceThreshold,
    tokenBudget: options.tokenBudget,
  };
}
