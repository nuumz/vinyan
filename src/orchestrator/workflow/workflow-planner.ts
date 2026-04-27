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
import type { Turn } from '../types.ts';
import { buildKnowledgeContext, type KnowledgeContextDeps } from './knowledge-context.ts';
import { formatSessionTranscript } from './session-transcript.ts';
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
  /**
   * Recent session turns (oldest → newest) so the planner can produce a plan
   * that continues / extends prior assistant output rather than restarting
   * from scratch on follow-up turns ("write chapter 2", "refine that"). When
   * empty or omitted the planner sees the goal alone — same as the original
   * single-turn behaviour.
   */
  sessionTurns?: Turn[];
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
- "direct-tool": single shell command or file read — INCLUDING filesystem inspection (ls/find/cat single file/grep), checking running processes (ps/lsof), and any goal asking to inspect, list, read, or run something on the user's machine. When the goal asks for filesystem/shell information, the workflow MUST start with a \`direct-tool\` step that produces the actual data; a subsequent \`llm-reasoning\` step can analyze that output.
- "knowledge-query": lookup facts, prior approaches, or codebase structure
- "llm-reasoning": analysis, summarization, decision-making (no side effects). Do NOT use this when the user asked for filesystem/shell data — the LLM cannot see the user's machine; pair it with a \`direct-tool\` step first.
- "delegate-sub-agent": complex sub-tasks that need their own planning cycle
- "human-input": when you genuinely cannot proceed without user clarification

Worked examples for filesystem / shell goals:
- Goal: "list files in ~/Desktop" / "ตรวจสอบไฟล์ ~/Desktop/" → step1 strategy='direct-tool', description='ls -la ~/Desktop', step2 strategy='llm-reasoning' if the user wants analysis on top of the listing.
- Goal: "show contents of src/foo.ts" / "ดู src/foo.ts" → step1 strategy='direct-tool', description='cat src/foo.ts'.
- Goal: "ตรวจสอบว่า npm test ผ่านมั้ย" → step1 strategy='direct-tool', description='npm test'.
- Never invent the contents of a file/directory in \`llm-reasoning\`; always read it first via \`direct-tool\`.

Creative writing rules:
- For novel, fiction, book, webtoon, story, plot, chapter, or prose work, "write" means author creative text, not write code.
- Internal creative roles are routing hints, not user-facing instructions. Step descriptions should describe the work (brief, plot options, structure, draft prose, edit, critique) rather than telling the user to contact or wait for a named internal role.
- If the plan delegates internally, the final synthesis must present the result or the necessary clarification questions to the user; do not leak handoff mechanics.
- Do NOT use system-designer, ts-coder, test-coder, full-pipeline, direct-tool, code mutation, tests, or implementation steps unless the user explicitly asks for software/code.

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
  // Prior conversation block — placed BEFORE intent analysis / constraints so
  // the planner reads it as the framing for the goal rather than a footnote.
  // The transcript helper caps length aggressively to keep the planner's
  // input budget intact.
  const transcript = formatSessionTranscript(opts.sessionTurns);
  if (transcript) {
    userPrompt +=
      '\n\nPrior conversation in this session (oldest → newest). The current ' +
      'goal above continues from these turns; design the plan to extend or ' +
      'build on prior assistant output rather than restarting from scratch:\n' +
      transcript;
  }
  if (opts.intentWorkflowPrompt) {
    userPrompt += `\n\nIntent analysis: ${opts.intentWorkflowPrompt}`;
  }
  if (opts.targetFiles?.length) {
    userPrompt += `\nTarget files: ${opts.targetFiles.join(', ')}`;
  }
  if (opts.constraints?.length) {
    // Strip orchestrator-internal prefixes — workflow planner should only see
    // user intent, not JSON payloads from other pipeline stages.
    const { userConstraintsOnly } = await import('../constraints/pipeline-constraints.ts');
    const userCs = userConstraintsOnly(opts.constraints);
    if (userCs.length > 0) {
      userPrompt += `\n\nConstraints:\n${userCs.map((c) => `- ${c}`).join('\n')}`;
    }
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

      const cleaned = response.content
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '');
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
