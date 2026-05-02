/**
 * Workflow-native collaboration block executor.
 *
 * Runs the rebuttal-aware rounds loop for a `WorkflowPlan` whose
 * `collaborationBlock` is set. Replaces the old `collaboration-runner` fork
 * in the core loop — the workflow planner now expresses multi-agent
 * collaboration as plan metadata, the executor invokes this helper before
 * its topological dispatch, and the integrator (when present) is then
 * dispatched through the same delegate / llm-reasoning code paths every
 * other workflow step uses.
 *
 * Cardinality contract. The plan keeps **one step per primary participant**
 * (NOT one per (participant, round) pair). The rounds loop is internal —
 * UI surfaces see one card per agent that animates across rounds. Step ids
 * remain stable across rounds; the synthetic SUB-task id (`...-r{round}`)
 * carries the per-round identity for ledger/replay fidelity.
 *
 * Honesty guarantees preserved:
 *   - All-failed primaries → `WorkflowStepResult.status='failed'`; no
 *     fabricated synthesis. The integrator (if any) sees real participant
 *     outputs only — never an LLM-generated stand-in.
 *   - Persona pinning is enforced by `subInput.agentId` (planner-assigned
 *     in `buildCollaborationPlan`); `parentTaskId` triggers
 *     `enforceSubTaskLeafStrategy` so a primary cannot recursively re-enter
 *     this block.
 */
import type { VinyanBus } from '../../core/bus.ts';
import type { TaskInput, TaskResult } from '../types.ts';
import type {
  CollaborationBlock,
  WorkflowPlan,
  WorkflowStep,
  WorkflowStepResult,
} from './types.ts';

export interface CollaborationBlockDeps {
  executeTask: (input: TaskInput) => Promise<TaskResult>;
  bus?: VinyanBus;
  clock?: () => number;
}

export interface CollaborationBlockResult {
  /** Per primary stepId → final WorkflowStepResult (last round's output, or `failed` if every round threw). */
  stepResults: Map<string, WorkflowStepResult>;
  /** Sum of token consumption across all rounds × primaries. */
  totalTokensConsumed: number;
}

/**
 * Run the collaboration block. The caller (workflow-executor) is
 * responsible for:
 *   - merging the returned `stepResults` into its own `stepResults` map,
 *   - marking the primary stepIds as `succeeded` / `finished`,
 *   - removing them from the topological `remaining` set so the integrator
 *     (when present) dispatches via the normal delegate path with the
 *     primaries' outputs available as `inputs` substitution targets.
 */
export async function runCollaborationBlock(
  plan: WorkflowPlan,
  block: CollaborationBlock,
  parentInput: TaskInput,
  deps: CollaborationBlockDeps,
): Promise<CollaborationBlockResult> {
  const clock = deps.clock ?? (() => Date.now());
  const stepById = new Map(plan.steps.map((s) => [s.id, s]));
  const primarySteps: WorkflowStep[] = block.primaryStepIds
    .map((id) => stepById.get(id))
    .filter((s): s is WorkflowStep => s !== undefined && s.strategy === 'delegate-sub-agent');

  if (primarySteps.length === 0) {
    return { stepResults: new Map(), totalTokensConsumed: 0 };
  }

  // Per-(stepId, round) outputs. `roundOutputs.get(stepId)[r]` is the
  // primary's answer for round r. Used to build prior-round transcripts
  // for subsequent rounds (cross-step) AND to compute the final
  // WorkflowStepResult after all rounds settle.
  const roundOutputs = new Map<string, string[]>();
  // Per-(stepId, round) status — failed rounds carry an error message
  // verbatim into the transcript so peers can choose to ignore that
  // participant's failed turn. Cumulative round tokens per step roll up
  // into the final WorkflowStepResult.
  const roundStatuses = new Map<string, Array<'completed' | 'failed'>>();
  const roundTokens = new Map<string, number[]>();
  const startedAtByStep = new Map<string, number>();
  for (const step of primarySteps) {
    roundOutputs.set(step.id, []);
    roundStatuses.set(step.id, []);
    roundTokens.set(step.id, []);
  }

  // Phase A: emit `workflow:delegate_dispatched` ONCE per primary on round 0
  // so the chat UI flips every participant card to running simultaneously.
  // Mirrors the legacy collaboration-runner's behaviour — one card per
  // participant that animates running → done across all rebuttal rounds,
  // not 1 card per (participant, round).
  for (const step of primarySteps) {
    const subTaskIdRound0 = subTaskId(parentInput.id, step.id, 0);
    startedAtByStep.set(step.id, clock());
    deps.bus?.emit('workflow:delegate_dispatched', {
      taskId: parentInput.id,
      stepId: step.id,
      agentId: step.agentId ?? null,
      subTaskId: subTaskIdRound0,
      stepDescription: describePrimary(step, block.rounds),
    });
  }

  // Phase B: rounds loop.
  // Within a single round all primaries dispatch CONCURRENTLY — independent
  // parallel work matches the user's "แข่งกัน" / "debate" / "compete"
  // intent. `Promise.allSettled` so one participant's failure does not
  // poison the rest of the batch.
  for (let round = 0; round < block.rounds; round++) {
    const dispatchTargets = primarySteps.map((step) => {
      const transcript = round === 0
        ? null
        : block.sharedDiscussion
          ? buildSharedDiscussionContext(step, primarySteps, roundOutputs, roundStatuses, round, block)
          : null;
      const augmentedGoal = composePrimaryGoal(step, parentInput.goal, transcript, round, block);
      const subInput: TaskInput = {
        ...parentInput,
        id: subTaskId(parentInput.id, step.id, round),
        goal: augmentedGoal,
        ...(step.agentId ? { agentId: step.agentId } : {}),
        parentTaskId: parentInput.id,
        budget: deriveSubBudget(parentInput, step, block),
      };
      return { step, subInput };
    });

    const settled = await Promise.allSettled(
      dispatchTargets.map((t) => deps.executeTask(t.subInput)),
    );

    for (let i = 0; i < dispatchTargets.length; i++) {
      const { step } = dispatchTargets[i]!;
      const settledI = settled[i]!;
      if (settledI.status === 'rejected') {
        const errMsg = settledI.reason instanceof Error
          ? settledI.reason.message
          : String(settledI.reason);
        roundOutputs.get(step.id)!.push(`[round ${round + 1} failed: ${errMsg}]`);
        roundStatuses.get(step.id)!.push('failed');
        roundTokens.get(step.id)!.push(0);
        continue;
      }
      const result = settledI.value;
      const answer = typeof result.answer === 'string' ? result.answer : '';
      const tokens =
        typeof result.trace?.tokensConsumed === 'number'
          ? result.trace.tokensConsumed
          : 0;
      const status: 'completed' | 'failed' =
        result.status === 'completed' || result.status === 'partial' ? 'completed' : 'failed';
      roundOutputs.get(step.id)!.push(answer);
      roundStatuses.get(step.id)!.push(status);
      roundTokens.get(step.id)!.push(tokens);
    }
  }

  // Phase C: roll up rounds → per-step result. Keep the LAST successful
  // round's answer; if every round failed, the result is `failed` with the
  // most recent error message as output. The synthesizer (integrator)
  // sees only completed primaries' outputs — failed primaries carry a
  // short error tag instead of a fabricated answer.
  const stepResults = new Map<string, WorkflowStepResult>();
  let totalTokensConsumed = 0;
  for (const step of primarySteps) {
    const outputs = roundOutputs.get(step.id) ?? [];
    const statuses = roundStatuses.get(step.id) ?? [];
    const tokens = roundTokens.get(step.id) ?? [];
    const stepTokens = tokens.reduce((a, b) => a + b, 0);
    totalTokensConsumed += stepTokens;
    const startedAt = startedAtByStep.get(step.id) ?? clock();
    const durationMs = Math.max(0, clock() - startedAt);

    let lastSuccessIdx = -1;
    for (let i = statuses.length - 1; i >= 0; i--) {
      if (statuses[i] === 'completed') {
        lastSuccessIdx = i;
        break;
      }
    }
    const finalOutput =
      lastSuccessIdx >= 0
        ? outputs[lastSuccessIdx]!
        : (outputs[outputs.length - 1] ?? '[every round failed]');
    const overallStatus: 'completed' | 'failed' = lastSuccessIdx >= 0 ? 'completed' : 'failed';

    const result: WorkflowStepResult = {
      stepId: step.id,
      status: overallStatus,
      output: finalOutput,
      tokensConsumed: stepTokens,
      durationMs,
      strategyUsed: 'delegate-sub-agent',
      ...(step.agentId && overallStatus === 'completed' ? { agentId: step.agentId } : {}),
      subTaskId: subTaskId(parentInput.id, step.id, block.rounds - 1),
    };
    stepResults.set(step.id, result);

    // Emit terminal events tied to PARENT's taskId. UI cards animate
    // running → done off these.
    deps.bus?.emit('workflow:delegate_completed', {
      taskId: parentInput.id,
      stepId: step.id,
      subTaskId: subTaskId(parentInput.id, step.id, block.rounds - 1),
      agentId: step.agentId ?? null,
      status: overallStatus,
      outputPreview: finalOutput.slice(0, 2000),
      tokensUsed: stepTokens,
    });
    deps.bus?.emit('workflow:step_complete', {
      taskId: parentInput.id,
      ...(parentInput.sessionId ? { sessionId: parentInput.sessionId } : {}),
      stepId: step.id,
      strategy: 'delegate-sub-agent',
      status: overallStatus,
      durationMs,
      tokensConsumed: stepTokens,
    });
  }

  return { stepResults, totalTokensConsumed };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function subTaskId(parentTaskId: string, stepId: string, round: number): string {
  return `${parentTaskId}-delegate-${stepId}-r${round}`;
}

function describePrimary(step: WorkflowStep, totalRounds: number): string {
  const personaLabel = step.agentId ?? step.id;
  return totalRounds > 1
    ? `${personaLabel} · ${totalRounds} rounds`
    : `${personaLabel} answers`;
}

/**
 * Compose the primary participant's per-round sub-task goal.
 *
 *   Round 0: original user goal verbatim.
 *   Round N>0 (sharedDiscussion=true): goal + "## Shared Discussion (prior rounds)"
 *     block built from peer outputs.
 *   Round N>0 (sharedDiscussion=false): goal + "## Round N of M" header so
 *     the participant knows the round count even without shared transcripts.
 */
function composePrimaryGoal(
  step: WorkflowStep,
  parentGoal: string,
  transcript: string | null,
  round: number,
  block: CollaborationBlock,
): string {
  const personaLabel = step.agentId ?? step.id;
  const baseGoal = parentGoal;
  if (round === 0) {
    return baseGoal;
  }
  if (transcript) {
    return `${baseGoal}\n\n${transcript}`;
  }
  return `${baseGoal}\n\n## Round ${round + 1} of ${block.rounds}\nYou are **${personaLabel}**. Refine, deepen, or strengthen your prior answer — do NOT simply repeat your previous turn.`;
}

/**
 * Build the "Shared Discussion (prior rounds)" block a primary sees on
 * rebuttal rounds. Mirrors the legacy `collaboration-runner.buildRoomContextText`
 * but reads from the in-memory roundOutputs map instead of a blackboard.
 */
function buildSharedDiscussionContext(
  currentStep: WorkflowStep,
  primarySteps: WorkflowStep[],
  roundOutputs: Map<string, string[]>,
  roundStatuses: Map<string, Array<'completed' | 'failed'>>,
  round: number,
  block: CollaborationBlock,
): string | null {
  const lines: string[] = ['## Shared Discussion (prior rounds)'];
  const personaLabel = currentStep.agentId ?? currentStep.id;
  lines.push(
    `You are **${personaLabel}** in round ${round + 1} of ${block.rounds}. ` +
      `Below are answers from the OTHER primary participants in prior rounds. ` +
      `Use them to refine, rebut, or strengthen your own answer — do NOT simply ` +
      `re-state your prior turn.`,
  );
  lines.push('');

  let renderedAny = false;
  for (const peerStep of primarySteps) {
    if (peerStep.id === currentStep.id) continue;
    const peerLabel = peerStep.agentId ?? peerStep.id;
    const peerOutputs = roundOutputs.get(peerStep.id) ?? [];
    const peerStatuses = roundStatuses.get(peerStep.id) ?? [];
    if (peerOutputs.length === 0) continue;

    let renderedPeerHeader = false;
    for (let r = 0; r < peerOutputs.length; r++) {
      const status = peerStatuses[r];
      const value = peerOutputs[r] ?? '';
      if (!value || status !== 'completed') continue;
      if (!renderedPeerHeader) {
        lines.push(`### ${peerLabel}`);
        renderedPeerHeader = true;
      }
      const capped = value.length > 1200 ? `${value.slice(0, 1200)}…[truncated]` : value;
      lines.push(`**round ${r + 1}**:\n${capped}`);
      lines.push('');
      renderedAny = true;
    }
  }
  return renderedAny ? lines.join('\n') : null;
}

/**
 * Per-round per-primary sub-task budget. Splits the parent's wall-clock
 * budget across (rounds × primaries) plus headroom — each round of a
 * primary gets a fair share of the total budget. Token budget honours
 * the planner-assigned `step.budgetFraction`.
 */
function deriveSubBudget(
  parentInput: TaskInput,
  step: WorkflowStep,
  block: CollaborationBlock,
): TaskInput['budget'] {
  const totalSlots = Math.max(1, block.primaryStepIds.length * block.rounds);
  const perSlotMs = Math.floor(parentInput.budget.maxDurationMs / totalSlots);
  return {
    maxTokens: Math.max(500, Math.floor(parentInput.budget.maxTokens * step.budgetFraction)),
    // Floor at 60s — sub-tasks need enough wall-clock to receive at least
    // one streaming token before the parent's watchdog kicks in.
    maxDurationMs: Math.max(60_000, perSlotMs),
    maxRetries: parentInput.budget.maxRetries,
  };
}
