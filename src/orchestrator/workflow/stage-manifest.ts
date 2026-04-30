/**
 * Workflow Stage Manifest — durable post-prompt decision/plan/todo state.
 *
 * The orchestrator emits this state right after the workflow planner finalizes
 * a plan and BEFORE any step executes, so process-replay surfaces (live SSE,
 * historical reload) can reconstruct what Vinyan decided to do, what plan it
 * built, what todo checklist exists, and which sub-agent owns each delegated
 * subtask — without having to infer that from raw plan steps client-side.
 *
 * A3: every field is derived rule-based from the planner's output and the
 * agent registry. No LLM post-processing classifies the manifest.
 *
 * A8/A9: subtask records carry honest failure shape (errorKind, errorMessage,
 * partial output) so a failed agent does not collapse to "[no output captured]"
 * in the UI; the durable event has enough detail for debugging.
 */
import type { AgentRegistry } from '../agents/registry.ts';
import type { WorkflowPlan, WorkflowStep, WorkflowStepStrategy } from './types.ts';

export type WorkflowDecisionKind =
  | 'conversational'
  | 'direct-tool'
  | 'single-agent'
  | 'multi-agent'
  | 'human-input-required'
  | 'approval-required'
  | 'full-pipeline'
  | 'unknown';

export interface WorkflowDecisionStage {
  taskId: string;
  sessionId?: string;
  userPrompt: string;
  decisionKind: WorkflowDecisionKind;
  decisionRationale?: string;
  createdAt: number;
  plannerVersion?: string;
  routingLevel?: number;
  confidence?: number;
  requiredCapabilities?: string[];
  riskSummary?: string;
  planId?: string;
}

export type WorkflowTodoOwnerType = 'system' | 'agent' | 'human' | 'tool';

export type WorkflowTodoStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface WorkflowTodoItem {
  id: string;
  title: string;
  description?: string;
  ownerType: WorkflowTodoOwnerType;
  ownerId?: string;
  status: WorkflowTodoStatus;
  dependsOn: string[];
  sourceStepId?: string;
  expectedOutput?: string;
  failureReason?: string;
}

export type MultiAgentSubtaskStatus = 'planned' | 'dispatched' | 'running' | 'done' | 'failed' | 'timeout' | 'skipped';

export type MultiAgentSubtaskErrorKind =
  | 'provider_quota'
  | 'timeout'
  | 'empty_response'
  | 'parse_error'
  | 'contract_violation'
  | 'dependency_failed'
  | 'subtask_failed'
  | 'unknown';

export interface MultiAgentSubtask {
  subtaskId: string;
  parentTaskId: string;
  sessionId?: string;
  stepId: string;
  agentId?: string;
  agentName?: string;
  agentRole?: string;
  capabilityTags?: string[];
  /** Deterministic fallback label when agentId is unset (e.g. "Agent 1"). */
  fallbackLabel: string;
  title: string;
  objective: string;
  prompt: string;
  inputRefs: string[];
  expectedOutput?: string;
  status: MultiAgentSubtaskStatus;
  startedAt?: number;
  completedAt?: number;
  outputPreview?: string;
  errorKind?: MultiAgentSubtaskErrorKind;
  errorMessage?: string;
  partialOutputAvailable?: boolean;
  fallbackAttempted?: boolean;
  traceId?: string;
}

/**
 * Group mode for a set of multi-agent subtasks. Lets the UI render
 * "competition" / "debate" / "comparison" framing instead of just listing
 * agents. Derived from planner output (synthesisPrompt heuristics + step
 * count) — rule-based, no LLM classification.
 */
export type MultiAgentGroupMode = 'parallel' | 'competition' | 'debate' | 'comparison' | 'pipeline';

export interface WorkflowStageManifest {
  taskId: string;
  sessionId?: string;
  decision: WorkflowDecisionStage;
  planSteps: Array<{
    id: string;
    description: string;
    strategy: WorkflowStepStrategy;
    dependencies: string[];
    agentId?: string;
    expectedOutput?: string;
    budgetFraction?: number;
  }>;
  todoList: WorkflowTodoItem[];
  multiAgentSubtasks: MultiAgentSubtask[];
  groupMode?: MultiAgentGroupMode;
  createdAt: number;
  updatedAt: number;
}

interface BuildOptions {
  taskId: string;
  sessionId?: string;
  userPrompt: string;
  plan: WorkflowPlan;
  agentRegistry?: AgentRegistry;
  routingLevel?: number;
  confidence?: number;
  decisionRationale?: string;
}

/**
 * Derive a {@link WorkflowDecisionKind} from the finalized plan.
 *
 * A3: deterministic switch on planner output. No LLM.
 *
 * - any `delegate-sub-agent` step (≥2 distinct delegates) → 'multi-agent'
 * - exactly one `delegate-sub-agent` step → 'single-agent'
 * - any `human-input` step → 'human-input-required'
 * - any `full-pipeline` step → 'full-pipeline'
 * - only `direct-tool` steps → 'direct-tool'
 * - everything else (knowledge-query / llm-reasoning) → 'single-agent'
 *
 * `approval-required` is set by the caller when the executor's approval gate
 * fires; the executor knows that state, this function does not.
 */
export function classifyDecisionKind(plan: WorkflowPlan): WorkflowDecisionKind {
  const strategies = plan.steps.map((s) => s.strategy);
  const delegateCount = strategies.filter((s) => s === 'delegate-sub-agent').length;
  if (delegateCount >= 2) return 'multi-agent';
  if (delegateCount === 1) return 'single-agent';
  if (strategies.includes('human-input')) return 'human-input-required';
  if (strategies.includes('full-pipeline')) return 'full-pipeline';
  if (strategies.every((s) => s === 'direct-tool')) return 'direct-tool';
  return 'single-agent';
}

/**
 * Derive a {@link MultiAgentGroupMode} from synthesis prompt + step shape.
 *
 * Heuristic but rule-based (no LLM): the planner's `synthesisPrompt` tells
 * us whether the plan is a competition, debate, or just parallel work. We
 * scan for explicit Thai/EN keywords. Returns undefined for non-multi-agent
 * plans.
 */
export function classifyGroupMode(plan: WorkflowPlan): MultiAgentGroupMode | undefined {
  const delegateCount = plan.steps.filter((s) => s.strategy === 'delegate-sub-agent').length;
  if (delegateCount < 2) return undefined;
  const synth = plan.synthesisPrompt.toLowerCase();
  if (/(competit|แข่ง|วิน(ว|))/.test(synth)) return 'competition';
  if (/(debate|argue|ดีเบต|โต้)/.test(synth)) return 'debate';
  if (/(compar|side[- ]by[- ]side|เปรียบเทียบ)/.test(synth)) return 'comparison';
  // Multi-agent steps that have a final synthesis dependent on all delegates
  // are a comparison-shaped fan-in by default.
  return 'comparison';
}

function ownerTypeForStrategy(strategy: WorkflowStepStrategy): WorkflowTodoOwnerType {
  switch (strategy) {
    case 'delegate-sub-agent':
      return 'agent';
    case 'human-input':
      return 'human';
    case 'direct-tool':
    case 'external-coding-cli':
      return 'tool';
    default:
      return 'system';
  }
}

function todoTitleFor(step: WorkflowStep): string {
  const trimmed = step.description?.trim() ?? '';
  if (!trimmed) return `Step ${step.id}`;
  // Cap titles so the UI checklist stays one line; full text lives in
  // `description`.
  const max = 140;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

function inputRefsFor(step: WorkflowStep): string[] {
  const refs: string[] = [];
  for (const value of Object.values(step.inputs ?? {})) {
    const m = value.match(/^\$(\w+)\.result$/);
    if (m) refs.push(m[1]!);
  }
  return refs;
}

function lookupAgentMeta(
  registry: AgentRegistry | undefined,
  agentId: string | undefined,
): { agentName?: string; agentRole?: string; capabilityTags?: string[] } {
  if (!registry || !agentId) return {};
  try {
    const match = registry.getAgent(agentId);
    if (!match) return {};
    const tags = Array.isArray(match.capabilities)
      ? match.capabilities
          .map((c) => (typeof c === 'string' ? c : (c as { id?: string }).id))
          .filter((s): s is string => typeof s === 'string' && s.length > 0)
      : undefined;
    return {
      agentName: match.name ?? agentId,
      agentRole: match.role ?? match.description,
      capabilityTags: tags && tags.length > 0 ? tags : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Build the full stage manifest from a finalized {@link WorkflowPlan}.
 *
 * The executor calls this after the plan is finalized (post research-step
 * injection, post agentId sanitization) and BEFORE step dispatch. The
 * resulting manifest is the durable shape the UI replays.
 */
export function buildStageManifest(opts: BuildOptions): WorkflowStageManifest {
  const now = Date.now();
  const decisionKind = classifyDecisionKind(opts.plan);
  const decision: WorkflowDecisionStage = {
    taskId: opts.taskId,
    sessionId: opts.sessionId,
    userPrompt: opts.userPrompt,
    decisionKind,
    decisionRationale: opts.decisionRationale,
    createdAt: now,
    routingLevel: opts.routingLevel,
    confidence: opts.confidence,
  };

  const planSteps = opts.plan.steps.map((s) => ({
    id: s.id,
    description: s.description,
    strategy: s.strategy,
    dependencies: [...s.dependencies],
    ...(s.agentId ? { agentId: s.agentId } : {}),
    ...(s.expectedOutput ? { expectedOutput: s.expectedOutput } : {}),
    ...(typeof s.budgetFraction === 'number' ? { budgetFraction: s.budgetFraction } : {}),
  }));

  const todoList: WorkflowTodoItem[] = opts.plan.steps.map((s) => ({
    id: `todo-${s.id}`,
    title: todoTitleFor(s),
    description: s.description,
    ownerType: ownerTypeForStrategy(s.strategy),
    ownerId: s.agentId,
    status: 'pending',
    dependsOn: [...s.dependencies],
    sourceStepId: s.id,
    expectedOutput: s.expectedOutput || undefined,
  }));

  // Build subtask records only for delegate-sub-agent steps. Numbering is
  // 1-based and stable in plan order so deterministic fallback labels
  // ("Agent 1", "Agent 2", …) line up with the UI rendering.
  const delegateSteps = opts.plan.steps.filter((s) => s.strategy === 'delegate-sub-agent');
  const multiAgentSubtasks: MultiAgentSubtask[] = delegateSteps.map((step, idx) => {
    const meta = lookupAgentMeta(opts.agentRegistry, step.agentId);
    const inputRefs = inputRefsFor(step);
    const subtaskId = `${opts.taskId}-delegate-${step.id}`;
    return {
      subtaskId,
      parentTaskId: opts.taskId,
      sessionId: opts.sessionId,
      stepId: step.id,
      ...(step.agentId ? { agentId: step.agentId } : {}),
      ...(meta.agentName ? { agentName: meta.agentName } : {}),
      ...(meta.agentRole ? { agentRole: meta.agentRole } : {}),
      ...(meta.capabilityTags && meta.capabilityTags.length > 0 ? { capabilityTags: meta.capabilityTags } : {}),
      fallbackLabel: `Agent ${idx + 1}`,
      title: todoTitleFor(step),
      objective: step.description,
      prompt: step.description,
      inputRefs,
      expectedOutput: step.expectedOutput || undefined,
      status: 'planned',
    };
  });

  return {
    taskId: opts.taskId,
    sessionId: opts.sessionId,
    decision,
    planSteps,
    todoList,
    multiAgentSubtasks,
    groupMode: classifyGroupMode(opts.plan),
    createdAt: now,
    updatedAt: now,
  };
}

/** Bus payload for `workflow:decision_recorded`. */
export interface WorkflowDecisionRecordedEvent {
  taskId: string;
  sessionId?: string;
  decision: WorkflowDecisionStage;
}

/** Bus payload for `workflow:todo_created`. */
export interface WorkflowTodoCreatedEvent {
  taskId: string;
  sessionId?: string;
  todoList: WorkflowTodoItem[];
  groupMode?: MultiAgentGroupMode;
}

/** Bus payload for `workflow:todo_updated`. */
export interface WorkflowTodoUpdatedEvent {
  taskId: string;
  sessionId?: string;
  todoId: string;
  status: WorkflowTodoStatus;
  failureReason?: string;
  /** Optional, for UI live updates without a full refetch. */
  ownerId?: string;
}

/** Bus payload for `workflow:subtasks_planned`. */
export interface WorkflowSubtasksPlannedEvent {
  taskId: string;
  sessionId?: string;
  groupMode?: MultiAgentGroupMode;
  subtasks: MultiAgentSubtask[];
}

/** Bus payload for `workflow:subtask_updated`. */
export interface WorkflowSubtaskUpdatedEvent {
  taskId: string;
  sessionId?: string;
  subtaskId: string;
  stepId: string;
  status: MultiAgentSubtaskStatus;
  agentId?: string;
  startedAt?: number;
  completedAt?: number;
  outputPreview?: string;
  errorKind?: MultiAgentSubtaskErrorKind;
  errorMessage?: string;
  partialOutputAvailable?: boolean;
  fallbackAttempted?: boolean;
}
