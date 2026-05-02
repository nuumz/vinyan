/**
 * Workflow types — data model for the self-orchestrating agent's
 * multi-step workflow planning and execution.
 *
 * A workflow is a DAG of steps, each with its own execution strategy.
 * The Workflow Planner generates this from a high-level goal; the
 * Workflow Executor dispatches each step to the appropriate subsystem.
 */
import { z } from 'zod/v4';
import { isPersonaIdShape, type PersonaId } from '../../core/agent-vocabulary.ts';

export type WorkflowStepStrategy =
  | 'full-pipeline'
  | 'direct-tool'
  | 'knowledge-query'
  | 'llm-reasoning'
  | 'delegate-sub-agent'
  | 'human-input'
  | 'external-coding-cli';

/**
 * Hard ceiling for `WorkflowStep.retryBudget`. The retry loop is bounded
 * for two reasons:
 *
 *   - A6 zero-trust: a runaway delegate that keeps timing out cannot be
 *     allowed to consume infinite parent budget by retrying itself.
 *   - A9 graceful degradation: retries are one of several explicit
 *     degradation rungs (retry → fallbackStrategy → user gate). Letting
 *     a single rung absorb 10+ attempts breaks that ladder.
 *
 * Three is the audit-friendly cap — same as the parent-task budget's
 * `maxRetries`. Operators wanting more should split the step instead.
 */
export const MAX_STEP_RETRY_BUDGET = 3;

/**
 * Default retry budget for `delegate-sub-agent` steps when the planner
 * (or operator) does not specify one. Set to 1 because:
 *
 *   - Most transient failures (timeout, provider quota, single-shot
 *     subprocess crash) clear on a second attempt.
 *   - Doubling the wall-clock for a step that already failed is the
 *     worst-case visible to a watching user; retrying twice (=3 total
 *     attempts) before falling back is rarely worth the wait.
 *
 * Non-delegate strategies default to 0 — preserves current behaviour
 * for `llm-reasoning`, `direct-tool`, etc. unless the planner opts in.
 */
export const DEFAULT_DELEGATE_RETRY_BUDGET = 1;

export interface WorkflowStep {
  id: string;
  description: string;
  /**
   * Concrete shell command for `direct-tool` steps. Required (planner-side)
   * when `strategy === 'direct-tool'` so the executor never has to guess
   * a command from a natural-language description. Falls back to
   * `description` for backward-compatible legacy plans.
   */
  command?: string;
  strategy: WorkflowStepStrategy;
  dependencies: string[];
  inputs: Record<string, string>;
  expectedOutput: string;
  budgetFraction: number;
  /**
   * Optional persona assignment for `delegate-sub-agent` steps. Mirrors the
   * Zod schema field so TypeScript callers see the same shape `WorkflowPlanSchema.parse`
   * produces. Phase-13 A1 enforcement at the executor overrides this with the
   * canonical Verifier persona when a verify-style step delegates from a
   * code-mutation parent — see `selectVerifierForDelegation`.
   *
   * Branded `PersonaId` (lowercase ASCII slug). Validated at the planner
   * boundary by `WorkflowStepSchema` and `sanitizeDelegateAgentIds`; the
   * branded type prevents arbitrary strings (LLM hallucinations, manual
   * overrides) from sneaking past type-checking into the executor.
   */
  agentId?: PersonaId;
  fallbackStrategy?: WorkflowStepStrategy;
  /**
   * Provenance of `fallbackStrategy` (A8). When the planner emits an
   * explicit fallback we keep it as `'planner'`. When the deterministic
   * post-parse normalizer adds one (single delegate-sub-agent step with
   * no fallback), it sets `'auto-normalizer'`. Used by the executor to
   * stamp the `workflow:step_fallback` event so dashboards can tell apart
   * "the planner thought ahead" from "Vinyan's safety net kicked in".
   */
  fallbackOrigin?: 'planner' | 'auto-normalizer';
  /**
   * Bounded number of retry attempts for this step BEFORE the fallback
   * strategy runs. `0` preserves the legacy single-attempt behaviour;
   * `n > 0` means the executor may invoke the primary strategy up to
   * `1 + n` total times when the failure is classified as transient.
   *
   * Hard-capped by {@link MAX_STEP_RETRY_BUDGET}. Defaults applied by
   * the post-parse normalizer:
   *   - `delegate-sub-agent` → {@link DEFAULT_DELEGATE_RETRY_BUDGET}
   *   - everything else      → 0 (unchanged behaviour)
   *
   * Permanent failures (invalid config, missing tool, contract violation,
   * empty response from a clean provider call) skip retry — see
   * `isRetryableDelegateFailure` in `workflow-executor.ts`.
   */
  retryBudget?: number;
}

/**
 * First-class workflow concept for multi-agent collaboration. When a
 * `WorkflowPlan` carries a `CollaborationBlock`, the executor runs the
 * named primary steps in **parallel rounds** (rebuttal-aware), passing
 * each participant the prior rounds' peer transcripts as context, then
 * dispatches the optional integrator step to synthesize a final answer.
 *
 * This collapses what used to be a fork in the core loop (collaboration
 * runner vs. workflow executor) into a single execution path: the
 * workflow plan natively expresses "N agents debating M rounds" without
 * a parallel runtime.
 *
 * Step cardinality. The plan keeps **one step per primary participant**
 * (NOT one per (participant, round) pair). The rounds loop is internal
 * to the executor — UI surfaces see one card per agent that animates
 * across rounds. Step ids referenced here MUST exist in `plan.steps` and
 * carry `strategy='delegate-sub-agent'`. The integrator step (when set)
 * MUST carry `strategy='llm-reasoning'` and `dependencies` covering
 * every primary.
 */
export interface CollaborationBlock {
  /** Total rounds = 1 (initial) + rebuttalRounds. ≥1, capped by `MAX_COLLABORATION_ROUNDS`. */
  rounds: number;
  /**
   * Multi-agent rendering mode. The executor and stage manifest both read
   * this; the synthesizer applies competition-verdict parsing only when
   * `groupMode='competition'`.
   */
  groupMode: 'parallel' | 'comparison' | 'debate' | 'competition';
  /** Step ids whose strategy='delegate-sub-agent' make up the participant pool. */
  primaryStepIds: string[];
  /** Optional integrator step id (strategy='llm-reasoning'). Depends on every primary. */
  integratorStepId?: string;
  /** When true, integrator output is parsed for trailing `{winner, reasoning, scores}` JSON. */
  emitCompetitionVerdict: boolean;
  /**
   * True when rebuttal rounds > 0 — primaries see prior rounds' peer
   * transcripts. False on parallel-answer mode where each round is
   * independent (no shared discussion).
   */
  sharedDiscussion: boolean;
}

/**
 * Maximum collaboration rounds. Hard cap to bound dispatch fan-out
 * (rounds × participants × LLM latency). Mirrors the intent parser's
 * `MAX_REBUTTAL_ROUNDS = 5`, with +1 for the initial round.
 */
export const MAX_COLLABORATION_ROUNDS = 6;

export interface WorkflowPlan {
  goal: string;
  steps: WorkflowStep[];
  synthesisPrompt: string;
  /**
   * Optional first-class collaboration metadata. Set by the planner when
   * a `CollaborationDirective` is supplied (replaces the legacy
   * collaboration-runner fork). Absent for ordinary single-agent or
   * non-collaboration plans.
   */
  collaborationBlock?: CollaborationBlock;
}

export interface WorkflowStepResult {
  stepId: string;
  status: 'completed' | 'failed' | 'skipped';
  output: string;
  tokensConsumed: number;
  durationMs: number;
  strategyUsed: WorkflowStepStrategy;
  /**
   * Resolved agent persona that ran this step (for `delegate-sub-agent`).
   * Set by the executor after merging A1-verifier override and planner-
   * assigned `step.agentId`. Lets the UI render "step3 was answered by
   * `architect`" without joining to the trace store. Undefined for
   * non-delegate steps or when the executor inherits the default agent.
   *
   * Branded `PersonaId` so result consumers see the same type as the
   * planner-side `WorkflowStep.agentId`.
   */
  agentId?: PersonaId;
  /**
   * Sub-task ID for `delegate-sub-agent` steps — `${parent.id}-delegate-${step.id}`.
   * Enables UI drill-down: "open the child trace for this delegate".
   */
  subTaskId?: string;
  /**
   * Set to `true` by the executor when the step's primary strategy
   * failed and `fallbackStrategy` ran in its place. Consumers (the
   * deterministic aggregator, the partial-failure preview, the chat
   * UI's plan surface) MUST read this and refuse to attribute the
   * output to the planner-assigned `step.agentId` — otherwise a
   * generic LLM fallback's answer gets rendered under the requested
   * persona's name (A2 honesty violation). Pairs with
   * `WorkflowStepResult.agentId` being cleared on the same path.
   */
  fallbackUsed?: boolean;
}

export interface WorkflowResult {
  status: 'completed' | 'failed' | 'partial';
  stepResults: WorkflowStepResult[];
  synthesizedOutput: string;
  totalTokensConsumed: number;
  totalDurationMs: number;
  /**
   * Phase 4 (multi-agent debate fix) — set by the collaboration runner
   * when an in-process clarification wait timed out. The caller (core-loop's
   * agentic-workflow branch) maps presence of this field to
   * `TaskResult.status='input-required'` + `TaskResult.clarificationNeeded`,
   * so the next user turn can answer the question and restart a fresh
   * collaboration room with the answer in the new prompt context.
   *
   * Absent for the workflow-executor path (which has its own
   * human-input step that does not surface this shape).
   */
  clarificationNeeded?: {
    participantId: string;
    participantRole: string;
    round: number;
    questions: string[];
  };
}

export const WorkflowStepSchema = z.object({
  id: z.string(),
  description: z.string(),
  command: z.string().optional(),
  strategy: z.enum([
    'full-pipeline',
    'direct-tool',
    'knowledge-query',
    'llm-reasoning',
    'delegate-sub-agent',
    'human-input',
    'external-coding-cli',
  ]),
  dependencies: z.array(z.string()).default([]),
  inputs: z.record(z.string(), z.string()).default({}),
  expectedOutput: z.string().default(''),
  budgetFraction: z.number().min(0).max(1).default(0.2),
  /**
   * Optional agent assignment for `delegate-sub-agent` steps. When set, the
   * sub-task runs under the specified persona (e.g. 'developer', 'architect')
   * instead of falling through to the default `coordinator`. Required for
   * "have N agents X" workflows where each step must run under a distinct
   * persona — without it every delegate goes to the same default agent and
   * the workflow degenerates into one model role-playing N personas.
   *
   * Schema validates the PersonaId shape (lowercase ASCII slug, 1-64
   * chars) and brands the survivor. A planner-emitted id that fails the
   * shape check gets dropped by `WorkflowPlanSchema.parse` rather than
   * silently flowing into the executor as a bare string.
   */
  agentId: z
    .string()
    .refine(isPersonaIdShape, 'invalid PersonaId shape — must match /^[a-z][a-z0-9-]{0,63}$/')
    .transform((v) => v as PersonaId)
    .optional(),
  fallbackStrategy: z
    .enum([
      'full-pipeline',
      'direct-tool',
      'knowledge-query',
      'llm-reasoning',
      'delegate-sub-agent',
      'human-input',
      'external-coding-cli',
    ])
    .optional(),
  fallbackOrigin: z.enum(['planner', 'auto-normalizer']).optional(),
  /**
   * Step-level retry budget (Q1). Optional — defaults applied by the
   * post-parse normalizer. Clamped to `[0, MAX_STEP_RETRY_BUDGET]` so a
   * planner that emits a too-large value is silently capped instead of
   * letting a runaway LLM saturate the parent task's budget.
   */
  retryBudget: z
    .number()
    .int()
    .min(0)
    .max(MAX_STEP_RETRY_BUDGET)
    .optional(),
});

export const CollaborationBlockSchema = z.object({
  rounds: z.number().int().min(1).max(MAX_COLLABORATION_ROUNDS),
  groupMode: z.enum(['parallel', 'comparison', 'debate', 'competition']),
  primaryStepIds: z.array(z.string()).min(1),
  integratorStepId: z.string().optional(),
  emitCompetitionVerdict: z.boolean().default(false),
  sharedDiscussion: z.boolean().default(false),
});

export const WorkflowPlanSchema = z.object({
  goal: z.string(),
  steps: z.array(WorkflowStepSchema).min(1),
  synthesisPrompt: z.string().default('Combine the results of all steps into a coherent response.'),
  collaborationBlock: CollaborationBlockSchema.optional(),
});
