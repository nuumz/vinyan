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
import {
  type ConvergenceOutcome,
  effectiveRoleClass,
  type RoleClass,
  type RoleSpec,
  type RoomContract,
  type RoomParticipant,
  type RoomResult,
  type RoomState,
} from './types.ts';

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

    // Role-specific handling — dispatched by `effectiveRoleClass` so the
    // text-answer presets (Phase 2) get distinct behaviour without
    // overloading legacy role names. When `roleClass` is omitted, the
    // helper derives the legacy class from the role name so existing
    // mutation-room presets keep working unchanged.
    switch (effectiveRoleClass(role)) {
      case 'mutation-critic':
        this.applyCritic(ledger, blackboard, role, participantId, result);
        break;
      case 'mutation-integrator':
        this.applyIntegrator(state, ledger, blackboard, role, participantId, result);
        break;
      case 'primary-participant':
        this.applyPrimaryParticipant(state, ledger, blackboard, role, participantId, result);
        break;
      case 'oversight':
        this.applyOversight(state, ledger, blackboard, role, participantId, result);
        break;
      case 'integrator':
        this.applyTextIntegrator(state, ledger, blackboard, role, participantId, result);
        break;
      default:
        // 'mutation-drafter' and any future role-class with no special-case
        // handling fall through to the drafter behaviour.
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

  // ── Text-answer applicators (Phase 2 multi-agent debate fix) ───────

  /**
   * Apply a primary-participant turn (text-answer mode). The participant
   * emits `proposedContent` (their answer or rebuttal); we record it to
   * the blackboard keyed by `discussion/${participantId}/round-${state.rounds}`
   * so the dispatcher can render shared discussion context for the next
   * round, and append a `propose` ledger entry that includes the answer
   * length so observability can detect empty/degenerate participants.
   *
   * Crucially this does NOT touch `state.stagedMutations` — text-answer
   * convergence does not gate on mutations and the room result for a
   * text-answer room carries `mutations: []`. The participant's proposed
   * content is the actual deliverable.
   */
  private applyPrimaryParticipant(
    state: RoomState,
    ledger: RoomLedger,
    blackboard: RoomBlackboard,
    role: RoleSpec,
    participantId: string,
    result: ParticipantResult,
  ): void {
    const content = result.proposedContent ?? '';
    const round = state.rounds;
    const key = `discussion/${role.name}/round-${round}`;
    blackboard.write(key, content, role);
    ledger.append({
      author: participantId,
      authorRole: role.name,
      type: 'propose',
      payload: {
        round,
        answerLength: content.length,
        participantId,
        blackboardKey: key,
      },
    });
  }

  /**
   * Apply an oversight turn (text-answer mode). Oversight reviews primary
   * participants' answers but does not produce primary content itself.
   * Concerns + an optional natural-language review are recorded; mutations
   * are dropped (oversight is not a generator).
   */
  private applyOversight(
    state: RoomState,
    ledger: RoomLedger,
    blackboard: RoomBlackboard,
    role: RoleSpec,
    participantId: string,
    result: ParticipantResult,
  ): void {
    const concerns = result.uncertainties;
    const round = state.rounds;
    blackboard.write(`oversight/${role.name}/round-${round}/concerns`, concerns, role);
    if (result.proposedContent) {
      blackboard.write(`oversight/${role.name}/round-${round}/review`, result.proposedContent, role);
    }
    ledger.append({
      author: participantId,
      authorRole: role.name,
      type: concerns.length > 0 ? 'reject' : 'affirm',
      payload: { round, concerns, review: result.proposedContent ?? null, participantId },
    });
  }

  /**
   * Apply a text-answer integrator turn — synthesizes the final answer.
   * Distinct from `applyIntegrator` (mutation mode), which stages
   * `final/mutations`; the text-answer integrator writes `final/answer`
   * and emits a `claim` ledger entry whose payload carries the synthesis
   * length. Mutations on the result are dropped (text rooms do not
   * produce file changes).
   */
  private applyTextIntegrator(
    state: RoomState,
    ledger: RoomLedger,
    blackboard: RoomBlackboard,
    role: RoleSpec,
    participantId: string,
    result: ParticipantResult,
  ): void {
    const answer = result.proposedContent ?? '';
    blackboard.write('final/answer', answer, role);
    ledger.append({
      author: participantId,
      authorRole: role.name,
      type: 'claim',
      payload: {
        round: state.rounds,
        answerLength: answer.length,
        participantId,
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
   * Pure convergence predicate. Branches on `contract.outputMode`:
   *
   * **mutation mode (default, legacy):** Returns `'converged'` only when
   * status is active, budget not exhausted, rounds >= minRounds, at least
   * one mutation has been staged, and the goal-alignment verifier returns
   * a verdict with `verified=true` and `confidence >= convergenceThreshold`.
   *
   * **text-answer mode (Phase 2 multi-agent debate):** Returns `'converged'`
   * when status is active, budget not exhausted, rounds >= minRounds, every
   * primary-participant role has spoken `1 + rebuttalRounds` turns, and
   * (if present) the integrator role has spoken at least once. Mutations
   * are NOT required and the goal-alignment verifier is NOT consulted —
   * the integrator's `final/answer` blackboard entry IS the deliverable.
   *
   * Returns `'partial'` when the round cap is reached without convergence
   * or the token budget is exceeded. Returns `'open'` otherwise.
   */
  checkConvergence(state: RoomState, ctx: ConvergenceContext): ConvergenceOutcome {
    if (state.status !== 'active' && state.status !== 'opening') return 'open';
    if (state.tokensConsumed > state.contract.tokenBudget) return 'partial';
    if (state.rounds < state.contract.minRounds) return 'open';

    if (state.contract.outputMode === 'text-answer') {
      // Text-answer convergence is purely a function of per-role turn
      // counts. We INTENTIONALLY do NOT check `state.rounds >= maxRounds`
      // here: in text-answer mode the dispatcher sets `maxRounds =
      // 1 + rebuttalRounds + (integrator ? 1 : 0)`, so
      // `state.rounds === maxRounds` is the EXPECTED success state, not a
      // partial-failure signal. When turn counts are unmet at that
      // boundary the predicate returns 'open' and the dispatcher's tail
      // code marks the room partial.
      return this.checkConvergenceTextAnswer(state);
    }

    // Mutation mode (legacy): rounds-cap-as-partial is the right signal —
    // the room ran its full budget without producing a converged mutation
    // set, so we report partial.
    if (state.rounds >= state.contract.maxRounds) return 'partial';
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

  /**
   * Text-answer convergence predicate. Pure: derives only from per-role
   * `turnsUsed` accumulated by `markParticipantYielded`. The dispatcher's
   * round-gating logic ensures primaries don't act after their quota and
   * the integrator only acts after primaries are done — but the supervisor
   * does NOT trust that and still requires the explicit turn counts here,
   * so a buggy gate cannot prematurely converge a half-finished room.
   */
  private checkConvergenceTextAnswer(state: RoomState): ConvergenceOutcome {
    const expectedPrimaryTurns = 1 + (state.contract.rebuttalRounds ?? 0);
    let sawIntegrator = false;
    let integratorYielded = false;
    for (const role of state.contract.roles) {
      const cls = effectiveRoleClass(role);
      const participantId = `${state.contract.roomId}::${role.name}`;
      const participant = state.participants.get(participantId);
      if (cls === 'primary-participant') {
        if (!participant || participant.turnsUsed < expectedPrimaryTurns) return 'open';
      } else if (cls === 'integrator') {
        sawIntegrator = true;
        if (participant && participant.turnsUsed >= 1) integratorYielded = true;
      }
      // 'oversight' is informational; convergence does not gate on it.
    }
    if (sawIntegrator && !integratorYielded) return 'open';
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
