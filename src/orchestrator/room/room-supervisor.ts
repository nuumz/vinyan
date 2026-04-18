/**
 * RoomSupervisor — pure, deterministic FSM for Agent Conversation Rooms.
 *
 * The Supervisor owns NO I/O, NO LLM, NO bus, NO clock (injectable only).
 * It processes participant results into staged mutations, ledger entries,
 * and blackboard writes; it advances the round cursor; and it evaluates a
 * pure convergence predicate backed by the Goal Alignment Oracle (injected
 * as a function reference).
 *
 * A1: generation stays in the participants; the supervisor never evaluates
 *     message content — only its structure and metadata.
 * A3: every transition is a pure function of (state, input). No LLM in the
 *     routing/admission/closure path.
 * A6: blackboard writes go through RoomBlackboard.write() which enforces
 *     role scope synchronously. Scope violations surface as thrown errors;
 *     the dispatcher catches them and closes the room `failed`.
 */
import { type HypothesisTuple, isAbstention, type OracleVerdict } from '../../core/types.ts';
import { verify as goalAlignmentVerify } from '../../oracle/goal-alignment/goal-alignment-verifier.ts';
import type { TaskUnderstanding } from '../types.ts';
import type { ProposedMutation } from '../agent/session-overlay.ts';
import type { RoomBlackboard } from './room-blackboard.ts';
import type { RoomLedger } from './room-ledger.ts';
import type { ConvergenceOutcome, RoleSpec, RoomContract, RoomParticipant, RoomResult, RoomState } from './types.ts';

/** Injectable goal-alignment verifier — matches the exported `verify` shape. */
export type GoalVerifier = typeof goalAlignmentVerify;

/** Input the dispatcher provides per participant turn. */
export interface ParticipantResult {
  mutations: ProposedMutation[];
  uncertainties: string[];
  tokensConsumed: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Agent Conversation: bubble-up signal; when true the room goes awaiting-user. */
  needsUserInput: boolean;
  /** Optional non-mutation output (reasoning tasks) — recorded into the ledger. */
  proposedContent?: string;
  durationMs: number;
}

/** Context required to evaluate the convergence predicate. */
export interface ConvergenceContext {
  workspace: string;
  understanding?: TaskUnderstanding;
  targetFiles?: string[];
}

export class RoomSupervisor {
  private readonly goalVerifier: GoalVerifier;
  private readonly clock: () => number;

  constructor(deps: { goalVerifier?: GoalVerifier; clock?: () => number } = {}) {
    this.goalVerifier = deps.goalVerifier ?? goalAlignmentVerify;
    this.clock = deps.clock ?? (() => Date.now());
  }

  /** Initialize a fresh RoomState from a contract. Status starts at `opening`. */
  open(contract: RoomContract): RoomState {
    return {
      contract,
      status: 'opening',
      rounds: 0,
      currentRoleIndex: 0,
      participants: new Map(),
      stagedMutations: new Map(),
      tokensConsumed: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      uncertainties: [],
      needsUserInput: false,
      pendingQuestions: [],
      openedAt: this.clock(),
    };
  }

  /** Admit a participant. When every role is filled the state transitions to `active`. */
  admit(state: RoomState, participant: RoomParticipant): void {
    state.participants.set(participant.id, participant);
    if (state.status === 'opening' && state.participants.size >= state.contract.roles.length) {
      state.status = 'active';
    }
  }

  /**
   * Process one participant's turn result. Accumulates tokens, stages mutations
   * (last-writer-wins per file), writes the blackboard (throws on scope
   * violation → dispatcher closes the room `failed`), appends a ledger entry,
   * and updates the participant record.
   *
   * When `result.needsUserInput` is true the supervisor sets `status='awaiting-user'`
   * and records a `query` ledger entry; no mutation staging happens for this turn.
   */
  recordResult(
    state: RoomState,
    ledger: RoomLedger,
    blackboard: RoomBlackboard,
    role: RoleSpec,
    participantId: string,
    result: ParticipantResult,
  ): void {
    // Token accounting fires for every result, even budget-exhausting ones.
    state.tokensConsumed += result.tokensConsumed;
    state.cacheReadTokens += result.cacheReadTokens ?? 0;
    state.cacheCreationTokens += result.cacheCreationTokens ?? 0;

    // Needs-user-input short-circuits role-specific processing.
    if (result.needsUserInput) {
      state.needsUserInput = true;
      state.pendingQuestions = [...state.pendingQuestions, ...result.uncertainties];
      state.status = 'awaiting-user';
      ledger.append({
        author: participantId,
        authorRole: role.name,
        type: 'query',
        payload: { questions: result.uncertainties },
      });
      this.markParticipantYielded(state, participantId, result.tokensConsumed);
      return;
    }

    // Accumulate non-blocking uncertainties.
    if (result.uncertainties.length > 0) {
      state.uncertainties.push(...result.uncertainties);
    }

    // Role-specific handling.
    if (role.name === 'critic') {
      this.applyCritic(ledger, blackboard, role, participantId, result);
    } else if (role.name === 'integrator') {
      this.applyIntegrator(state, ledger, blackboard, role, participantId, result);
    } else {
      // Every other named role (drafter-0, drafter-1, ...) is treated as a drafter.
      this.applyDrafter(state, ledger, blackboard, role, participantId, result);
    }

    this.markParticipantYielded(state, participantId, result.tokensConsumed);
  }

  // ── Role-specific applicators ──────────────────────────────────────

  private applyDrafter(
    state: RoomState,
    ledger: RoomLedger,
    blackboard: RoomBlackboard,
    role: RoleSpec,
    participantId: string,
    result: ParticipantResult,
  ): void {
    for (const m of result.mutations) {
      state.stagedMutations.set(m.file, m);
    }
    const indexSuffix = role.name.startsWith('drafter-') ? role.name.slice('drafter-'.length) : '0';
    const key = `draft/${indexSuffix}/mutations`;
    blackboard.write(
      key,
      result.mutations.map((m) => ({ file: m.file, summary: m.explanation ?? '' })),
      role,
    );
    ledger.append({
      author: participantId,
      authorRole: role.name,
      type: 'propose',
      payload: {
        mutationCount: result.mutations.length,
        files: result.mutations.map((m) => m.file),
        blackboardKey: key,
      },
    });
  }

  private applyCritic(
    ledger: RoomLedger,
    blackboard: RoomBlackboard,
    role: RoleSpec,
    participantId: string,
    result: ParticipantResult,
  ): void {
    // Critic's concerns live on its WorkerLoopResult.uncertainties AND (optionally)
    // its proposedContent (natural-language review). Both are captured in the
    // ledger; the blackboard holds the concerns list.
    const concerns = result.uncertainties;
    blackboard.write('critique/concerns', concerns, role);
    if (result.proposedContent) {
      blackboard.write('critique/review', result.proposedContent, role);
    }
    ledger.append({
      author: participantId,
      authorRole: role.name,
      type: concerns.length > 0 ? 'reject' : 'affirm',
      payload: { concerns, review: result.proposedContent ?? null },
    });
    // Defense-in-depth: critic is contract-enforced to have no file_write, but
    // if mutations slip through we DROP them (supervisor never stages them).
  }

  private applyIntegrator(
    state: RoomState,
    ledger: RoomLedger,
    blackboard: RoomBlackboard,
    role: RoleSpec,
    participantId: string,
    result: ParticipantResult,
  ): void {
    for (const m of result.mutations) {
      state.stagedMutations.set(m.file, m);
    }
    blackboard.write(
      'final/mutations',
      result.mutations.map((m) => ({ file: m.file, summary: m.explanation ?? '' })),
      role,
    );
    ledger.append({
      author: participantId,
      authorRole: role.name,
      type: 'claim',
      payload: {
        mutationCount: result.mutations.length,
        files: result.mutations.map((m) => m.file),
      },
    });
  }

  private markParticipantYielded(state: RoomState, participantId: string, tokens: number): void {
    const participant = state.participants.get(participantId);
    if (!participant) return;
    participant.turnsUsed += 1;
    participant.tokensUsed += tokens;
    participant.status = 'yielded';
  }

  /** Advance to the next role slot; when the round is complete, bump the round counter. */
  advanceTurn(state: RoomState): void {
    if (state.status !== 'active') return;
    state.currentRoleIndex += 1;
    if (state.currentRoleIndex >= state.contract.roles.length) {
      state.currentRoleIndex = 0;
      state.rounds += 1;
    }
  }

  /**
   * Pure convergence predicate. Returns `'converged'` only when ALL hold:
   *   - status is `active`
   *   - budget not exhausted
   *   - rounds >= minRounds
   *   - at least one mutation has been staged (integrator must have spoken)
   *   - goal-alignment verifier returns a verdict with `verified=true`
   *   - verdict confidence >= contract.convergenceThreshold
   *
   * Returns `'partial'` when the round cap is reached without convergence or
   * the token budget is exceeded. Returns `'open'` otherwise.
   */
  checkConvergence(state: RoomState, ctx: ConvergenceContext): ConvergenceOutcome {
    if (state.status !== 'active' && state.status !== 'opening') return 'open';
    if (state.tokensConsumed > state.contract.tokenBudget) return 'partial';
    if (state.rounds >= state.contract.maxRounds) return 'partial';
    if (state.rounds < state.contract.minRounds) return 'open';
    if (state.stagedMutations.size === 0) return 'open';

    const hypothesis: HypothesisTuple = {
      target: ctx.targetFiles?.[0] ?? `room:${state.contract.roomId}`,
      pattern: 'room-converge',
      workspace: ctx.workspace,
      context: {
        content: Array.from(state.stagedMutations.values())
          .map((m) => m.content ?? '')
          .join('\n'),
      },
    };
    const response = this.goalVerifier(hypothesis, ctx.understanding, ctx.targetFiles);
    if (isAbstention(response)) return 'open';

    const verdict = response as OracleVerdict;
    if (!verdict.verified) return 'open';
    const confidence = verdict.confidence ?? 0;
    if (confidence < state.contract.convergenceThreshold) return 'open';
    return 'converged';
  }

  // ── Terminal state transitions ─────────────────────────────────────

  markConverged(state: RoomState): void {
    if (state.status === 'active' || state.status === 'opening') {
      state.status = 'converged';
      state.closedAt = this.clock();
    }
  }

  markPartial(state: RoomState, reason: string): void {
    if (state.status === 'active' || state.status === 'opening') {
      state.status = 'partial';
      state.uncertainties.push(reason);
      state.closedAt = this.clock();
    }
  }

  markBudgetExhausted(state: RoomState): void {
    this.markPartial(state, `room budget exhausted after round ${state.rounds}`);
  }

  markViolation(state: RoomState, reason: string): void {
    if (state.status === 'converged' || state.status === 'partial' || state.status === 'failed') {
      return;
    }
    state.status = 'failed';
    state.failureReason = reason;
    state.closedAt = this.clock();
  }

  /** Assemble the room's final result from state + ledger. */
  finalize(state: RoomState, ledger: RoomLedger, durationMs: number): RoomResult {
    return {
      roomId: state.contract.roomId,
      status: state.status,
      rounds: state.rounds,
      mutations: Array.from(state.stagedMutations.values()),
      uncertainties: [...state.uncertainties],
      tokensConsumed: state.tokensConsumed,
      cacheReadTokens: state.cacheReadTokens,
      cacheCreationTokens: state.cacheCreationTokens,
      durationMs,
      needsUserInput: state.needsUserInput,
      pendingQuestions: [...state.pendingQuestions],
      ledger: ledger.readAll(),
      failureReason: state.failureReason,
    };
  }
}
