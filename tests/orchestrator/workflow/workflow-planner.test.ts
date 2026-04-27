import { describe, expect, test } from 'bun:test';
import { planWorkflow, type WorkflowPlannerDeps } from '../../../src/orchestrator/workflow/workflow-planner.ts';

function makeDeps(override?: Partial<WorkflowPlannerDeps>): WorkflowPlannerDeps {
  return {
    knowledgeDeps: {},
    ...override,
  };
}

describe('planWorkflow', () => {
  test('no LLM → fallback single-step llm-reasoning plan', async () => {
    const plan = await planWorkflow(makeDeps(), { goal: 'summarize the auth module' });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.strategy).toBe('llm-reasoning');
    expect(plan.goal).toBe('summarize the auth module');
  });

  test('LLM returns valid JSON → parsed as WorkflowPlan', async () => {
    const validPlan = JSON.stringify({
      goal: 'fix bug in auth',
      steps: [
        {
          id: 'step1',
          description: 'read auth files',
          strategy: 'knowledge-query',
          dependencies: [],
          inputs: {},
          expectedOutput: 'file contents',
          budgetFraction: 0.2,
        },
        {
          id: 'step2',
          description: 'fix the bug',
          strategy: 'full-pipeline',
          dependencies: ['step1'],
          inputs: { context: '$step1.result' },
          expectedOutput: 'fixed code',
          budgetFraction: 0.6,
        },
        {
          id: 'step3',
          description: 'summarize changes',
          strategy: 'llm-reasoning',
          dependencies: ['step2'],
          inputs: { changes: '$step2.result' },
          expectedOutput: 'summary',
          budgetFraction: 0.2,
        },
      ],
      synthesisPrompt: 'Combine the fix and summary.',
    });

    const deps = makeDeps({
      llmRegistry: {
        selectByTier: () => ({
          id: 'mock',
          generate: async () => ({ content: validPlan, tokensUsed: { input: 100, output: 200 } }),
        }),
      } as any,
    });

    const plan = await planWorkflow(deps, { goal: 'fix bug in auth' });
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[0]!.strategy).toBe('knowledge-query');
    expect(plan.steps[1]!.strategy).toBe('full-pipeline');
    expect(plan.steps[2]!.strategy).toBe('llm-reasoning');
    expect(plan.steps[1]!.dependencies).toContain('step1');
  });

  test('LLM returns invalid JSON → fallback plan', async () => {
    const deps = makeDeps({
      llmRegistry: {
        selectByTier: () => ({
          id: 'mock',
          generate: async () => ({ content: 'not json at all', tokensUsed: { input: 10, output: 10 } }),
        }),
      } as any,
    });

    const plan = await planWorkflow(deps, { goal: 'do a thing' });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.strategy).toBe('llm-reasoning');
  });

  test('creative guidance is sent through the planner prompt without overriding the LLM plan', async () => {
    let capturedSystemPrompt = '';
    const creativePlan = JSON.stringify({
      goal: 'อยากให้ช่วยเขียนนิยายลงขายในเว็บตูนสักเรื่อง',
      steps: [
        {
          id: 'step1',
          description: 'creative-director coordinates the writing team',
          strategy: 'llm-reasoning',
        },
        {
          id: 'step2',
          description: 'novelist drafts the first chapter',
          strategy: 'llm-reasoning',
        },
      ],
      synthesisPrompt: 'Combine creative outputs.',
    });
    const deps = makeDeps({
      llmRegistry: {
        selectByTier: () => ({
          id: 'mock',
          generate: async (request: { systemPrompt: string }) => {
            capturedSystemPrompt = request.systemPrompt;
            return { content: creativePlan, tokensUsed: { input: 100, output: 200 } };
          },
        }),
      } as any,
    });

    const plan = await planWorkflow(deps, { goal: 'อยากให้ช่วยเขียนนิยายลงขายในเว็บตูนสักเรื่อง' });
    const descriptions = plan.steps.map((step) => step.description).join('\n');

    expect(capturedSystemPrompt).toContain('Creative writing rules');
    expect(capturedSystemPrompt).toContain('write" means author creative text, not write code');
    expect(descriptions).toContain('creative-director');
    expect(descriptions).toContain('novelist');
    expect(plan.steps).toHaveLength(2);
  });

  test('LLM returns wrapped in code fences → still parsed', async () => {
    const validPlan = JSON.stringify({
      goal: 'test',
      steps: [{ id: 's1', description: 'do it', strategy: 'llm-reasoning' }],
      synthesisPrompt: 'Return s1 directly.',
    });

    const deps = makeDeps({
      llmRegistry: {
        selectByTier: () => ({
          id: 'mock',
          generate: async () => ({
            content: `\`\`\`json\n${validPlan}\n\`\`\``,
            tokensUsed: { input: 10, output: 20 },
          }),
        }),
      } as any,
    });

    const plan = await planWorkflow(deps, { goal: 'test' });
    expect(plan.steps).toHaveLength(1);
  });
});
