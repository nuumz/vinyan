/**
 * Workflow Planner — LLM-powered multi-step workflow generation.
 *
 * Given a high-level goal + knowledge context, produces a WorkflowPlan
 * (DAG of typed steps) that the Workflow Executor dispatches. Falls back
 * to a single llm-reasoning step if the LLM fails or returns invalid JSON.
 *
 * A1: the planner generates candidates; the Zod schema validates structure.
 * A3: fallback to single-step is deterministic.
 */
import type { VinyanBus } from '../../core/bus.ts';
import type { LLMProviderRegistry } from '../llm/provider-registry.ts';
import { buildKnowledgeContext, type KnowledgeContextDeps } from './knowledge-context.ts';
import { type WorkflowPlan, WorkflowPlanSchema } from './types.ts';

export interface WorkflowPlannerDeps {
  llmRegistry?: LLMProviderRegistry;
  knowledgeDeps: KnowledgeContextDeps;
  bus?: VinyanBus;
}

export interface PlannerOptions {
  goal: string;
  targetFiles?: string[];
  taskSignature?: string;
  constraints?: string[];
  acceptanceCriteria?: string[];
  intentWorkflowPrompt?: string;
}

const SYSTEM_PROMPT = `You are a workflow planner for the Vinyan autonomous agent orchestrator.

Given a high-level goal and optional context, produce a multi-step workflow as JSON.

Output ONLY valid JSON matching this schema:
{
  "goal": "string — the original goal",
  "steps": [
    {
      "id": "step1",
      "description": "what this step does",
      "strategy": "full-pipeline | direct-tool | knowledge-query | llm-reasoning | delegate-sub-agent | human-input",
      "dependencies": ["step IDs this depends on"],
      "inputs": { "key": "$stepN.result — reference to a prior step's output" },
      "expectedOutput": "what this step should produce",
      "budgetFraction": 0.2
    }
  ],
  "synthesisPrompt": "how to combine step results into a final answer"
}

Strategy selection rules:
- "full-pipeline": code changes requiring file edits + oracle verification
- "direct-tool": single shell command or file read
- "knowledge-query": lookup facts, prior approaches, or codebase structure
- "llm-reasoning": analysis, summarization, decision-making (no side effects)
- "delegate-sub-agent": complex sub-tasks that need their own planning cycle
- "human-input": when you genuinely cannot proceed without user clarification

Guidelines:
- Start with a knowledge-query step to gather context when the goal is broad
- Use llm-reasoning for synthesis and analysis steps
- Use full-pipeline only for actual code mutations
- Keep step count between 2-6 for most goals
- Budget fractions must sum to ≤ 1.0
- Each step ID must be unique (step1, step2, etc.)
- Dependencies form a DAG — no cycles`;

export async function planWorkflow(deps: WorkflowPlannerDeps, opts: PlannerOptions): Promise<WorkflowPlan> {
  const provider = deps.llmRegistry?.selectByTier('balanced') ?? deps.llmRegistry?.selectByTier('fast');
  if (!provider) return fallbackPlan(opts.goal);

  const knowledgeContext = await buildKnowledgeContext(deps.knowledgeDeps, {
    targetFiles: opts.targetFiles,
    taskSignature: opts.taskSignature,
  });

  let userPrompt = `Goal: ${opts.goal}`;
  if (opts.intentWorkflowPrompt) {
    userPrompt += `\n\nIntent analysis: ${opts.intentWorkflowPrompt}`;
  }
  if (opts.targetFiles?.length) {
    userPrompt += `\nTarget files: ${opts.targetFiles.join(', ')}`;
  }
  if (opts.constraints?.length) {
    userPrompt += `\n\nConstraints:\n${opts.constraints.map((c) => `- ${c}`).join('\n')}`;
  }
  if (opts.acceptanceCriteria?.length) {
    userPrompt += `\n\nAcceptance criteria:\n${opts.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}`;
  }
  if (knowledgeContext) {
    userPrompt += `\n\nKnowledge context (from Vinyan's memory):\n${knowledgeContext}`;
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await provider.generate({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        maxTokens: 4000,
      });

      const cleaned = response.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      const parsed = JSON.parse(cleaned);
      const plan = WorkflowPlanSchema.parse(parsed);

      deps.bus?.emit('workflow:plan_created', {
        goal: opts.goal,
        stepCount: plan.steps.length,
        strategies: plan.steps.map((s) => s.strategy),
      });

      return plan;
    } catch {
      // retry once
    }
  }

  return fallbackPlan(opts.goal);
}

function fallbackPlan(goal: string): WorkflowPlan {
  return {
    goal,
    steps: [
      {
        id: 'step1',
        description: goal,
        strategy: 'llm-reasoning',
        dependencies: [],
        inputs: {},
        expectedOutput: 'Direct response to the goal',
        budgetFraction: 1.0,
      },
    ],
    synthesisPrompt: 'Return the result of step1 directly.',
  };
}
