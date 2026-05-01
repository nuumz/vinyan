/**
 * Collaboration Runner — Phase 3 of the multi-agent debate fix.
 *
 * Routes prompts that carry a `CollaborationDirective` (parsed by
 * `intent/collaboration-parser.ts`) through a persistent-participant
 * Room (text-answer mode) instead of the flat workflow-executor path.
 *
 * Architecture:
 *   - Builds a `RoomContract` via {@link buildDebateRoomContract}.
 *   - Opens a `RoomSupervisor` + `RoomLedger` + `RoomBlackboard` directly
 *     (we do NOT use `RoomDispatcher` here — its `runAgentLoop` indirection
 *     and fleet-distinct-model resolver are wrong for text-answer Q&A).
 *   - Iterates rounds; per round dispatches each role's turn via
 *     `deps.executeTask` so each participant gets full intent-resolution +
 *     persona-soul loading + observability for its sub-task.
 *   - Records every result back through the supervisor (Phase 2 lift).
 *   - Translates the resulting RoomState into a `WorkflowResult` so
 *     downstream consumers (chat UI, trace recorder, synthesizer cleanup)
 *     stay shape-compatible with the legacy workflow path.
 *
 * Important contracts:
 *   - Sub-task recursion guard: every dispatched sub-task carries
 *     `parentTaskId = input.id`, which `enforceSubTaskLeafStrategy` then
 *     uses to strip the collaboration directive from the sub-task's
 *     intent resolution (see `intent/strategy.ts`). A primary participant
 *     CANNOT recursively re-enter the collaboration runner.
 *   - Honest A1: each role pins `personaId` so the persona's soul loads;
 *     primaries are generator/mixed-class only (never the canonical
 *     reviewer). Distinct-persona admission is enforced by the role list
 *     itself (preset deduplicates).
 *   - Competition verdict path: when the directive carries
 *     `emitCompetitionVerdict`, the runner runs `parseWinnerVerdict` on
 *     the integrator's output and emits `workflow:winner_determined` —
 *     mirrors the existing workflow-executor verdict path.
 */
import type { VinyanBus } from '../../core/bus.ts';
import type { CollaborationDirective } from '../intent/collaboration-parser.ts';
import { RoomBlackboard } from '../room/room-blackboard.ts';
import { RoomLedger } from '../room/room-ledger.ts';
import { type ParticipantResult, RoomSupervisor } from '../room/room-supervisor.ts';
import {
  buildDebateRoomContract,
  DebateRoomBuildFailure,
} from '../room/presets/debate-room.ts';
import {
  effectiveRoleClass,
  type RoleSpec,
  type RoomContract,
  type RoomParticipant,
} from '../room/types.ts';
import type { TaskInput, TaskResult } from '../types.ts';
import {
  parseWinnerVerdict,
  type WinnerVerdict,
} from './stage-manifest.ts';
import type {
  WorkflowResult,
  WorkflowStepResult,
} from './types.ts';

export interface CollaborationRunnerDeps {
  executeTask: (subInput: TaskInput) => Promise<TaskResult>;
  agentRegistry: import('../agents/registry.ts').AgentRegistry;
  bus?: VinyanBus;
  /** Optional clock injection for deterministic tests. */
  clock?: () => number;
  /**
   * Phase 4 — how long the runner waits for a
   * `room:participant_clarification_provided` event before falling back to
   * the input-required degraded path. Defaults to 180_000ms (matches the
   * existing approval-gate default). Tests inject smaller values to keep
   * the suite fast.
   */
  clarificationTimeoutMs?: number;
}

/**
 * Phase 4 default — mirrors `DEFAULT_APPROVAL_TIMEOUT_MS` from
 * `workflow/approval-gate.ts`. Re-declared here to keep this file
 * dependency-light (the runner already imports from `room/`,
 * `intent/`, and `workflow/types|stage-manifest`; pulling
 * approval-gate just for the constant would be churn).
 */
const DEFAULT_CLARIFICATION_TIMEOUT_MS = 180_000;

/**
 * Run the multi-agent collaboration described by `directive` over `input`.
 * Returns a `WorkflowResult` so the caller (core-loop's agentic-workflow
 * branch) can map status/answer through the same path it uses for the
 * legacy workflow-executor.
 *
 * On `DebateRoomBuildFailure` (registry too small for the requested count),
 * the runner returns `WorkflowResult { status: 'failed', synthesizedOutput: <reason> }`
 * — honest failure, never silent collapse to a single persona role-playing
 * N participants.
 */
export async function executeCollaborationRoom(
  input: TaskInput,
  deps: CollaborationRunnerDeps,
  directive: CollaborationDirective,
): Promise<WorkflowResult> {
  const startedAt = performance.now();
  const clock = deps.clock ?? (() => Date.now());

  let bundle: ReturnType<typeof buildDebateRoomContract>;
  try {
    bundle = buildDebateRoomContract({
      parentTaskId: input.id,
      goal: input.goal,
      directive,
      registry: deps.agentRegistry,
    });
  } catch (err) {
    if (err instanceof DebateRoomBuildFailure) {
      const message =
        `Cannot honour ${directive.requestedPrimaryParticipantCount}-agent debate: ` +
        `${err.message}`;
      deps.bus?.emit('workflow:complete', {
        goal: input.goal,
        status: 'failed',
        stepsCompleted: 0,
        totalSteps: 0,
      });
      return {
        status: 'failed',
        stepResults: [],
        synthesizedOutput: message,
        totalTokensConsumed: 0,
        totalDurationMs: Math.round(performance.now() - startedAt),
      };
    }
    throw err;
  }
  const { contract } = bundle;

  const supervisor = new RoomSupervisor({ clock });
  const ledger = new RoomLedger(clock);
  const blackboard = new RoomBlackboard(clock);
  const state = supervisor.open(contract);

  // Admit one participant per role. Each participant's id is derived from
  // the role.name (which IS the persona id in debate-room contracts) so
  // both the supervisor's state and the runner's stepResult mapping can
  // attribute output to the right persona without a separate lookup.
  for (const role of contract.roles) {
    const participant: RoomParticipant = {
      id: `${contract.roomId}::${role.name}`,
      roomId: contract.roomId,
      roleName: role.name,
      workerId: `persona-${role.name}`,
      // workerModelId carries the persona id so distinct-persona admission
      // is enforced for free by the supervisor's existing participants Map.
      workerModelId: role.name,
      turnsUsed: 0,
      tokensUsed: 0,
      status: 'admitted',
      admittedAt: clock(),
    };
    supervisor.admit(state, participant);
  }

  deps.bus?.emit('room:opened', {
    roomId: contract.roomId,
    parentTaskId: input.id,
    roles: contract.roles.map((r) => r.name),
    maxRounds: contract.maxRounds,
  });

  // Phase 5 — UI animation parity with workflow-executor. Emit a synthetic
  // `workflow:plan_ready` so the chat surface seeds its plan checklist
  // BEFORE the first turn dispatches. The synthetic plan lists each
  // (participant, round) pair as its own step so the UI renders honest
  // per-round movement; the integrator adds one final synthesis step.
  // `awaitingApproval=false` because collaboration runs do NOT pass through
  // the workflow approval gate (the directive itself is the user's prior
  // consent — they explicitly asked for N agents).
  deps.bus?.emit('workflow:plan_ready', {
    taskId: input.id,
    goal: contract.goal,
    steps: buildSyntheticPlanSteps(contract),
    awaitingApproval: false,
  });

  // Per-step result accumulator — translated into a WorkflowResult at the end.
  const stepResults: WorkflowStepResult[] = [];
  // Per-participant turn record so we can emit one stepResult per (participant,
  // round) pair without re-querying the ledger downstream.
  const turnRecords: Array<{
    role: RoleSpec;
    round: number;
    output: string;
    tokensConsumed: number;
    durationMs: number;
    status: 'completed' | 'failed';
  }> = [];

  // Phase 4 — populated when the runner asked the user for clarification
  // and the in-process wait timed out. Surfaced via WorkflowResult so the
  // caller can map to TaskResult.status='input-required'.
  let pendingClarification: WorkflowResult['clarificationNeeded'] | undefined;

  // ── Round loop ──────────────────────────────────────────────────────
  outer: for (let round = 0; round < contract.maxRounds; round++) {
    for (const role of contract.roles) {
      if (!shouldRoleActThisRound(role, round, contract)) continue;

      const participantId = `${contract.roomId}::${role.name}`;
      const roomContext = buildRoomContextText(blackboard, role, round, contract);
      const subTaskGoal = composeSubTaskGoal(role, contract.goal, roomContext);
      const subInput: TaskInput = {
        ...input,
        id: `${input.id}__collab__${role.name}__r${round}`,
        goal: subTaskGoal,
        // Pin the persona for this turn (preset always sets personaId for
        // debate-room roles; fall back to role.name when absent). Without
        // this the sub-task inherits input.agentId (typically coordinator)
        // and the user sees one persona answering N times.
        ...(role.personaId ? { agentId: role.personaId } : {}),
        // Force parentTaskId so `enforceSubTaskLeafStrategy` strips the
        // collaboration directive from the sub-task's IntentResolution.
        // Without this, a primary participant's sub-task could
        // recursively re-enter the runner.
        parentTaskId: input.id,
      };

      const stepId = syntheticStepId(role.name, round);
      // Phase 5 — UI animation: bracket each turn with `delegate_dispatched`
      // / `delegate_completed` events so the chat surface shows the agent
      // card flip from running → done in real time. Mirrors the
      // workflow-executor's bracketing for consistent UI behaviour.
      deps.bus?.emit('workflow:delegate_dispatched', {
        taskId: input.id,
        stepId,
        agentId: role.personaId ?? null,
        subTaskId: subInput.id,
        stepDescription: describeTurn(role, round, contract),
      });

      const turnStart = performance.now();
      let taskResult: TaskResult;
      try {
        taskResult = await deps.executeTask(subInput);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const durationMs = Math.round(performance.now() - turnStart);
        turnRecords.push({
          role,
          round,
          output: `Sub-task failed: ${errMsg}`,
          tokensConsumed: 0,
          durationMs,
          status: 'failed',
        });
        deps.bus?.emit('workflow:delegate_completed', {
          taskId: input.id,
          stepId,
          subTaskId: subInput.id,
          agentId: role.personaId ?? null,
          status: 'failed',
          outputPreview: `Sub-task failed: ${errMsg}`.slice(0, 240),
          tokensUsed: 0,
        });
        continue;
      }

      // Phase 4 — per-participant clarification bubble-up.
      //
      // When a primary participant's sub-task returns
      // `status='input-required'` AND the directive permits manager
      // clarification AND the bus is wired AND the role is a primary
      // participant (oversight/integrator do not bubble up clarification),
      // pause the loop, surface the questions via the bus, and wait for
      // a `room:participant_clarification_provided` event with the matching
      // taskId + participantId.
      //
      // On answer: the SAME participant resumes its SAME round — the
      // sub-task is re-dispatched with the question(s) + answer threaded
      // into the goal, the answer is also recorded on the blackboard
      // under `clarification/<role>/round-<n>` for replay fidelity. No
      // new participant identity is created; the role's `participantId`
      // stays stable.
      //
      // On timeout: store `pendingClarification` and break out of the
      // round loop — the caller (core-loop's agentic-workflow branch)
      // maps this to `TaskResult.status='input-required'` so the next
      // user turn can answer.
      if (
        taskResult.status === 'input-required' &&
        directive.managerClarificationAllowed &&
        effectiveRoleClass(role) === 'primary-participant' &&
        deps.bus
      ) {
        const questions = (taskResult.clarificationNeeded ?? []).filter((q) => q.trim().length > 0);
        if (questions.length > 0) {
          const timeoutMs = deps.clarificationTimeoutMs ?? DEFAULT_CLARIFICATION_TIMEOUT_MS;
          deps.bus.emit('room:participant_clarification_needed', {
            taskId: input.id,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            roomId: contract.roomId,
            participantId,
            participantRole: role.name,
            round,
            questions,
            timeoutMs,
          });
          const clarificationAnswer = await awaitClarificationAnswer(
            deps.bus,
            input.id,
            participantId,
            timeoutMs,
          );
          if (clarificationAnswer === null) {
            // Timeout — surface as pending clarification. The next user
            // turn will arrive with the answer in the new prompt and
            // start a fresh collaboration room (which inherits session
            // context via Vinyan's normal turn-history plumbing).
            pendingClarification = {
              participantId,
              participantRole: role.name,
              round,
              questions,
            };
            break outer;
          }
          // Got the answer — record on blackboard and re-dispatch SAME
          // participant in SAME round with the answer threaded into the goal.
          blackboard.write(`clarification/${role.name}/round-${round}`, clarificationAnswer, role);
          const resumedSubInput: TaskInput = {
            ...subInput,
            id: `${subInput.id}__resumed`,
            goal: composeResumedGoal(subInput.goal, questions, clarificationAnswer),
          };
          try {
            taskResult = await deps.executeTask(resumedSubInput);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const durationMs = Math.round(performance.now() - turnStart);
            turnRecords.push({
              role,
              round,
              output: `Resume after clarification failed: ${errMsg}`,
              tokensConsumed: 0,
              durationMs,
              status: 'failed',
            });
            // UI animation honesty: the resumed turn errored. Emit completion
            // so the chat surface flips the running card to failed instead
            // of leaving it pending forever.
            deps.bus?.emit('workflow:delegate_completed', {
              taskId: input.id,
              stepId,
              subTaskId: resumedSubInput.id,
              agentId: role.personaId ?? null,
              status: 'failed',
              outputPreview: `Resume failed: ${errMsg}`.slice(0, 240),
              tokensUsed: 0,
            });
            continue;
          }
          // Fall through with the resumed `taskResult` as if the
          // participant had answered cleanly the first time.
        }
      }

      const durationMs = Math.round(performance.now() - turnStart);
      const answer = taskResult.answer ?? '';
      const tokensConsumed = taskResult.trace?.tokensConsumed ?? 0;
      const stepStatus: WorkflowStepResult['status'] =
        taskResult.status === 'completed' && answer.trim().length > 0 ? 'completed' : 'failed';

      const participantResult: ParticipantResult = {
        mutations: [],
        uncertainties: [],
        tokensConsumed,
        needsUserInput: taskResult.status === 'input-required',
        proposedContent: answer,
        durationMs,
      };

      // Mirror state.rounds with the runner's round counter so the
      // supervisor's per-round blackboard keys (`discussion/<role>/round-<n>`)
      // line up with what `buildRoomContextText` reads on subsequent turns.
      state.rounds = round;
      supervisor.recordResult(state, ledger, blackboard, role, participantId, participantResult);

      turnRecords.push({
        role,
        round,
        output: answer,
        tokensConsumed,
        durationMs,
        status: stepStatus,
      });

      // Phase 5 — UI animation: emit per-turn completion with a bounded
      // preview. The PREVIEW_CAP mirrors the workflow-executor's cap so
      // chat-surface preview rendering stays consistent across the two
      // execution paths.
      const PREVIEW_CAP = 2000;
      const outputPreview =
        answer.length <= PREVIEW_CAP
          ? answer
          : (() => {
              const slice = answer.slice(0, PREVIEW_CAP);
              const lastSpace = slice.lastIndexOf(' ');
              const lastNewline = slice.lastIndexOf('\n');
              const cut = Math.max(lastSpace, lastNewline);
              return cut > PREVIEW_CAP * 0.8 ? `${slice.slice(0, cut)}…` : `${slice}…`;
            })();
      deps.bus?.emit('workflow:delegate_completed', {
        taskId: input.id,
        stepId,
        subTaskId: subInput.id,
        agentId: role.personaId ?? null,
        status: stepStatus,
        outputPreview,
        tokensUsed: tokensConsumed,
      });

      // Awaiting-user bubble-up — the supervisor flipped status when
      // `needsUserInput` arrived. Phase 4 will turn this into an
      // honest WorkflowResult { status: 'partial', clarificationNeeded }.
      // For Phase 3 we treat it as a partial close and stop the loop.
      if (state.status === 'awaiting-user') break outer;

      if (state.tokensConsumed > contract.tokenBudget) {
        supervisor.markBudgetExhausted(state);
        break outer;
      }
    }

    // The supervisor's round counter is bumped here so checkConvergence
    // sees the right state.rounds value.
    state.rounds = round + 1;
    const outcome = supervisor.checkConvergence(state, { workspace: '' });
    if (outcome === 'converged') {
      supervisor.markConverged(state);
      break;
    }
    if (outcome === 'partial') {
      supervisor.markPartial(state, `convergence not reached after round ${round + 1}`);
      break;
    }
  }
  // Loop exit safety: if neither convergence nor failure transitioned the
  // FSM out of `active`, mark partial so we never return an active state.
  if (state.status === 'active' || state.status === 'opening') {
    supervisor.markPartial(state, 'collaboration loop ended without convergence');
  }

  // ── Translate to WorkflowResult ─────────────────────────────────────
  for (const turn of turnRecords) {
    const cls = effectiveRoleClass(turn.role);
    const stepStrategy = cls === 'integrator' ? 'llm-reasoning' : 'delegate-sub-agent';
    const personaId = turn.role.personaId;
    stepResults.push({
      stepId: `p-${turn.role.name}-r${turn.round}`,
      status: turn.status,
      output: turn.output,
      tokensConsumed: turn.tokensConsumed,
      durationMs: turn.durationMs,
      strategyUsed: stepStrategy,
      ...(personaId ? { agentId: personaId } : {}),
    });
  }

  const totalTokens = turnRecords.reduce((acc, t) => acc + t.tokensConsumed, 0);
  const totalDurationMs = Math.round(performance.now() - startedAt);

  // Final answer: integrator's output (preserving competition verdict
  // cleanup) when present; deterministic concat of last-round primary
  // answers otherwise.
  const synthesizedOutput = buildSynthesizedOutput(
    bundle,
    blackboard,
    turnRecords,
    directive,
    deps.bus,
    input,
  );

  // Phase 4 — when an in-process clarification wait timed out, the room
  // is paused on the user. Status is `partial` (not `failed`): we may have
  // collected some answers from earlier participants in the same round,
  // and they are honestly preserved in stepResults. The caller maps the
  // presence of `clarificationNeeded` to TaskResult.input-required so the
  // next user turn can answer.
  const status: WorkflowResult['status'] = pendingClarification
    ? 'partial'
    : state.status === 'converged'
      ? 'completed'
      : turnRecords.some((t) => t.status === 'completed')
        ? 'partial'
        : 'failed';

  deps.bus?.emit('workflow:complete', {
    goal: input.goal,
    status,
    stepsCompleted: stepResults.filter((s) => s.status === 'completed').length,
    totalSteps: stepResults.length,
  });

  return {
    status,
    stepResults,
    synthesizedOutput,
    totalTokensConsumed: totalTokens,
    totalDurationMs,
    ...(pendingClarification ? { clarificationNeeded: pendingClarification } : {}),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Synthetic step id used in `workflow:plan_ready` / `workflow:delegate_*`
 * events. Stable across the room's lifetime so a UI consumer that keys
 * by stepId can correlate dispatched/completed pairs deterministically.
 */
function syntheticStepId(roleName: string, round: number): string {
  return `p-${roleName}-r${round}`;
}

/**
 * Human-readable description of a turn for UI surfaces. Includes the
 * round counter so the user can see "developer · round 2 of 3" rather
 * than just "developer answers".
 */
function describeTurn(role: RoleSpec, round: number, contract: RoomContract): string {
  const cls = effectiveRoleClass(role);
  const totalPrimaryRounds = 1 + (contract.rebuttalRounds ?? 0);
  if (cls === 'integrator') return `${role.name} synthesizes the final answer`;
  if (cls === 'oversight') return `${role.name} reviews · round ${round + 1} of ${totalPrimaryRounds}`;
  return `${role.name} · round ${round + 1} of ${totalPrimaryRounds}`;
}

/**
 * Build the synthetic plan-step list for `workflow:plan_ready`. Each
 * (primary, round) pair becomes one step; the integrator (when present)
 * adds a final synthesis step that depends on every primary's last round.
 *
 * The shape mirrors the workflow-executor's `stepsForEvent` so the chat
 * UI can render the plan checklist with no UI-side changes — collaboration
 * runs animate the same way single-shot workflow runs do today.
 */
function buildSyntheticPlanSteps(
  contract: RoomContract,
): Array<{ id: string; description: string; strategy: string; dependencies: string[] }> {
  const steps: Array<{ id: string; description: string; strategy: string; dependencies: string[] }> = [];
  const primaryRoles = contract.roles.filter((r) => effectiveRoleClass(r) === 'primary-participant');
  const integratorRole = contract.roles.find((r) => effectiveRoleClass(r) === 'integrator');
  const totalPrimaryRounds = 1 + (contract.rebuttalRounds ?? 0);

  for (let round = 0; round < totalPrimaryRounds; round++) {
    for (const role of primaryRoles) {
      const id = syntheticStepId(role.name, round);
      // Each rebuttal round depends on every primary's prior round —
      // the dispatcher gate enforces this serially anyway, but surfacing
      // the dependency in the UI plan reflects the actual execution shape.
      const dependencies =
        round === 0 ? [] : primaryRoles.map((peer) => syntheticStepId(peer.name, round - 1));
      steps.push({
        id,
        description: describeTurn(role, round, contract),
        strategy: 'delegate-sub-agent',
        dependencies,
      });
    }
  }
  if (integratorRole) {
    const integratorRound = contract.maxRounds - 1;
    const id = syntheticStepId(integratorRole.name, integratorRound);
    steps.push({
      id,
      description: describeTurn(integratorRole, integratorRound, contract),
      strategy: 'llm-reasoning',
      // Integrator depends on every primary's LAST round.
      dependencies: primaryRoles.map((p) => syntheticStepId(p.name, totalPrimaryRounds - 1)),
    });
  }
  return steps;
}

/**
 * Per-round role gate — local copy of the dispatcher's predicate.
 * Mirrors `room-dispatcher.ts:shouldRoleActThisRound` exactly so the
 * runner's loop and any future text-answer dispatcher caller produce
 * the same dispatch order.
 */
function shouldRoleActThisRound(role: RoleSpec, round: number, contract: RoomContract): boolean {
  if (contract.outputMode !== 'text-answer') return true;
  const cls = effectiveRoleClass(role);
  const primaryRoundsRequired = 1 + (contract.rebuttalRounds ?? 0);
  if (cls === 'integrator') return round === contract.maxRounds - 1;
  if (cls === 'primary-participant' || cls === 'oversight') {
    return round < primaryRoundsRequired;
  }
  return true;
}

/**
 * Compose the sub-task goal for a participant turn. Primary participants
 * see the goal verbatim (no "[Room role: …]" framing); oversight and
 * integrator carry the role framing so they understand their distinct job.
 * Room context (peer transcripts) is injected via a dedicated section so
 * the LLM can structurally separate it from the goal.
 */
function composeSubTaskGoal(role: RoleSpec, goal: string, roomContext: string | null): string {
  const cls = effectiveRoleClass(role);
  if (cls === 'primary-participant') {
    if (roomContext) {
      return `${goal}\n\n${roomContext}`;
    }
    return goal;
  }
  // Oversight / integrator framing.
  const framing = `[${role.name}] ${role.responsibility}\n\nUnderlying goal: ${goal}`;
  return roomContext ? `${framing}\n\n${roomContext}` : framing;
}

/**
 * Build the shared discussion transcript a participant sees on rebuttal
 * rounds (or the integrator sees on the synthesis round). Mirrors the
 * dispatcher's `buildTextAnswerRoomContext` so both surfaces produce the
 * same shape — keeping the dispatcher path useful for future direct
 * callers that don't go through this runner.
 */
function buildRoomContextText(
  blackboard: RoomBlackboard,
  currentRole: RoleSpec,
  round: number,
  contract: RoomContract,
): string | null {
  if (round === 0) return null;
  const cls = effectiveRoleClass(currentRole);
  const isIntegrator = cls === 'integrator';
  const lines: string[] = ['## Shared Discussion (prior rounds)'];
  const totalPrimaryRounds = 1 + (contract.rebuttalRounds ?? 0);
  if (isIntegrator) {
    lines.push(
      `You are the **integrator**. Synthesize a single coherent answer from the ` +
        `primary participants' transcripts below. The user's original goal is in your ` +
        `task description; here is what each primary participant said across their ` +
        `${totalPrimaryRounds} round(s).`,
    );
  } else {
    lines.push(
      `You are **${currentRole.name}** in round ${round + 1} of ${totalPrimaryRounds}. ` +
        `Below are answers from the OTHER primary participants in prior rounds. ` +
        `Use them to refine, rebut, or strengthen your own answer — do NOT simply ` +
        `re-state your prior turn.`,
    );
  }
  lines.push('');

  const allEntries = Array.from(blackboard.readAll().entries());
  const primaryNames = contract.roles
    .filter((r) => effectiveRoleClass(r) === 'primary-participant')
    .map((r) => r.name);

  let renderedAny = false;
  for (const peerName of primaryNames) {
    if (!isIntegrator && peerName === currentRole.name) continue;
    const peerEntries = allEntries
      .filter(([k]) => k.startsWith(`discussion/${peerName}/round-`))
      .sort(([a], [b]) => a.localeCompare(b));
    if (peerEntries.length === 0) continue;
    lines.push(`### ${peerName}`);
    for (const [key, entry] of peerEntries) {
      const roundLabel = key.replace(`discussion/${peerName}/round-`, 'round ');
      const value = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
      const capped = value.length > 1200 ? `${value.slice(0, 1200)}…[truncated]` : value;
      lines.push(`**${roundLabel}**:\n${capped}`);
      lines.push('');
      renderedAny = true;
    }
  }
  return renderedAny ? lines.join('\n') : null;
}

/**
 * Build the final synthesized output. When the contract has an integrator
 * AND its turn produced a non-empty answer, we use the integrator's
 * content directly — applying the competition-verdict cleanup (parse
 * verdict, emit event, strip the JSON block) when the directive asked
 * for one. When no integrator, fall back to a deterministic concat of
 * each primary's last-round answer so the user always sees real
 * participant content rather than a fabricated synthesis.
 */
function buildSynthesizedOutput(
  bundle: ReturnType<typeof buildDebateRoomContract>,
  blackboard: RoomBlackboard,
  turnRecords: Array<{ role: RoleSpec; round: number; output: string; status: string }>,
  directive: CollaborationDirective,
  bus: VinyanBus | undefined,
  input: TaskInput,
): string {
  // Integrator path
  if (bundle.integratorParticipantId) {
    const finalAnswer = blackboard.read('final/answer');
    if (finalAnswer && typeof finalAnswer.value === 'string' && finalAnswer.value.trim().length > 0) {
      const raw = finalAnswer.value;
      if (directive.emitCompetitionVerdict) {
        return processCompetitionVerdictAndStrip(raw, bundle.primaryParticipantIds, bus, input);
      }
      return raw;
    }
  }

  // Fallback: deterministic concat of primary participants' last-round answers.
  const lastRoundByPersona = new Map<string, string>();
  for (const t of turnRecords) {
    const cls = effectiveRoleClass(t.role);
    if (cls !== 'primary-participant') continue;
    if (t.status !== 'completed') continue;
    // Last write wins — turnRecords iterate in dispatch order, so a later
    // round overwrites an earlier one for the same persona.
    lastRoundByPersona.set(t.role.name, t.output);
  }
  if (lastRoundByPersona.size === 0) {
    return 'The collaboration room produced no participant answers — every participant turn failed.';
  }
  const sections = Array.from(lastRoundByPersona.entries())
    .map(([name, output]) => `### ${name}\n${output}`)
    .join('\n\n');
  return `## Multi-agent answers (no integrator synthesis configured)\n\n${sections}`;
}

/**
 * Phase 4 — wait for the UI / API client to respond to a prior
 * `room:participant_clarification_needed` event. Resolves with the
 * answer string when a matching `room:participant_clarification_provided`
 * event arrives within the timeout, or `null` on timeout.
 *
 * The handler scopes by `taskId` AND `participantId` so a sibling
 * participant in the same room cannot accidentally consume another
 * participant's answer. Subscribe BEFORE the caller emits the request
 * (the runner emits the `_needed` event AFTER calling this); a fast
 * client cannot race the emit because the listener is armed first.
 */
async function awaitClarificationAnswer(
  bus: VinyanBus,
  taskId: string,
  participantId: string,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const settle = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      resolve(v);
    };
    const timer = setTimeout(() => settle(null), timeoutMs);
    const unsub = bus.on('room:participant_clarification_provided', (payload) => {
      if (payload.taskId !== taskId) return;
      if (payload.participantId !== participantId) return;
      settle(typeof payload.answer === 'string' ? payload.answer : '');
    });
  });
}

/**
 * Compose the resumed sub-task goal — threads the user's clarification
 * answer back into the same participant's prompt so it can complete its
 * substantive turn. Format is structured so the LLM can distinguish the
 * original goal, the question it asked, and the answer it received.
 */
function composeResumedGoal(originalGoal: string, questions: string[], answer: string): string {
  const questionsBlock =
    questions.length === 1
      ? `You earlier asked: "${questions[0]}"`
      : `You earlier asked the following clarifying questions:\n${questions.map((q, i) => `  ${i + 1}. ${q}`).join('\n')}`;
  return [
    originalGoal,
    '',
    '## Clarification (resume)',
    questionsBlock,
    '',
    `The user answered: ${answer}`,
    '',
    "Now produce your substantive answer using the user's clarification. Do NOT ask the same question again.",
  ].join('\n');
}

/**
 * Apply the competition-verdict pipeline to the integrator's raw output:
 *   1. Parse the trailing fenced ```json block via `parseWinnerVerdict`.
 *   2. When valid, emit `workflow:winner_determined` with the verdict
 *      payload (mirrors workflow-executor's behaviour).
 *   3. Strip the JSON block from the user-facing answer so the verdict
 *      reasoning is not duplicated (free-text + JSON had the same content).
 * No-op when the block is absent or the verdict is malformed.
 */
function processCompetitionVerdictAndStrip(
  rawOutput: string,
  participatingPersonaIds: ReadonlyArray<string>,
  bus: VinyanBus | undefined,
  input: TaskInput,
): string {
  const verdict: WinnerVerdict | undefined = parseWinnerVerdict(rawOutput, participatingPersonaIds);
  if (!verdict) return rawOutput;
  bus?.emit('workflow:winner_determined', {
    taskId: input.id,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    winnerAgentId: verdict.winner,
    ...(verdict.runnerUp !== undefined ? { runnerUpAgentId: verdict.runnerUp } : {}),
    reasoning: verdict.reasoning,
    ...(verdict.scores ? { scores: verdict.scores } : {}),
  });
  return rawOutput.replace(/```json\s*[\s\S]*?\s*```\s*$/i, '').trimEnd();
}
