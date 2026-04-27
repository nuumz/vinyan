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
import type { LLMProviderRegistry } from '../llm/provider-registry.ts';
import type { TaskInput, TaskResult } from '../types.ts';
import {
  approvalTimeoutMs,
  awaitApprovalDecision,
  requiresApproval,
  type WorkflowConfig,
} from './approval-gate.ts';
import { buildKnowledgeContext } from './knowledge-context.ts';
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
  intentWorkflowPrompt?: string;
  /** Workflow config from vinyan.json — controls approval gating behaviour. */
  workflowConfig?: WorkflowConfig;
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
  };

  const rawPlan = await planWorkflow(plannerDeps, {
    goal: input.goal,
    targetFiles: input.targetFiles,
    constraints: input.constraints,
    acceptanceCriteria: input.acceptanceCriteria,
    intentWorkflowPrompt: deps.intentWorkflowPrompt,
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
    if (decision !== 'approved') {
      const reason = decision === 'timeout'
        ? `Approval timed out after ${timeoutMs}ms`
        : 'User rejected workflow plan';
      // Emit plan_rejected on timeout too. User-driven rejections already
      // fire this from the API layer, but the timeout path resolves inside
      // awaitApprovalDecision without touching the bus — and UIs subscribed
      // to plan_ready/plan_approved/plan_rejected need a terminal signal to
      // tear down the inline approval card.
      if (decision === 'timeout') {
        bus.emit('workflow:plan_rejected', { taskId: input.id, reason });
      }
      bus.emit('workflow:complete', {
        goal: plan.goal,
        status: 'failed',
        stepsCompleted: 0,
        totalSteps: plan.steps.length,
      });
      return {
        status: 'failed',
        stepResults: [],
        synthesizedOutput: reason,
        totalTokensConsumed: 0,
        totalDurationMs: performance.now() - startTime,
      };
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
  const completed = new Set<string>();
  let totalTokens = 0;

  // Topological execution — process steps whose dependencies are met
  const remaining = new Set(plan.steps.map((s) => s.id));

  while (remaining.size > 0) {
    const ready = plan.steps.filter(
      (s) => remaining.has(s.id) && s.dependencies.every((d) => completed.has(d)),
    );

    if (ready.length === 0 && remaining.size > 0) {
      // Deadlock — circular dependency or missing step
      deps.bus?.emit('workflow:complete', {
        goal: plan.goal,
        status: 'failed',
        stepsCompleted: completed.size,
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

    // Execute ready steps in parallel
    const results = await Promise.all(
      ready.map((step) => executeStep(step, plan, stepResults, input, deps)),
    );

    for (const result of results) {
      stepResults.set(result.stepId, result);
      completed.add(result.stepId);
      remaining.delete(result.stepId);
      totalTokens += result.tokensConsumed;
    }
  }

  const allCompleted = [...stepResults.values()].every((r) => r.status === 'completed');
  const anyFailed = [...stepResults.values()].some((r) => r.status === 'failed');
  const status = allCompleted ? 'completed' : anyFailed ? 'partial' : 'completed';

  deps.bus?.emit('workflow:complete', {
    goal: plan.goal,
    status,
    stepsCompleted: completed.size,
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

  let result = await dispatchStrategy(step.strategy, step, interpolatedInputs, input, deps);

  // Fallback on failure
  if (result.status === 'failed' && step.fallbackStrategy) {
    deps.bus?.emit('workflow:step_fallback', {
      stepId: step.id,
      primaryStrategy: step.strategy,
      fallbackStrategy: step.fallbackStrategy,
    });
    result = await dispatchStrategy(step.fallbackStrategy, step, interpolatedInputs, input, deps);
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
        const results = await deps.toolExecutor.executeProposedTools(
          [{ id: `wf-${step.id}`, tool: 'shell_exec', parameters: { command: step.description } }],
          { workspace: deps.workspace ?? '.', allowedPaths: [], routingLevel: 2 },
        );
        const toolResult = results[0];
        return {
          ...base,
          status: toolResult?.status === 'success' ? 'completed' : 'failed',
          output: toolResult?.output ?? toolResult?.error ?? '',
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
        const request = {
          systemPrompt: 'You are a reasoning assistant. Analyze and respond concisely.',
          userPrompt: `${step.description}\n\nContext:\n${interpolatedInputs}`,
          maxTokens: Math.min(4000, Math.floor(input.budget.maxTokens * step.budgetFraction)),
          timeoutMs: workflowStepTimeoutMs(input, step.budgetFraction),
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
        };
        const taskResult = await deps.executeTask(subInput);
        return {
          ...base,
          status: taskResult.status === 'completed' ? 'completed' : 'failed',
          output: taskResult.answer ?? JSON.stringify(taskResult.mutations.map((m) => m.file)),
          tokensConsumed: taskResult.trace?.tokensConsumed ?? 0,
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

  // Synthesize final output
  let synthesizedOutput: string;
  if (allResults.length === 1) {
    synthesizedOutput = allResults[0]!.output;
  } else {
    const provider = deps.llmRegistry?.selectByTier('fast');
    if (provider) {
      try {
        const stepSummaries = allResults
          .map((r) => `[${r.stepId}] (${r.strategyUsed}): ${r.output.slice(0, 300)}`)
          .join('\n\n');
        const request = {
          systemPrompt: 'Synthesize multiple step results into a coherent final answer. Be concise.',
          userPrompt: `Goal: ${plan.goal}\n\nSynthesis instruction: ${plan.synthesisPrompt}\n\nStep results:\n${stepSummaries}`,
          maxTokens: 2000,
          timeoutMs: Math.max(MIN_WORKFLOW_LLM_TIMEOUT_MS, Math.floor(taskTimeoutMs * 0.25)),
        };
        const response = provider.generateStream
          ? await provider.generateStream(request, ({ text }) => emitWorkflowTextDelta(deps, taskId, text))
          : await provider.generate(request);
        synthesizedOutput = response.content;
        totalTokens += (response.tokensUsed?.input ?? 0) + (response.tokensUsed?.output ?? 0);
      } catch {
        synthesizedOutput = allResults.map((r) => `## ${r.stepId}\n${r.output}`).join('\n\n');
      }
    } else {
      synthesizedOutput = allResults.map((r) => `## ${r.stepId}\n${r.output}`).join('\n\n');
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
