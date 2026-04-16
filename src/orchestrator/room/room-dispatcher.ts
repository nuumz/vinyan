/**
 * RoomDispatcher — sequential, role-scoped orchestration over `runAgentLoop`.
 *
 * The dispatcher is the only Room-aware layer that talks to agent-loop. It
 * runs participants one-at-a-time in contract role order, accumulates each
 * `WorkerLoopResult` into the supervisor's ledger + blackboard + staged
 * mutations, checks convergence at the end of every round, and aggregates the
 * final state into a normal `WorkerResult` shape so `phase-verify` sees
 * nothing new.
 *
 * Key invariants:
 *   - **Synthetic overlay ids** (`${parentId}__room__${role}__r${round}`) are
 *     used for every `runAgentLoop` call to keep `SessionOverlay` directories
 *     disjoint. These synthetic ids MUST NOT escape into `task:start` /
 *     `task:complete` / trace / checkpoint events. The dispatcher returns
 *     an aggregated `WorkerResult` keyed to the parent `input.id`.
 *   - **A1 distinct-model enforcement**: every role is resolved via an
 *     injected `resolveParticipant` callback which MUST return a worker
 *     whose `workerModelId` has not been admitted yet. Returning `null`
 *     is treated as admission failure; the dispatcher throws
 *     `RoomAdmissionFailure` so `phase-generate` can fall back to the
 *     existing agentic-loop branch.
 *   - **A6 scope enforcement**: blackboard scope violations surface as
 *     `BlackboardScopeViolation` during `supervisor.recordResult`; the
 *     dispatcher catches them and closes the room `failed`.
 *   - **No direct DB or fleet dependencies** — the injected callbacks keep
 *     the R0 library isolated and trivially testable with stubs.
 */
import type { AgentContract } from '../../core/agent-contract.ts';
import type { VinyanBus } from '../../core/bus.ts';
import type { RoomStore } from '../../db/room-store.ts';
import type {
  ConversationEntry,
  PerceptualHierarchy,
  RoutingDecision,
  SemanticTaskUnderstanding,
  TaskDAG,
  TaskInput,
  WorkingMemoryState,
} from '../types.ts';
import type { AgentLoopDeps, WorkerLoopResult } from '../worker/agent-loop.ts';
import type { ProposedMutation } from '../worker/session-overlay.ts';
import { RoomBlackboard } from './room-blackboard.ts';
import { RoomLedger } from './room-ledger.ts';
import { type GoalVerifier, type ParticipantResult, RoomSupervisor } from './room-supervisor.ts';
import {
  BlackboardScopeViolation,
  type RoleSpec,
  RoomAdmissionFailure,
  type RoomContract,
  type RoomParticipant,
  type RoomResult,
} from './types.ts';

/** Inject point for `runAgentLoop` — keeps the library decoupled from its impl. */
export type RunAgentLoopFn = (
  input: TaskInput,
  perception: PerceptualHierarchy,
  memory: WorkingMemoryState,
  plan: TaskDAG | undefined,
  routing: RoutingDecision,
  deps: AgentLoopDeps,
  understanding?: SemanticTaskUnderstanding,
  contract?: AgentContract,
  conversationHistory?: ConversationEntry[],
) => Promise<WorkerLoopResult>;

/** Inject point for participant resolution. Returns null when no distinct
 *  worker is available (A1 violation) so the dispatcher can report failure. */
export type ResolveParticipantFn = (context: {
  role: RoleSpec;
  usedModelIds: ReadonlySet<string>;
  routing: RoutingDecision;
  roomId: string;
  parentTaskId: string;
}) => Promise<{ workerId: string; workerModelId: string } | null>;

export interface RoomDispatcherDeps {
  runAgentLoop: RunAgentLoopFn;
  resolveParticipant: ResolveParticipantFn;
  workspace: string;
  bus?: VinyanBus;
  /** Optional override — defaults to the real goal-alignment-verifier. */
  goalVerifier?: GoalVerifier;
  clock?: () => number;
  /** R2: optional SQLite persistence. When present, the dispatcher dual-writes
   *  every lifecycle event to the DB BEFORE emitting the corresponding bus event
   *  (crash-safety invariant). When absent, the room is purely in-memory (R1). */
  roomStore?: RoomStore;
}

export interface RoomExecuteInput {
  parentInput: TaskInput;
  perception: PerceptualHierarchy;
  memory: WorkingMemoryState;
  plan: TaskDAG | undefined;
  routing: RoutingDecision;
  parentContract: AgentContract;
  agentLoopDeps: AgentLoopDeps;
  understanding?: SemanticTaskUnderstanding;
  conversationHistory?: ConversationEntry[];
  contract: RoomContract;
}

/** Aggregated output — shaped for phase-generate consumption. */
export interface RoomDispatchOutcome {
  result: RoomResult;
  /** Flattened mutations in file order — fed into WorkerResult.mutations. */
  mutations: ProposedMutation[];
  /** Parent-scoped aggregate tokens for budget accumulation at phase-generate. */
  tokensConsumed: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Combined uncertainties surfaced to the parent's working memory. */
  uncertainties: string[];
  /** True when ANY participant called attempt_completion with needsUserInput. */
  needsUserInput: boolean;
  /** Questions to bubble up as TaskResult.clarificationNeeded (A2). */
  pendingQuestions: string[];
  /** Total wall-clock milliseconds for the room lifecycle. */
  durationMs: number;
}

/** Sanitize a composite id so it satisfies SessionOverlay's /^[a-zA-Z0-9_-]+$/ check. */
function sanitizeOverlayId(composite: string): string {
  return composite.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export class RoomDispatcher {
  private readonly clock: () => number;

  constructor(private readonly deps: RoomDispatcherDeps) {
    this.clock = deps.clock ?? (() => Date.now());
  }

  /**
   * Run the contract's roles sequentially, committing a ledger entry per
   * participant, checking convergence at the end of every round, and
   * producing a `RoomDispatchOutcome` that phase-generate maps into a
   * standard `WorkerResult`.
   */
  async execute(input: RoomExecuteInput): Promise<RoomDispatchOutcome> {
    const startTime = this.clock();
    const supervisor = new RoomSupervisor({ goalVerifier: this.deps.goalVerifier, clock: this.clock });
    const ledger = new RoomLedger(this.clock);
    const blackboard = new RoomBlackboard(this.clock);
    const state = supervisor.open(input.contract);

    // R2: persist session BEFORE bus emit (crash-safety invariant)
    this.persistSafe(() =>
      this.deps.roomStore?.insertSession(
        input.contract.roomId,
        input.parentInput.id,
        JSON.stringify(input.contract),
        state.status,
        state.openedAt,
      ),
    );
    this.deps.bus?.emit('room:opened', {
      roomId: input.contract.roomId,
      parentTaskId: input.parentInput.id,
      roles: input.contract.roles.map((r) => r.name),
      maxRounds: input.contract.maxRounds,
    });

    // ── Admission (A1 enforcement) ────────────────────────────────────
    try {
      await this.admitAll(supervisor, state, input);
    } catch (err) {
      if (err instanceof RoomAdmissionFailure) {
        supervisor.markViolation(state, err.message);
        this.deps.bus?.emit('room:failed', {
          roomId: input.contract.roomId,
          reason: err.reason,
          rounds: 0,
        });
      }
      throw err;
    }

    // ── Sequential round loop ─────────────────────────────────────────
    outer: for (let round = 0; round < input.contract.maxRounds; round++) {
      for (const role of input.contract.roles) {
        const participantId = this.participantIdFor(input.contract.roomId, role.name);
        const participant = state.participants.get(participantId);
        if (!participant || participant.status === 'failed') continue;

        let loopResult: WorkerLoopResult;
        try {
          loopResult = await this.runParticipant(input, role, participant, round);
        } catch (err) {
          participant.status = 'failed';
          this.deps.bus?.emit('room:failed', {
            roomId: input.contract.roomId,
            reason: `participant '${role.name}' errored: ${err instanceof Error ? err.message : String(err)}`,
            rounds: state.rounds,
          });
          supervisor.markViolation(state, `participant '${role.name}' errored`);
          break outer;
        }

        const participantResult = this.mapToParticipantResult(loopResult);

        try {
          supervisor.recordResult(state, ledger, blackboard, role, participantId, participantResult);
        } catch (err) {
          if (err instanceof BlackboardScopeViolation) {
            supervisor.markViolation(state, err.message);
            this.deps.bus?.emit('room:failed', {
              roomId: input.contract.roomId,
              reason: `blackboard-scope-violation: ${err.message}`,
              rounds: state.rounds,
            });
            break outer;
          }
          throw err;
        }

        const latest = ledger.latest();
        if (latest) {
          // R2: persist ledger entry BEFORE bus emit (crash-safety invariant)
          this.persistSafe(() => this.deps.roomStore?.insertLedgerEntry(input.contract.roomId, latest));
          // R2: persist blackboard snapshot (idempotent INSERT OR REPLACE)
          this.persistBlackboardSnapshot(input.contract.roomId, blackboard);
          // R2: persist participant state update
          const participantRow = state.participants.get(participantId);
          if (participantRow) {
            this.persistSafe(() =>
              this.deps.roomStore?.updateParticipant(
                participantId,
                participantRow.turnsUsed,
                participantRow.tokensUsed,
                participantRow.status,
              ),
            );
          }
          this.deps.bus?.emit('room:message_committed', {
            roomId: input.contract.roomId,
            seq: latest.seq,
            author: role.name,
            entryType: latest.type,
          });
        }

        // Bubble-up: any participant asking the user pauses the whole room.
        if (state.status === 'awaiting-user') {
          break outer;
        }

        // Budget check — supervisor.recordResult already accumulated tokens.
        if (state.tokensConsumed > input.contract.tokenBudget) {
          supervisor.markBudgetExhausted(state);
          this.deps.bus?.emit('room:failed', {
            roomId: input.contract.roomId,
            reason: 'budget-exhausted',
            rounds: state.rounds,
          });
          break outer;
        }
      }

      // End of round — bump the counter BEFORE the convergence check so the
      // supervisor sees the updated round count for minRounds comparisons.
      state.rounds += 1;

      const outcome = supervisor.checkConvergence(state, {
        workspace: this.deps.workspace,
        understanding: input.understanding,
        targetFiles: input.parentInput.targetFiles,
      });

      if (outcome === 'converged') {
        supervisor.markConverged(state);
        this.deps.bus?.emit('room:converged', {
          roomId: input.contract.roomId,
          rounds: state.rounds,
          mutations: state.stagedMutations.size,
          confidence: input.contract.convergenceThreshold,
        });
        break;
      }
      if (outcome === 'partial') {
        supervisor.markPartial(state, `convergence not reached after ${state.rounds} rounds`);
        this.deps.bus?.emit('room:failed', {
          roomId: input.contract.roomId,
          reason: 'max-rounds-no-convergence',
          rounds: state.rounds,
        });
        break;
      }
      // outcome === 'open' → continue to next round
    }

    // If the loop exits without an explicit terminal transition, treat as partial.
    if (state.status === 'active' || state.status === 'opening') {
      supervisor.markPartial(state, 'loop ended without convergence');
      this.deps.bus?.emit('room:failed', {
        roomId: input.contract.roomId,
        reason: 'loop-ended-without-convergence',
        rounds: state.rounds,
      });
    }

    // R2: persist final session status
    this.persistSafe(() =>
      this.deps.roomStore?.updateSessionStatus(
        input.contract.roomId,
        state.status,
        state.rounds,
        state.tokensConsumed,
        state.closedAt ?? null,
      ),
    );

    const durationMs = this.clock() - startTime;
    const result = supervisor.finalize(state, ledger, durationMs);

    return {
      result,
      mutations: result.mutations,
      tokensConsumed: result.tokensConsumed,
      cacheReadTokens: result.cacheReadTokens,
      cacheCreationTokens: result.cacheCreationTokens,
      uncertainties: result.uncertainties,
      needsUserInput: result.needsUserInput,
      pendingQuestions: result.pendingQuestions,
      durationMs,
    };
  }

  // ── Internals ──────────────────────────────────────────────────────

  private participantIdFor(roomId: string, roleName: string): string {
    return `${roomId}::${roleName}`;
  }

  private async admitAll(
    supervisor: RoomSupervisor,
    state: import('./types.ts').RoomState,
    input: RoomExecuteInput,
  ): Promise<void> {
    const usedModelIds = new Set<string>();
    for (const role of input.contract.roles) {
      const resolved = await this.deps.resolveParticipant({
        role,
        usedModelIds,
        routing: input.routing,
        roomId: input.contract.roomId,
        parentTaskId: input.parentInput.id,
      });
      if (!resolved) {
        throw new RoomAdmissionFailure(
          role.name,
          'no-distinct-model',
          `role '${role.name}': no distinct-model worker available for admission`,
        );
      }
      if (usedModelIds.has(resolved.workerModelId)) {
        throw new RoomAdmissionFailure(
          role.name,
          'no-distinct-model',
          `role '${role.name}': model '${resolved.workerModelId}' already admitted (A1 violation)`,
        );
      }
      usedModelIds.add(resolved.workerModelId);

      const participant: RoomParticipant = {
        id: this.participantIdFor(input.contract.roomId, role.name),
        roomId: input.contract.roomId,
        roleName: role.name,
        workerId: resolved.workerId,
        workerModelId: resolved.workerModelId,
        turnsUsed: 0,
        tokensUsed: 0,
        status: 'admitted',
        admittedAt: this.clock(),
      };
      supervisor.admit(state, participant);
      // R2: persist participant BEFORE bus emit
      this.persistSafe(() =>
        this.deps.roomStore?.insertParticipant(
          participant.id,
          input.contract.roomId,
          role.name,
          resolved.workerId,
          resolved.workerModelId,
          'admitted',
          participant.admittedAt,
        ),
      );
      this.deps.bus?.emit('room:participant_admitted', {
        roomId: input.contract.roomId,
        participantId: participant.id,
        roleName: role.name,
        workerModelId: resolved.workerModelId,
      });
    }
  }

  private async runParticipant(
    input: RoomExecuteInput,
    role: RoleSpec,
    participant: RoomParticipant,
    round: number,
  ): Promise<WorkerLoopResult> {
    const syntheticId = sanitizeOverlayId(`${input.parentInput.id}__room__${role.name}__r${round}`);
    const syntheticInput: TaskInput = {
      ...input.parentInput,
      id: syntheticId,
      goal: this.composeRoleGoal(input.parentInput.goal, role, round),
    };
    const roleRouting: RoutingDecision = {
      ...input.routing,
      model: participant.workerModelId,
    };
    const roleContract = this.cloneContractForRole(input.parentContract, role, syntheticId, input.contract.roomId);

    return this.deps.runAgentLoop(
      syntheticInput,
      input.perception,
      input.memory,
      input.plan,
      roleRouting,
      input.agentLoopDeps,
      input.understanding,
      roleContract,
      input.conversationHistory,
    );
  }

  private composeRoleGoal(parentGoal: string, role: RoleSpec, round: number): string {
    return `[Room role: ${role.name} | round ${round + 1}] ${role.responsibility}\n\nUnderlying goal: ${parentGoal}`;
  }

  private cloneContractForRole(
    parent: AgentContract,
    role: RoleSpec,
    syntheticTaskId: string,
    roomId?: string,
  ): AgentContract {
    const filteredCaps = role.canWriteFiles
      ? parent.capabilities
      : parent.capabilities.filter((cap) => cap.type !== 'file_write');
    return {
      ...parent,
      taskId: syntheticTaskId,
      capabilities: filteredCaps,
      issuedAt: this.clock(),
      immutable: true,
      roomContext: roomId
        ? {
            roomId,
            participantId: `${roomId}::${role.name}`,
            roleName: role.name,
            writableBlackboardKeys: [...role.writableBlackboardKeys],
          }
        : undefined,
    };
  }

  private mapToParticipantResult(result: WorkerLoopResult): ParticipantResult {
    return {
      mutations: result.mutations.filter((m) => m.content !== null),
      uncertainties: [...result.uncertainties],
      tokensConsumed: result.tokensConsumed,
      cacheReadTokens: result.cacheReadTokens,
      cacheCreationTokens: result.cacheCreationTokens,
      needsUserInput: result.needsUserInput === true,
      proposedContent: result.proposedContent,
      durationMs: result.durationMs,
    };
  }

  // ── R2 persistence helpers ─────────────────────────────────────────

  /** Best-effort persistence — DB failures are non-fatal (matches ShadowJob pattern). */
  private persistSafe(fn: () => void): void {
    if (!this.deps.roomStore) return;
    try {
      fn();
    } catch (err) {
      console.warn(`[vinyan-room] persistence failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Persist current blackboard snapshot + emit bus events. DB before emit (crash-safety). */
  private persistBlackboardSnapshot(roomId: string, blackboard: RoomBlackboard): void {
    for (const [key, entry] of blackboard.readAll()) {
      this.persistSafe(() =>
        this.deps.roomStore?.insertBlackboardEntry(
          roomId,
          key,
          entry.version,
          JSON.stringify(entry.value),
          entry.authorRole,
          entry.timestamp,
        ),
      );
      this.deps.bus?.emit('room:blackboard_updated', {
        roomId,
        key,
        author: entry.authorRole,
        version: entry.version,
      });
    }
  }
}
