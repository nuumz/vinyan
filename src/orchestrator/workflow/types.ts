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
  strategy: WorkflowStepStrategy;
  dependencies: string[];
  inputs: Record<string, string>;
  expectedOutput: string;
  budgetFraction: number;
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
