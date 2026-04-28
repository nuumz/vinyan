/**
 * Workflow types — data model for the self-orchestrating agent's
 * multi-step workflow planning and execution.
 *
 * A workflow is a DAG of steps, each with its own execution strategy.
 * The Workflow Planner generates this from a high-level goal; the
 * Workflow Executor dispatches each step to the appropriate subsystem.
 */
import { z } from 'zod/v4';

export type WorkflowStepStrategy =
  | 'full-pipeline'
  | 'direct-tool'
  | 'knowledge-query'
  | 'llm-reasoning'
  | 'delegate-sub-agent'
  | 'human-input';

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
   */
  agentId?: string;
  fallbackStrategy?: WorkflowStepStrategy;
}

export interface WorkflowPlan {
  goal: string;
  steps: WorkflowStep[];
  synthesisPrompt: string;
}

export interface WorkflowStepResult {
  stepId: string;
  status: 'completed' | 'failed' | 'skipped';
  output: string;
  tokensConsumed: number;
  durationMs: number;
  strategyUsed: WorkflowStepStrategy;
}

export interface WorkflowResult {
  status: 'completed' | 'failed' | 'partial';
  stepResults: WorkflowStepResult[];
  synthesizedOutput: string;
  totalTokensConsumed: number;
  totalDurationMs: number;
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
   */
  agentId: z.string().optional(),
  fallbackStrategy: z
    .enum([
      'full-pipeline',
      'direct-tool',
      'knowledge-query',
      'llm-reasoning',
      'delegate-sub-agent',
      'human-input',
    ])
    .optional(),
});

export const WorkflowPlanSchema = z.object({
  goal: z.string(),
  steps: z.array(WorkflowStepSchema).min(1),
  synthesisPrompt: z.string().default('Combine the results of all steps into a coherent response.'),
});
