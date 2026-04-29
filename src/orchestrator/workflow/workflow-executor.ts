/**
 * Workflow Executor — dispatches each WorkflowStep to the appropriate
 * subsystem, respects dependency order, and synthesizes a final result.
 *
 * A3: dispatch routing is a deterministic switch on step.strategy.
 * A6: each step gets a scoped budget (budgetFraction of parent).
 * A7: step failures trigger fallback; partial results are returned honestly.
 */
import type { VinyanBus } from '../../core/bus.ts';
import type { WorldGraph } from '../../world-graph/world-graph.ts';
import type { AgentMemoryAPI } from '../agent-memory/agent-memory-api.ts';
import { frozenSystemTier } from '../llm/prompt-assembler.ts';
import type { LLMProviderRegistry } from '../llm/provider-registry.ts';
import type { TaskInput, TaskResult } from '../types.ts';
import { selectVerifierForDelegation } from '../agents/a1-verifier-router.ts';
import {
  approvalTimeoutMs,
  awaitApprovalDecision,
  requiresApproval,
  type WorkflowConfig,
} from './approval-gate.ts';
import { buildKnowledgeContext } from './knowledge-context.ts';
import { formatSessionTranscript } from './session-transcript.ts';
import {
  buildResearchStep,
  detectResearchCues,
  prependResearchStep,
} from './research-step-builder.ts';
import type {
  WorkflowPlan,
  WorkflowResult,
  WorkflowStep,
  WorkflowStepResult,
  WorkflowStepStrategy,
} from './types.ts';
import { planWorkflow, type WorkflowPlannerDeps } from './workflow-planner.ts';

const MIN_WORKFLOW_LLM_TIMEOUT_MS = 120_000;

/**
 * Wrap multi-line shell output in a markdown code fence so the chat UI
 * preserves columns/whitespace. Single-line / empty outputs pass through
 * unchanged. Outputs that already contain triple-backticks fall back to a
 * `~~~` fence to avoid breaking the wrap. Mirrors the helper used by the
 * direct-tool short-circuit path in `core-loop.ts` — keeping a local copy
 * to avoid an awkward upward import. Behaviour MUST stay in sync.
 */
function fenceShellOutput(output: string): string {
  if (!output) return output;
  if (!output.includes('\n')) return output;
  const fence = output.includes('```') ? '~~~' : '```';
  return `${fence}\n${output.replace(/\n+$/, '')}\n${fence}`;
}

function workflowStepTimeoutMs(input: TaskInput, budgetFraction: number): number {
  const fractionalBudget = Math.floor(input.budget.maxDurationMs * Math.max(budgetFraction, 0.25));
  return Math.max(MIN_WORKFLOW_LLM_TIMEOUT_MS, fractionalBudget);
}

function emitWorkflowTextDelta(deps: WorkflowExecutorDeps, taskId: string, text: string): void {
  if (!text) return;
  deps.bus?.emit('llm:stream_delta', { taskId, kind: 'content', text });
}

export interface WorkflowExecutorDeps {
  llmRegistry?: LLMProviderRegistry;
  worldGraph?: WorldGraph;
  agentMemory?: AgentMemoryAPI;
  toolExecutor?: {
    executeProposedTools(
      calls: Array<{ id: string; tool: string; parameters: Record<string, unknown> }>,
      context: { workspace: string; allowedPaths: string[]; routingLevel: number },
    ): Promise<Array<{ status: string; output?: string; error?: string }>>;
  };
  bus?: VinyanBus;
  workspace?: string;
  executeTask?: (subInput: TaskInput) => Promise<TaskResult>;
  /**
   * Phase-13 — agent registry handle. Used by the `delegate-sub-agent`
   * dispatch path to enforce A1 Epistemic Separation: when a sub-task is
   * delegated for verification work on a code-mutation parent, the executor
   * forces the canonical Verifier-class persona (typically `reviewer`)
   * instead of letting the sub-task inherit the parent's agentId. Optional —
   * when omitted, A1 enforcement is skipped (legacy / test paths).
   */
  agentRegistry?: import('../agents/registry.ts').AgentRegistry;
  intentWorkflowPrompt?: string;
  /** Workflow config from vinyan.json — controls approval gating behaviour. */
  workflowConfig?: WorkflowConfig;
  /**
   * Recent session turns (oldest → newest) — caller-fetched from
   * SessionManager.getTurnsHistory. Plumbed through to the planner and
   * synthesizer so multi-turn workflows continue prior assistant output
   * instead of restarting from scratch on follow-up turns. Skip / omit for
   * single-turn or non-conversational invocations.
   */
  sessionTurns?: import('../types.ts').Turn[];
}

export async function executeWorkflow(
  input: TaskInput,
  deps: WorkflowExecutorDeps,
): Promise<WorkflowResult> {
  const startTime = performance.now();

  const plannerDeps: WorkflowPlannerDeps = {
    llmRegistry: deps.llmRegistry,
    knowledgeDeps: { agentMemory: deps.agentMemory, worldGraph: deps.worldGraph },
    bus: deps.bus,
    // Plumb the agent roster into the planner so multi-agent goals can be
    // mapped to specific personas via `step.agentId`. Without this the
    // planner has no idea which ids exist and degenerates into a single
    // role-playing llm-reasoning step (incident: session 46e730ed —
    // "แบ่ง Agent 3ตัว แข่งกันถามตอบ" produced one model role-playing 3
    // personas instead of three distinct delegate-sub-agent dispatches).
    agentRegistry: deps.agentRegistry,
  };

  const rawPlan = await planWorkflow(plannerDeps, {
    goal: input.goal,
    targetFiles: input.targetFiles,
    constraints: input.constraints,
    acceptanceCriteria: input.acceptanceCriteria,
    intentWorkflowPrompt: deps.intentWorkflowPrompt,
    sessionTurns: deps.sessionTurns,
  });

  // Phase C: prepend a deterministic research step for long-form creative /
  // market-oriented goals so downstream drafting has trend context to work
  // against. LLM-knowledge-only — no external web access.
  const researchCue = detectResearchCues(input.goal);
  const plan: WorkflowPlan = researchCue.needsResearch && researchCue.brief
    ? {
        ...rawPlan,
        steps: prependResearchStep(rawPlan.steps, buildResearchStep(researchCue.brief)),
      }
    : rawPlan;

  if (researchCue.needsResearch) {
    deps.bus?.emit('workflow:research_injected', {
      goal: plan.goal,
      reason: researchCue.reason ?? 'unknown',
    });
  }

  // Phase E: emit the final plan so UIs can render a TODO checklist before
  // execution starts. When `workflow.requireUserApproval` is active, the
  // executor pauses here until the user approves (via bus event). On timeout
  // or rejection, the workflow returns a failed result and no steps execute.
  const stepsForEvent = plan.steps.map((s) => ({
    id: s.id,
    description: s.description,
    strategy: s.strategy,
    dependencies: [...s.dependencies],
    // Multi-agent UI surface: tell the chat which agent persona owns each
    // delegate-sub-agent step. Without this the plan checklist labels read
    // generically ("Researcher provides answer") and the agent-timeline
    // card has nothing to attach the row to. Undefined for non-delegate
    // steps where the planner did not pin a specific persona.
    ...(s.agentId ? { agentId: s.agentId } : {}),
  }));
  const needsApproval = deps.bus != null && requiresApproval(deps.workflowConfig, input.goal);
  if (needsApproval && deps.bus) {
    const bus = deps.bus;
    const timeoutMs = approvalTimeoutMs(deps.workflowConfig);
    // Subscribe BEFORE emitting plan_ready so we never miss an approval event
    // that races the emit (HTTP client may POST approve very quickly).
    const decisionPromise = awaitApprovalDecision(bus, input.id, timeoutMs);
    bus.emit('workflow:plan_ready', {
      taskId: input.id,
      goal: plan.goal,
      steps: stepsForEvent,
      awaitingApproval: true,
    });
    const decision = await decisionPromise;
    if (decision === 'rejected') {
      bus.emit('workflow:complete', {
        goal: plan.goal,
        status: 'failed',
        stepsCompleted: 0,
        totalSteps: plan.steps.length,
      });
      return {
        status: 'failed',
        stepResults: [],
        synthesizedOutput: 'User rejected workflow plan',
        totalTokensConsumed: 0,
        totalDurationMs: performance.now() - startTime,
      };
    }
    // `decision === 'timeout'` falls through to execution: an absent user is
    // treated as implicit approval. Emit `workflow:plan_approved` so UIs
    // subscribed to the gate events tear down the inline approval card and
    // flip back to a normal running state instead of waiting for the next
    // step event to arrive.
    if (decision === 'timeout') {
      bus.emit('workflow:plan_approved', { taskId: input.id });
    }
  } else {
    deps.bus?.emit('workflow:plan_ready', {
      taskId: input.id,
      goal: plan.goal,
      steps: stepsForEvent,
      awaitingApproval: false,
    });
  }

  const stepResults = new Map<string, WorkflowStepResult>();
  // `succeeded` carries dependency-satisfaction semantics: a downstream step
  // is only `ready` when every dep ran AND completed successfully. Failed or
  // skipped upstream steps propagate as `skipped` to their dependents — they
  // do NOT silently satisfy the dependency the way "any finished step"
  // would. `finished` covers everything that has produced a result so we
  // can detect when no further progress is possible.
  const succeeded = new Set<string>();
  const finished = new Set<string>();
  let totalTokens = 0;

  // Live status mirror used to keep `agent:plan_update` in sync with the
  // executor's per-step state machine. The chat UI's reducer keys off
  // `agent:plan_update` to mark which step is running, so without re-emitting
  // it on every state transition the plan checklist freezes after the
  // initial snapshot from `phase-plan`.
  type PlanStepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';
  const stepStatuses = new Map<string, PlanStepStatus>();
  for (const s of plan.steps) stepStatuses.set(s.id, 'pending');
  const emitPlanUpdate = () => {
    if (!deps.bus) return;
    deps.bus.emit('agent:plan_update', {
      taskId: input.id,
      steps: plan.steps.map((s) => ({
        id: s.id,
        label: s.description,
        status: stepStatuses.get(s.id) ?? 'pending',
        // Carry strategy + agentId so the agent-timeline UI card can
        // distinguish delegate-sub-agent steps (which should render as
        // distinct agent rows) from llm-reasoning / direct-tool / synthesis
        // steps that share the parent persona.
        strategy: s.strategy,
        ...(s.agentId ? { agentId: s.agentId } : {}),
      })),
    });
  };
  // Seed the chat UI with the full plan checklist before any step runs. The
  // executor already emits `workflow:plan_ready` with the steps, but the
  // streaming-turn reducer drives its plan checklist off `agent:plan_update`
  // so we emit one initial snapshot here.
  emitPlanUpdate();

  // Record a failed-approach entry into the rejected-approach store so future
  // planners that call `queryFailedApproaches` can avoid the same path. All
  // call sites are best-effort (try/catch swallow) — recording is
  // observability, not a correctness gate. We skip recording on the explicit
  // user-rejection path (line 127-141) and on the auto-approve-on-timeout
  // path (line 147-149) — those are not bad approaches, they're user
  // choices / infra signals.
  const recordFailure = async (failureOracle: string, failedSteps: string[]) => {
    if (!deps.agentMemory?.recordFailedApproach) return;
    try {
      const approach = `agentic-workflow:${plan.steps.map((s) => s.strategy).join(',')}`;
      const actionVerb = (input.goal.match(/^\s*(\w+)/)?.[1] ?? '').toLowerCase();
      await deps.agentMemory.recordFailedApproach({
        taskId: input.id,
        taskType: input.taskType,
        approach: failedSteps.length > 0
          ? `${approach}|failed:${failedSteps.join(',')}`
          : approach,
        failureOracle,
        routingLevel: 2,
        fileTarget: input.targetFiles?.[0] ?? '',
        actionVerb: actionVerb || undefined,
      });
    } catch {
      /* best-effort — failed-approach recording is observability, not a hard dep */
    }
  };

  // Topological execution — process steps whose dependencies are met
  const remaining = new Set(plan.steps.map((s) => s.id));

  while (remaining.size > 0) {
    // A step is `ready` when every dep finished AND succeeded.
    // A step is `skip-now` when at least one dep finished and failed/skipped
    // (we can't run it, so emit a synthetic `skipped` result and propagate).
    const ready: typeof plan.steps = [];
    const skipNow: Array<{ step: (typeof plan.steps)[number]; failedDeps: string[] }> = [];
    for (const step of plan.steps) {
      if (!remaining.has(step.id)) continue;
      const failedDeps = step.dependencies.filter(
        (d) => finished.has(d) && !succeeded.has(d),
      );
      if (failedDeps.length > 0) {
        skipNow.push({ step, failedDeps });
        continue;
      }
      if (step.dependencies.every((d) => succeeded.has(d))) {
        ready.push(step);
      }
    }

    if (ready.length === 0 && skipNow.length === 0 && remaining.size > 0) {
      // Deadlock — circular dependency or a step depends on something not in the plan
      for (const id of remaining) stepStatuses.set(id, 'failed');
      emitPlanUpdate();
      await recordFailure('workflow-deadlock', [...remaining]);
      deps.bus?.emit('workflow:complete', {
        goal: plan.goal,
        status: 'failed',
        stepsCompleted: succeeded.size,
        totalSteps: plan.steps.length,
      });
      return buildResult(
        plan,
        input.id,
        input.budget.maxDurationMs,
        stepResults,
        'failed',
        performance.now() - startTime,
        totalTokens,
        deps,
      );
    }

    // Cascade-skip dependents of failed/skipped steps before dispatching new
    // work. This drains skip propagation in a single pass per loop iteration
    // so the next iteration's `ready` set sees a consistent finished state.
    for (const { step, failedDeps } of skipNow) {
      const skippedResult: WorkflowStepResult = {
        stepId: step.id,
        status: 'skipped',
        output: `Skipped: dependency failed (${failedDeps.join(', ')})`,
        tokensConsumed: 0,
        durationMs: 0,
        strategyUsed: step.strategy,
      };
      stepResults.set(step.id, skippedResult);
      finished.add(step.id);
      remaining.delete(step.id);
      stepStatuses.set(step.id, 'skipped');
    }
    if (skipNow.length > 0) emitPlanUpdate();

    if (ready.length === 0) continue;

    // Mark all ready steps as running before dispatching so the UI can show
    // multiple parallel steps as in-flight when topology allows it.
    for (const step of ready) stepStatuses.set(step.id, 'running');
    emitPlanUpdate();

    // Execute ready steps in parallel
    const results = await Promise.all(
      ready.map((step) => executeStep(step, plan, stepResults, input, deps)),
    );

    for (const result of results) {
      stepResults.set(result.stepId, result);
      finished.add(result.stepId);
      remaining.delete(result.stepId);
      if (result.status === 'completed') succeeded.add(result.stepId);
      totalTokens += result.tokensConsumed;
      stepStatuses.set(
        result.stepId,
        result.status === 'completed'
          ? 'done'
          : result.status === 'skipped'
            ? 'skipped'
            : 'failed',
      );
    }
    emitPlanUpdate();
  }

  const allCompleted = [...stepResults.values()].every((r) => r.status === 'completed');
  const anyFailed = [...stepResults.values()].some((r) => r.status === 'failed');
  const status = allCompleted ? 'completed' : anyFailed ? 'partial' : 'completed';

  // Record approach failure when at least one step failed. `partial` covers
  // the "some succeeded, some failed" case — still useful signal for the
  // planner to know this strategy mix is unreliable for this task type.
  if (anyFailed) {
    const failedStepIds = [...stepResults.values()]
      .filter((r) => r.status === 'failed')
      .map((r) => r.stepId);
    await recordFailure('workflow-step-failed', failedStepIds);
  }

  deps.bus?.emit('workflow:complete', {
    goal: plan.goal,
    status,
    stepsCompleted: succeeded.size,
    totalSteps: plan.steps.length,
  });

  return buildResult(
    plan,
    input.id,
    input.budget.maxDurationMs,
    stepResults,
    status,
    performance.now() - startTime,
    totalTokens,
    deps,
  );
}

async function executeStep(
  step: WorkflowStep,
  plan: WorkflowPlan,
  priorResults: Map<string, WorkflowStepResult>,
  input: TaskInput,
  deps: WorkflowExecutorDeps,
): Promise<WorkflowStepResult> {
  const stepStart = performance.now();

  deps.bus?.emit('workflow:step_start', {
    stepId: step.id,
    strategy: step.strategy,
    description: step.description,
  });

  // Interpolate inputs from prior step results
  const interpolatedInputs = interpolateInputs(step.inputs, priorResults);

  let result = await dispatchStrategy(step.strategy, step, plan, interpolatedInputs, input, deps);

  // Fallback on failure
  if (result.status === 'failed' && step.fallbackStrategy) {
    deps.bus?.emit('workflow:step_fallback', {
      stepId: step.id,
      primaryStrategy: step.strategy,
      fallbackStrategy: step.fallbackStrategy,
    });
    result = await dispatchStrategy(
      step.fallbackStrategy,
      step,
      plan,
      interpolatedInputs,
      input,
      deps,
    );
    result.strategyUsed = step.fallbackStrategy;
  }

  const durationMs = Math.round(performance.now() - stepStart);
  result.durationMs = durationMs;

  deps.bus?.emit('workflow:step_complete', {
    stepId: step.id,
    status: result.status,
    strategy: result.strategyUsed,
    durationMs,
    tokensConsumed: result.tokensConsumed,
  });

  return result;
}

async function dispatchStrategy(
  strategy: WorkflowStepStrategy,
  step: WorkflowStep,
  plan: WorkflowPlan,
  interpolatedInputs: string,
  input: TaskInput,
  deps: WorkflowExecutorDeps,
): Promise<WorkflowStepResult> {
  const base: WorkflowStepResult = {
    stepId: step.id,
    status: 'completed',
    output: '',
    tokensConsumed: 0,
    durationMs: 0,
    strategyUsed: strategy,
  };

  try {
    switch (strategy) {
      case 'full-pipeline': {
        if (!deps.executeTask) return { ...base, status: 'failed', output: 'executeTask not available' };
        const subInput: TaskInput = {
          id: `${input.id}-wf-${step.id}`,
          source: input.source,
          goal: `${step.description}\n\nContext from prior steps:\n${interpolatedInputs}`,
          taskType: input.taskType,
          targetFiles: input.targetFiles,
          constraints: input.constraints,
          budget: {
            maxTokens: Math.floor(input.budget.maxTokens * step.budgetFraction),
            maxDurationMs: Math.floor(input.budget.maxDurationMs * step.budgetFraction),
            maxRetries: input.budget.maxRetries,
          },
        };
        const taskResult = await deps.executeTask(subInput);
        return {
          ...base,
          status: taskResult.status === 'completed' ? 'completed' : 'failed',
          output: taskResult.answer ?? taskResult.mutations.map((m) => `${m.file}: ${m.diff.slice(0, 200)}`).join('\n'),
          tokensConsumed: taskResult.trace?.tokensConsumed ?? 0,
        };
      }

      case 'direct-tool': {
        if (!deps.toolExecutor) return { ...base, status: 'failed', output: 'toolExecutor not available' };
        // Prefer the explicit `command` field — `description` is human-readable
        // and may be a natural-language sentence that would error as a shell
        // command. Legacy plans without `command` fall back to `description`.
        const command = step.command?.trim() || step.description;
        // Wrap the tool call with the same `agent:tool_started` /
        // `agent:tool_executed` pair the autonomous agent-loop emits, so
        // the chat UI's PlanSurface can render a tool card under this
        // step. Without this, direct-tool workflow steps showed an empty
        // "Tool activity" section even when a shell command ran.
        const toolCallId = `wf-${step.id}`;
        const toolStart = performance.now();
        // `turnId` is synthetic: the workflow runner has no LLM-style turn,
        // so we anchor every workflow-emitted tool event to the step id.
        const turnId = `workflow-${step.id}`;
        deps.bus?.emit('agent:tool_started', {
          taskId: input.id,
          turnId,
          toolCallId,
          toolName: 'shell_exec',
          args: { command },
        });
        const results = await deps.toolExecutor.executeProposedTools(
          [{ id: toolCallId, tool: 'shell_exec', parameters: { command } }],
          { workspace: deps.workspace ?? '.', allowedPaths: [], routingLevel: 2 },
        );
        const toolResult = results[0];
        const toolDurationMs = Math.round(performance.now() - toolStart);
        deps.bus?.emit('agent:tool_executed', {
          taskId: input.id,
          turnId,
          toolCallId,
          toolName: 'shell_exec',
          isError: toolResult?.status !== 'success',
          durationMs: toolDurationMs,
        });
        if (toolResult?.status === 'success') {
          // Fence stdout so the chat UI (ReactMarkdown) preserves whitespace
          // and columns. Without this, `ls -la` style multi-line output
          // collapses into a single paragraph because CommonMark treats
          // single newlines as soft breaks.
          const rawStdout = toolResult.output ?? '';
          return {
            ...base,
            status: 'completed',
            output: rawStdout ? fenceShellOutput(rawStdout) : '',
          };
        }
        // Failure: include the command + error so plan replay / synthesis can
        // surface why this step failed instead of an empty red node.
        const errMsg = toolResult?.error || toolResult?.output || 'shell command failed';
        return {
          ...base,
          status: 'failed',
          output: `Command \`${command}\` failed: ${errMsg}`,
        };
      }

      case 'knowledge-query': {
        deps.bus?.emit('workflow:knowledge_query', {
          stepId: step.id,
          query: step.description,
        });
        const context = await buildKnowledgeContext(
          { agentMemory: deps.agentMemory, worldGraph: deps.worldGraph },
          { targetFiles: input.targetFiles, taskSignature: step.description },
        );
        return { ...base, output: context || 'No relevant knowledge found.' };
      }

      case 'llm-reasoning': {
        const provider = deps.llmRegistry?.selectByTier('balanced') ?? deps.llmRegistry?.selectByTier('fast');
        if (!provider) return { ...base, status: 'failed', output: 'No LLM provider available' };
        // Step prompt is intentionally task-shaped, not assistant-shaped:
        //   - The agent is doing one step of a multi-step workflow that the
        //     user already approved. It should NOT re-greet the user, ask
        //     clarifying questions, or apologize for not having context —
        //     prior steps' outputs are in `interpolatedInputs`.
        //   - Match the user's language by mirroring the goal verbatim in
        //     the prompt; the model picks up Thai/EN/etc. implicitly.
        //   - For creative work, "concise" is wrong — let the step produce
        //     prose at the length its description implies.
        // Tighter caps for per-step transcripts — each step pays the cost
        // separately, so a 4-step workflow with 4000-char transcripts each
        // would burn ~16k chars of repeated context. 2400 keeps headroom for
        // step.description + interpolatedInputs without crowding maxTokens.
        const stepTranscript = formatSessionTranscript(deps.sessionTurns, {
          maxTurns: 4,
          maxCharsPerTurn: 600,
          maxTotalChars: 2400,
        });
        const userPrompt = [
          `Overall goal: ${plan.goal}`,
          stepTranscript
            ? `Prior conversation in this session (oldest → newest). The current step continues from these turns; do not restart from scratch:\n${stepTranscript}`
            : null,
          `This step (${step.id}): ${step.description}`,
          step.expectedOutput ? `Expected output: ${step.expectedOutput}` : null,
          interpolatedInputs ? `Prior workflow step output:\n${interpolatedInputs}` : null,
          '',
          'Produce just this step\'s output. Match the user\'s language and register from the goal. Do not preface with meta-commentary about the workflow or the step number.',
        ]
          .filter((s): s is string => s !== null)
          .join('\n\n');
        const stepSystemPrompt =
          'You are completing one step of a multi-step workflow toward a goal the user already approved. ' +
          'Stay focused on this step alone — do not anticipate later steps, do not summarize prior work, ' +
          'do not greet, do not ask clarifying questions. Match the user\'s language and tone from the goal. ' +
          'For creative writing tasks, write in narrative voice; for analytical tasks, be precise. ' +
          'Output the step\'s deliverable directly with no meta-framing.';
        const request = {
          systemPrompt: stepSystemPrompt,
          userPrompt,
          maxTokens: Math.min(4000, Math.floor(input.budget.maxTokens * step.budgetFraction)),
          timeoutMs: workflowStepTimeoutMs(input, step.budgetFraction),
          // Frozen-tier the constant step system prompt so Anthropic caches
          // it across the workflow's multiple llm-reasoning calls (typically
          // 2-4 per turn). The user prompt is fully turn-volatile.
          tiers: frozenSystemTier(stepSystemPrompt, userPrompt),
        };
        const response = provider.generateStream
          ? await provider.generateStream(request, ({ text }) => emitWorkflowTextDelta(deps, input.id, text))
          : await provider.generate(request);
        return {
          ...base,
          output: response.content,
          tokensConsumed: (response.tokensUsed?.input ?? 0) + (response.tokensUsed?.output ?? 0),
        };
      }

      case 'delegate-sub-agent': {
        if (!deps.executeTask) return { ...base, status: 'failed', output: 'executeTask not available' };
        // Phase-13 A1 Epistemic Separation. When the parent task is a
        // code-mutation (the binding domain per the original Phase 1 plan)
        // AND the sub-step description reads as verification work, the
        // dispatcher MUST hand the work to a Verifier-class persona — never
        // inherit the parent's generator persona. Skip when the registry
        // isn't wired or no canonical verifier is registered (forgiveness
        // for legacy / minimal setups).
        // Phase-15 Item 3: TaskInput doesn't statically carry `taskDomain`
        // today, so duck-type the read. When the upstream pipeline later
        // annotates input with TaskUnderstanding output, the domain becomes
        // observable; until then this falls through to undefined and the
        // existing parentTaskType gate stays in force (no regression).
        const parentTaskDomain = (input as { taskDomain?: import('../types.ts').TaskDomain }).taskDomain;
        const verifierAgentId = deps.agentRegistry
          ? selectVerifierForDelegation(
              {
                description: step.description,
                parentTaskType: input.taskType,
                parentAgentId: input.agentId,
                ...(parentTaskDomain ? { parentTaskDomain } : {}),
              },
              deps.agentRegistry,
            )
          : null;
        // Resolution order: A1-verifier override (code-mutation contract) >
        // planner-assigned step.agentId (multi-agent workflows) > inherit
        // parent agent / default. Verifier wins when both are set because the
        // A1 separation contract is a hard invariant; planner-assigned IDs
        // are advisory.
        const resolvedAgentId = verifierAgentId ?? step.agentId ?? undefined;
        const subInput: TaskInput = {
          id: `${input.id}-delegate-${step.id}`,
          source: input.source,
          goal: step.description,
          taskType: input.taskType,
          targetFiles: input.targetFiles,
          budget: {
            maxTokens: Math.floor(input.budget.maxTokens * step.budgetFraction),
            maxDurationMs: Math.floor(input.budget.maxDurationMs * step.budgetFraction),
            maxRetries: input.budget.maxRetries,
          },
          ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
          // Preserve session linkage so the sub-task's trace lands in the
          // parent's session and downstream observability stays connected.
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          parentTaskId: input.id,
        };
        if (verifierAgentId) {
          deps.bus?.emit('workflow:a1_verifier_routed', {
            taskId: input.id,
            stepId: step.id,
            generatorAgentId: input.agentId ?? null,
            verifierAgentId,
          });
        }
        // Wall-clock cap on the delegate. Without this a free-tier 429
        // retry loop inside the sub-agent's LLM provider hangs the entire
        // workflow indefinitely (incident: session ede9e9e1 — 3 delegates
        // sat for 40 min until a server restart marked the task orphaned;
        // step1 had completed in 6.5s but steps 2-4 produced no observable
        // progress and no honest failure either). The cap pairs with the
        // length===0 honesty fast-path so the synthesizer reports "step X
        // timed out" instead of fabricating an answer the agent never
        // produced.
        const subTaskTimeoutMs = workflowStepTimeoutMs(input, step.budgetFraction);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<TaskResult>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `delegate-sub-agent step ${step.id} timed out after ${Math.round(subTaskTimeoutMs / 1000)}s (agent=${resolvedAgentId ?? 'default'})`,
                ),
              ),
            subTaskTimeoutMs,
          );
        });
        // Emit "delegate dispatched" so the UI agent-timeline card can show
        // the sub-agent as `running` immediately, without waiting for the
        // sub-task's own `task:start` to bubble up.
        deps.bus?.emit('workflow:delegate_dispatched', {
          taskId: input.id,
          stepId: step.id,
          agentId: resolvedAgentId ?? null,
          subTaskId: subInput.id,
          stepDescription: step.description,
        });
        let taskResult: TaskResult;
        try {
          taskResult = await Promise.race([deps.executeTask(subInput), timeoutPromise]);
        } catch (err) {
          deps.bus?.emit('workflow:delegate_timeout', {
            taskId: input.id,
            stepId: step.id,
            agentId: resolvedAgentId ?? null,
            timeoutMs: subTaskTimeoutMs,
          });
          return {
            ...base,
            status: 'failed',
            output: err instanceof Error ? err.message : String(err),
            agentId: resolvedAgentId,
            subTaskId: subInput.id,
          };
        } finally {
          if (timer) clearTimeout(timer);
        }
        const finalStatus = taskResult.status === 'completed' ? 'completed' : 'failed';
        const stepOutput =
          taskResult.answer ?? JSON.stringify(taskResult.mutations.map((m) => m.file));
        // Preview cap: 2000 chars is enough for the user to read the
        // sub-agent's reasoning + answer in the chat UI's expandable plan
        // step. Earlier 300-char cap chopped mid-word ("**Auth" instead of
        // "**Author") which the user flagged on session 43c36d16. Truncate
        // at the last whitespace within the window so we never break a
        // token. Full output is still attached on the WorkflowStepResult
        // and surfaced in the synthesized final answer above.
        const PREVIEW_CAP = 2000;
        const outputPreview =
          stepOutput.length <= PREVIEW_CAP
            ? stepOutput
            : (() => {
                const slice = stepOutput.slice(0, PREVIEW_CAP);
                const lastSpace = slice.lastIndexOf(' ');
                const lastNewline = slice.lastIndexOf('\n');
                const cut = Math.max(lastSpace, lastNewline);
                return cut > PREVIEW_CAP * 0.8 ? slice.slice(0, cut) + '…' : slice + '…';
              })();
        // Emit "delegate completed" with agent + bounded output preview so
        // the UI plan-surface step can show what each sub-agent answered
        // before the parent's synthesizer aggregates them.
        deps.bus?.emit('workflow:delegate_completed', {
          taskId: input.id,
          stepId: step.id,
          subTaskId: subInput.id,
          agentId: resolvedAgentId ?? null,
          status: finalStatus,
          outputPreview,
          tokensUsed: taskResult.trace?.tokensConsumed ?? 0,
        });
        return {
          ...base,
          status: finalStatus,
          output: stepOutput,
          tokensConsumed: taskResult.trace?.tokensConsumed ?? 0,
          agentId: resolvedAgentId,
          subTaskId: subInput.id,
        };
      }

      case 'human-input': {
        deps.bus?.emit('workflow:human_input_needed', {
          stepId: step.id,
          question: step.description,
        });
        return { ...base, status: 'skipped', output: '[Awaiting human input]' };
      }

      default:
        return { ...base, status: 'failed', output: `Unknown strategy: ${strategy}` };
    }
  } catch (err) {
    return {
      ...base,
      status: 'failed',
      output: `Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function interpolateInputs(
  inputs: Record<string, string>,
  priorResults: Map<string, WorkflowStepResult>,
): string {
  const parts: string[] = [];
  for (const [key, ref] of Object.entries(inputs)) {
    const match = ref.match(/^\$(\w+)\.result$/);
    if (match) {
      const prior = priorResults.get(match[1]!);
      if (prior) {
        const snippet = prior.output.length > 500 ? `${prior.output.slice(0, 500)}...` : prior.output;
        parts.push(`${key}: ${snippet}`);
      }
    } else {
      parts.push(`${key}: ${ref}`);
    }
  }
  return parts.join('\n');
}

async function buildResult(
  plan: WorkflowPlan,
  taskId: string,
  taskTimeoutMs: number,
  stepResults: Map<string, WorkflowStepResult>,
  status: WorkflowResult['status'],
  durationMs: number,
  totalTokens: number,
  deps: WorkflowExecutorDeps,
): Promise<WorkflowResult> {
  const allResults = [...stepResults.values()];
  const failedSteps = allResults.filter((r) => r.status === 'failed');
  const skippedSteps = allResults.filter((r) => r.status === 'skipped');
  const completedSteps = allResults.filter((r) => r.status === 'completed');

  // Cross-reference plan to identify which steps were delegate-sub-agent.
  // When a multi-agent goal's delegated agents all fail, the question
  // structure / setup steps that succeeded (e.g. "generate the quiz") are
  // not a substitute for the missing agent answers — fabricating those
  // answers from the step descriptions is exactly the regression we are
  // protecting against (incident: session fa12c770 — Researcher delegate
  // timed out, synthesizer still wrote "จำลองการตอบของ Agent ที่เหลือ").
  const delegateStepIds = new Set(
    plan.steps.filter((s) => s.strategy === 'delegate-sub-agent').map((s) => s.id),
  );
  const delegateResults = allResults.filter((r) => delegateStepIds.has(r.stepId));
  const completedDelegates = delegateResults.filter((r) => r.status === 'completed');
  const allDelegatesFailed = delegateResults.length > 0 && completedDelegates.length === 0;

  // A2 honesty fast-path: when no step succeeded, refuse to call the
  // synthesizer LLM at all. Free-tier 429 incident on session 44c83a53
  // showed that handing failed step outputs ("429 error") to the
  // synthesizer with a "produce the final answer" prompt causes the model
  // to FABRICATE the missing content (it confabulated three agents'
  // answers to complete the requested simulation). A deterministic
  // failure report is the only safe output when there is nothing real to
  // synthesize from. Also catches the zero-step edge case (planner /
  // executor exited before producing any results) — without this guard
  // the synthesizer ran with empty step summaries and fabricated an
  // entire multi-agent comparison from the goal text alone (incident:
  // session 46e730ed — "ไม่เห็นแบ่ง Agent 3ตัว แข่งกันถามตอบเลย มันไป
  // จำลองสมมติ 3agent ใน request เดียวเฉยๆ").
  if (allResults.length === 0 || completedSteps.length === 0 || allDelegatesFailed) {
    const body =
      allResults.length === 0
        ? `The workflow produced no step results — the planner or executor exited before any step ran. ` +
          `No synthesis was attempted: there is nothing real to aggregate, and asking the LLM to ` +
          `"answer the goal anyway" would fabricate content the workflow never produced.`
        : allDelegatesFailed
          ? (() => {
              // Multi-agent specific failure: any setup steps (generate the
              // question, gather context) may have succeeded, but the
              // delegated agent answers — the actual content the user asked
              // for — are missing. Surface what succeeded as supporting
              // context, then list each delegate failure honestly.
              const supportLines = allResults
                .filter((r) => r.status === 'completed')
                .map(
                  (r) =>
                    `- ${r.stepId} (${r.strategyUsed}) succeeded:\n  ${r.output.trim().slice(0, 400)}`,
                )
                .join('\n');
              const delegateLines = delegateResults
                .map((r) => {
                  const snippet = r.output.trim().slice(0, 240) || '(no output)';
                  return `- ${r.stepId} [${r.status}, agent=${plan.steps.find((s) => s.id === r.stepId)?.agentId ?? 'default'}]: ${snippet}`;
                })
                .join('\n');
              return (
                `The multi-agent workflow could not produce real agent responses — ` +
                `${delegateResults.length} of ${delegateResults.length} delegated agents ` +
                `failed or timed out:\n\n${delegateLines}\n\n` +
                (supportLines
                  ? `Setup steps that DID succeed (shown for transparency, not as substitutes):\n\n${supportLines}\n\n`
                  : '') +
                `No synthesis was attempted: simulating the missing agent answers from the ` +
                `step descriptions alone would fabricate the very diversity the user asked for.`
              );
            })()
          : (() => {
              const failureLines = allResults
                .map((r) => {
                  const snippet = r.output.trim().slice(0, 240) || '(no output)';
                  return `- ${r.stepId} [${r.status}]: ${snippet}`;
                })
                .join('\n');
              return (
                `The workflow could not produce an answer — all ${allResults.length} step(s) ` +
                `failed or were skipped:\n\n${failureLines}\n\n` +
                `No synthesis was attempted: aggregating from zero successful steps would ` +
                `risk fabricating content that was never produced.`
              );
            })();
    return {
      status,
      stepResults: allResults,
      synthesizedOutput: body,
      totalTokensConsumed: totalTokens,
      totalDurationMs: Math.round(durationMs),
    };
  }

  // Synthesize final output
  let synthesizedOutput: string;
  if (allResults.length === 1) {
    synthesizedOutput = allResults[0]!.output;
  } else {
    const provider = deps.llmRegistry?.selectByTier('fast');
    if (provider) {
      try {
        // Per-step input cap. The earlier 300-char slice was catastrophic for
        // creative work where a single step might produce 2k+ chars of draft;
        // the synthesizer would never see the full prose and emit a summary
        // of summaries instead of the requested artifact. 3500 chars per step
        // gives the model enough context while staying within ~32k input
        // budgets across reasonable plan sizes.
        const PER_STEP_CAP = 3500;
        // Last step is privileged: in most plans it's the polished final
        // draft / edit, and we want the synthesizer to anchor on its full
        // content rather than a truncation. Earlier steps go through the
        // normal cap because they're context (brainstorm, knowledge query).
        const stepSections = allResults.map((r, idx) => {
          const isLast = idx === allResults.length - 1;
          const cap = isLast ? Math.max(PER_STEP_CAP, r.output.length) : PER_STEP_CAP;
          const body =
            r.output.length > cap ? `${r.output.slice(0, cap)}\n…[truncated]` : r.output;
          // Status tag is load-bearing: it marks failed/skipped steps so the
          // synthesizer cannot silently treat their error text as if it were
          // a real step output. See A2 honesty contract clause in the system
          // prompt below — failed/skipped tags are required for that contract
          // to be enforceable.
          const statusTag =
            r.status === 'failed'
              ? ' — FAILED'
              : r.status === 'skipped'
                ? ' — SKIPPED'
                : isLast
                  ? ' — FINAL DRAFT'
                  : '';
          return `[${r.stepId}${statusTag}] (${r.strategyUsed}):\n${body}`;
        });
        const stepSummaries = stepSections.join('\n\n---\n\n');
        const failureNotice =
          failedSteps.length > 0 || skippedSteps.length > 0
            ? `\n\n[STEP STATUS] ${completedSteps.length} succeeded, ${failedSteps.length} failed, ${skippedSteps.length} skipped. Honor the honesty contract for failed/skipped steps.`
            : '';
        const synthesizerSystemPrompt =
          'You are producing the final answer for the user from a multi-step workflow that just completed. ' +
          'The user only sees your output, not the steps. Match the user\'s language and tone from the goal. ' +
          'Choose the right shape for the goal: ' +
          'creative work → output the prose / poem / story directly without bullet-pointing it; ' +
          'analytical work → structured answer with the key findings; ' +
          'instructional work → clear step-by-step. ' +
          'When the last step\'s output is already a polished deliverable matching the goal, return it as-is ' +
          '(or with light edits) — do NOT compress it into a summary. ' +
          'When a step output contains a fenced code block (```…``` or ~~~…~~~) — typically raw shell ' +
          'output like `ls -la` listings — reproduce that fenced block verbatim in your answer (or quote ' +
          'the relevant subset, still inside a fence). NEVER inline shell output as prose; the user needs ' +
          'the column structure. ' +
          'Never narrate the workflow itself ("step 1 found…", "in this synthesis…"). ' +
          'Do not include meta-commentary, headers like "Final answer", or framing about prior steps. ' +
          'HONESTY CONTRACT (non-negotiable): when a step is tagged "— FAILED" or "— SKIPPED", you MUST ' +
          'tell the user that step did not produce real output. Do NOT invent, simulate, or fabricate the ' +
          'missing content to make the answer look complete. Surface failures plainly (e.g., ' +
          '"I could not run X because of an error" / "ขั้นตอน X ไม่สำเร็จ") and only deliver content ' +
          'derived from the COMPLETED steps. Fabricating to fill gaps is forbidden, even if the user ' +
          'goal asks for a complete deliverable.';
        const synthesizerUserPrompt = (() => {
          // Anchor the synthesis on prior conversation when the workflow is
          // a follow-up turn ("write chapter 2"). Without this the
          // synthesizer only sees the current goal + step outputs and can
          // produce something that contradicts or restarts what the
          // assistant already said in earlier turns.
          const transcript = formatSessionTranscript(deps.sessionTurns);
          const transcriptBlock = transcript
            ? `Prior conversation (oldest → newest). The synthesised final ` +
              `answer must be consistent with these turns and continue them ` +
              `where the goal asks for a continuation:\n${transcript}\n\n`
            : '';
          return (
            `User's goal: ${plan.goal}\n\n` +
            transcriptBlock +
            `Synthesis instruction (planner-suggested): ${plan.synthesisPrompt}\n\n` +
            `Step outputs (the LAST step is usually the polished deliverable):\n\n${stepSummaries}${failureNotice}`
          );
        })();
        const request = {
          systemPrompt: synthesizerSystemPrompt,
          userPrompt: synthesizerUserPrompt,
          maxTokens: 4000,
          timeoutMs: Math.max(MIN_WORKFLOW_LLM_TIMEOUT_MS, Math.floor(taskTimeoutMs * 0.25)),
          // Constant synthesizer system prompt → frozen tier so Anthropic
          // caches it across workflows. The user prompt is fully turn-volatile
          // (varies with goal + transcript + step outputs every call).
          tiers: frozenSystemTier(synthesizerSystemPrompt, synthesizerUserPrompt),
        };
        const response = provider.generateStream
          ? await provider.generateStream(request, ({ text }) => emitWorkflowTextDelta(deps, taskId, text))
          : await provider.generate(request);
        synthesizedOutput = response.content;
        totalTokens += (response.tokensUsed?.input ?? 0) + (response.tokensUsed?.output ?? 0);
      } catch {
        // Fallback when the synthesizer LLM call fails: prefer the last step's
        // raw output (usually the polished deliverable) over stitching every
        // step together with headers — the latter looks like debug output.
        const last = allResults[allResults.length - 1];
        synthesizedOutput =
          last?.output && last.output.trim().length > 0
            ? last.output
            : allResults.map((r) => r.output).join('\n\n');
      }
    } else {
      const last = allResults[allResults.length - 1];
      synthesizedOutput =
        last?.output && last.output.trim().length > 0
          ? last.output
          : allResults.map((r) => r.output).join('\n\n');
    }
  }

  return {
    status,
    stepResults: allResults,
    synthesizedOutput,
    totalTokensConsumed: totalTokens,
    totalDurationMs: Math.round(durationMs),
  };
}
