/**
 * Agent Conversation Room (ACR) — type definitions.
 *
 * A Room is a deterministic collaboration substrate for role-based iterative
 * refinement with shared state and convergence. The Supervisor FSM is pure
 * (A3); participants are generator-only (A1); blackboard writes are
 * role-scoped (A6). The Room output is a normal WorkerResult so phase-verify
 * and all downstream phases are transparent to its existence.
 *
 * Source of truth: plan at ~/.claude/plans/greedy-napping-beacon.md
 * Related: docs/design/agent-conversation.md
 */
import { z } from 'zod/v4';
import type { ProposedMutation } from '../agent/session-overlay.ts';

// ── RoleSpec — one participant's responsibility envelope ────────────

export const RoleSpecSchema = z.object({
  /** Stable role name, e.g. 'drafter-0' / 'critic' / 'integrator'. */
  name: z.string().min(1),
  /** Human-readable responsibility sentence (fed into the role's init prompt). */
  responsibility: z.string(),
  /** Glob patterns for blackboard keys this role may WRITE (A6). */
  writableBlackboardKeys: z.array(z.string()),
  /** Maximum turns this role may take per room round. */
  maxTurns: z.number().int().positive(),
  /** When true, the role's participant keeps file_write capability;
   *  when false, its contract clone drops file_write (critic default). */
  canWriteFiles: z.boolean(),
});

export type RoleSpec = z.infer<typeof RoleSpecSchema>;

// ── RoomContract — the instrument the Supervisor enforces ───────────

export const RoomContractSchema = z.object({
  roomId: z.string(),
  parentTaskId: z.string(),
  goal: z.string(),
  /** All roles must be admitted and must converge before closing. */
  roles: z.array(RoleSpecSchema).min(2),
  /** Maximum conversation rounds before forcing a partial close. */
  maxRounds: z.number().int().positive(),
  /** At least this many rounds must complete before convergence may fire. */
  minRounds: z.number().int().nonnegative(),
  /** Goal-alignment confidence floor for convergence (matches MAX_CONFIDENCE=0.7). */
  convergenceThreshold: z.number().min(0).max(1),
  /** Token budget shared across all participants. */
  tokenBudget: z.number().int().positive(),
  /**
   * Ecosystem O3 — when set, the room is scoped to an existing team.
   * At open, the Supervisor imports `teamSharedKeys` from the team's
   * persistent blackboard into the room blackboard under author role
   * `team-bridge`. At close with status='converged', keys modified
   * during the room are written back. Partial / failed / awaiting-user
   * closes do NOT persist — dirty room state must not pollute durable
   * team state.
   */
  teamId: z.string().optional(),
  /**
   * Keys to import from team blackboard at open AND export back at
   * converged close. Keys NOT in this list are room-scoped only.
   */
  teamSharedKeys: z.array(z.string()).optional(),
});

export type RoomContract = z.infer<typeof RoomContractSchema>;

// ── RoomParticipant — a role slot filled by a worker ────────────────

export const ParticipantStatusSchema = z.enum(['admitted', 'active', 'yielded', 'failed']);
export type ParticipantStatus = z.infer<typeof ParticipantStatusSchema>;

export const RoomParticipantSchema = z.object({
  /** Composite id: `${roomId}::${roleName}`. Used internally only. */
  id: z.string(),
  roomId: z.string(),
  roleName: z.string(),
  /** WorkerSelector-chosen worker id (local fleet). */
  workerId: z.string(),
  /** Concrete model id used for A1 distinct-engine check. */
  workerModelId: z.string(),
  turnsUsed: z.number().int().nonnegative().default(0),
  tokensUsed: z.number().int().nonnegative().default(0),
  status: ParticipantStatusSchema.default('admitted'),
  admittedAt: z.number(),
});

export type RoomParticipant = z.infer<typeof RoomParticipantSchema>;

// ── LedgerEntry — append-only hash-chained message ──────────────────

export const LedgerEntryTypeSchema = z.enum([
  'propose',
  'affirm',
  'reject',
  'claim',
  'query',
  'answer',
  'uncertain-turn',
  'violation',
  'converge-vote',
]);
export type LedgerEntryType = z.infer<typeof LedgerEntryTypeSchema>;

/** Genesis prev-hash: 64 zero hex chars. The ledger verifies its chain
 *  against this fixed root to detect tampered or reordered entries. */
export const LEDGER_GENESIS_PREV_HASH = '0'.repeat(64);

export const LedgerEntrySchema = z.object({
  seq: z.number().int().nonnegative(),
  timestamp: z.number(),
  /** Participant id that authored this entry (or 'supervisor' for system events). */
  author: z.string(),
  authorRole: z.string(),
  type: LedgerEntryTypeSchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  prevHash: z.string().regex(/^[a-f0-9]{64}$/),
  /** Role-specific payload; validated by the caller. Kept loose here because
   *  payload shapes differ per entry type (affirm refs, claim value, etc.). */
  payload: z.unknown(),
});

export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

// ── BlackboardEntry — a single scoped-write cell ────────────────────

export const BlackboardEntrySchema = z.object({
  key: z.string(),
  value: z.unknown(),
  authorRole: z.string(),
  version: z.number().int().nonnegative(),
  timestamp: z.number(),
});

export type BlackboardEntry = z.infer<typeof BlackboardEntrySchema>;

// ── RoomState — FSM + transient state ───────────────────────────────

export type RoomStatus = 'opening' | 'active' | 'converging' | 'converged' | 'partial' | 'failed' | 'awaiting-user';

/** Convergence check outcome — pure predicate value. */
export type ConvergenceOutcome = 'converged' | 'partial' | 'open';

export interface RoomState {
  contract: RoomContract;
  status: RoomStatus;
  rounds: number;
  /** Index into contract.roles for the next role to act this round. */
  currentRoleIndex: number;
  /** Participants keyed by participant id. */
  participants: Map<string, RoomParticipant>;
  /** Latest staged mutation per file (last-writer-wins). */
  stagedMutations: Map<string, ProposedMutation>;
  tokensConsumed: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  uncertainties: string[];
  needsUserInput: boolean;
  pendingQuestions: string[];
  failureReason?: string;
  openedAt: number;
  closedAt?: number;
}

// ── RoomResult — what RoomDispatcher returns to phase-generate ──────

export interface RoomResult {
  roomId: string;
  status: RoomStatus;
  rounds: number;
  mutations: ProposedMutation[];
  uncertainties: string[];
  tokensConsumed: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  durationMs: number;
  needsUserInput: boolean;
  pendingQuestions: string[];
  ledger: LedgerEntry[];
  failureReason?: string;
}

// ── Errors ──────────────────────────────────────────────────────────

/** Thrown when a role attempts to write a blackboard key outside its scope (A6). */
export class BlackboardScopeViolation extends Error {
  override readonly name = 'BlackboardScopeViolation';
  constructor(
    public readonly roleName: string,
    public readonly key: string,
    public readonly allowed: readonly string[],
  ) {
    super(`Role '${roleName}' cannot write blackboard key '${key}'; allowed patterns: [${allowed.join(', ')}]`);
  }
}

/** Thrown when the dispatcher cannot admit a role (no distinct model, no worker). */
export class RoomAdmissionFailure extends Error {
  override readonly name = 'RoomAdmissionFailure';
  constructor(
    public readonly roleName: string,
    public readonly reason: 'no-distinct-model' | 'no-worker-available',
    message: string,
  ) {
    super(message);
  }
}

/** Thrown by the Supervisor when the shared budget is exhausted mid-round. */
export class RoomBudgetExhausted extends Error {
  override readonly name = 'RoomBudgetExhausted';
  constructor(
    public readonly roomId: string,
    public readonly roundsCompleted: number,
  ) {
    super(`Room ${roomId} exhausted budget after ${roundsCompleted} rounds`);
  }
}
