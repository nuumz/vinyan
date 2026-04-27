import { describe, expect, test } from 'bun:test';
import type { TaskInput } from '../../../src/orchestrator/types.ts';
import { executeWorkflow } from '../../../src/orchestrator/workflow/workflow-executor.ts';

function makeInput(goal = 'test goal'): TaskInput {
  return {
    id: 'task-wf-test',
    source: 'cli',
    goal,
    taskType: 'code',
    budget: { maxTokens: 10_000, maxDurationMs: 60_000, maxRetries: 1 },
  };
}

describe('executeWorkflow', () => {
  test('no LLM → fallback plan with single llm-reasoning step → fails gracefully', async () => {
    const result = await executeWorkflow(makeInput(), {});
    // Without llmRegistry, planner produces a fallback single-step plan
    // with llm-reasoning strategy which also needs a provider, so it fails.
    expect(result.status).toBe('partial');
    expect(result.stepResults).toHaveLength(1);
    expect(result.stepResults[0]!.strategyUsed).toBe('llm-reasoning');
  });

  test('with mock LLM → planner + executor + synthesizer work end-to-end', async () => {
    let plannerCalled = false;
    let stepLLMCalled = false;
    let synthesizerCalled = false;
    const deltas: Array<{ event: string; payload: unknown }> = [];
    const streamTimeouts: number[] = [];

    const validPlan = JSON.stringify({
      goal: 'analyze code',
      steps: [
        { id: 'step1', description: 'gather info', strategy: 'llm-reasoning', budgetFraction: 0.5 },
        { id: 'step2', description: 'summarize', strategy: 'llm-reasoning', dependencies: ['step1'], inputs: { data: '$step1.result' }, budgetFraction: 0.5 },
      ],
      synthesisPrompt: 'Combine step1 and step2.',
    });

    let callCount = 0;
    const mockProvider = {
      id: 'mock',
      generate: async (req: { systemPrompt: string; userPrompt: string }) => {
        callCount++;
        if (req.systemPrompt.includes('workflow planner')) {
          plannerCalled = true;
          return { content: validPlan, tokensUsed: { input: 50, output: 100 } };
        }
        if (req.systemPrompt.includes('Synthesize')) {
          synthesizerCalled = true;
          return { content: 'Final synthesis', tokensUsed: { input: 30, output: 30 } };
        }
        stepLLMCalled = true;
        return { content: `Result for: ${req.userPrompt.slice(0, 50)}`, tokensUsed: { input: 20, output: 40 } };
      },
      generateStream: async (
        req: { systemPrompt: string; userPrompt: string; timeoutMs?: number },
        onDelta: (delta: { text: string }) => void,
      ) => {
        if (req.systemPrompt.includes('workflow planner')) {
          return mockProvider.generate(req);
        }
        if (req.timeoutMs !== undefined) streamTimeouts.push(req.timeoutMs);
        const response = await mockProvider.generate(req);
        onDelta({ text: response.content });
        return response;
      },
    };
    const bus = {
      emit: (event: string, payload: unknown) => {
        if (event === 'llm:stream_delta') deltas.push({ event, payload });
      },
    };

    const result = await executeWorkflow(makeInput('analyze code'), {
      llmRegistry: {
        selectByTier: () => mockProvider,
      } as any,
      bus: bus as any,
    });

    expect(result.status).toBe('completed');
    expect(result.stepResults).toHaveLength(2);
    expect(result.stepResults[0]!.status).toBe('completed');
    expect(result.stepResults[1]!.status).toBe('completed');
    expect(result.synthesizedOutput).toBe('Final synthesis');
    expect(result.totalTokensConsumed).toBeGreaterThan(0);
    expect(plannerCalled).toBe(true);
    expect(stepLLMCalled).toBe(true);
    expect(synthesizerCalled).toBe(true);
    expect(deltas.some((d) => d.event === 'llm:stream_delta')).toBe(true);
    expect(deltas.every((d) => (d.payload as { taskId?: string }).taskId === 'task-wf-test')).toBe(true);
    expect(streamTimeouts.length).toBeGreaterThan(0);
    expect(streamTimeouts.every((timeoutMs) => timeoutMs >= 120_000)).toBe(true);
  });

  test('emits agent:plan_update on every step state transition', async () => {
    // The chat UI's reducer keys off `agent:plan_update` to mark which step
    // is currently running. Without per-transition emission the plan
    // checklist freezes at the initial snapshot.
    const validPlan = JSON.stringify({
      goal: 'two-step run',
      steps: [
        { id: 'step1', description: 's1', strategy: 'llm-reasoning', budgetFraction: 0.5 },
        {
          id: 'step2',
          description: 's2',
          strategy: 'llm-reasoning',
          dependencies: ['step1'],
          budgetFraction: 0.5,
        },
      ],
      synthesisPrompt: 'Combine.',
    });

    const mockProvider = {
      id: 'mock',
      generate: async (req: { systemPrompt: string }) => {
        if (req.systemPrompt.includes('workflow planner')) {
          return { content: validPlan, tokensUsed: { input: 10, output: 10 } };
        }
        if (req.systemPrompt.includes('Synthesize')) {
          return { content: 'OK', tokensUsed: { input: 10, output: 10 } };
        }
        return { content: 'step output', tokensUsed: { input: 10, output: 10 } };
      },
      generateStream: async (
        req: { systemPrompt: string; userPrompt: string },
        onDelta: (d: { text: string }) => void,
      ) => {
        const r = await mockProvider.generate(req);
        onDelta({ text: r.content });
        return r;
      },
    };

    type PlanUpdatePayload = {
      taskId: string;
      steps: Array<{ id: string; status: string }>;
    };
    const planUpdates: PlanUpdatePayload[] = [];
    const bus = {
      emit: (event: string, payload: unknown) => {
        if (event === 'agent:plan_update') {
          planUpdates.push(payload as PlanUpdatePayload);
        }
      },
    };

    const result = await executeWorkflow(makeInput('two-step run'), {
      llmRegistry: { selectByTier: () => mockProvider } as any,
      bus: bus as any,
    });

    expect(result.status).toBe('completed');
    // Expected sequence: initial seed (all pending) → step1 running →
    // step1 done → step2 running → step2 done. That's 5 emissions for a
    // 2-step sequential plan.
    expect(planUpdates.length).toBeGreaterThanOrEqual(5);
    expect(planUpdates[0]!.steps.every((s) => s.status === 'pending')).toBe(true);
    const finalSnapshot = planUpdates[planUpdates.length - 1]!;
    expect(finalSnapshot.steps.every((s) => s.status === 'done')).toBe(true);
    // Somewhere in between we should see step1 running before step2 starts.
    const sawStep1Running = planUpdates.some(
      (u) =>
        u.steps.find((s) => s.id === 'step1')?.status === 'running' &&
        u.steps.find((s) => s.id === 'step2')?.status === 'pending',
    );
    expect(sawStep1Running).toBe(true);
  });

  test('step with fallback strategy retries on failure', async () => {
    const plan = JSON.stringify({
      goal: 'test fallback',
      steps: [{
        id: 'step1',
        description: 'try tool then reason',
        strategy: 'direct-tool',
        fallbackStrategy: 'llm-reasoning',
        budgetFraction: 1.0,
      }],
      synthesisPrompt: 'Return step1.',
    });

    const mockProvider = {
      id: 'mock',
      generate: async (req: { systemPrompt: string }) => {
        if (req.systemPrompt.includes('workflow planner')) {
          return { content: plan, tokensUsed: { input: 10, output: 20 } };
        }
        return { content: 'LLM fallback worked', tokensUsed: { input: 10, output: 10 } };
      },
    };

    const result = await executeWorkflow(makeInput('test fallback'), {
      llmRegistry: { selectByTier: () => mockProvider } as any,
      // No toolExecutor → direct-tool fails → falls back to llm-reasoning
    });

    expect(result.status).toBe('completed');
    expect(result.stepResults[0]!.strategyUsed).toBe('llm-reasoning');
    expect(result.stepResults[0]!.output).toContain('LLM fallback worked');
  });

  test('knowledge-query step returns world graph context', async () => {
    const plan = JSON.stringify({
      goal: 'lookup',
      steps: [{ id: 'step1', description: 'query knowledge', strategy: 'knowledge-query', budgetFraction: 1.0 }],
      synthesisPrompt: 'Return step1.',
    });

    const mockProvider = {
      id: 'mock',
      generate: async () => ({ content: plan, tokensUsed: { input: 10, output: 10 } }),
    };

    const result = await executeWorkflow(makeInput('lookup'), {
      llmRegistry: { selectByTier: () => mockProvider } as any,
      worldGraph: {
        queryFacts: () => [{ target: 'src/auth.ts', pattern: 'exports AuthService', confidence: 0.9 }],
      } as any,
    });

    expect(result.status).toBe('completed');
    expect(result.stepResults[0]!.strategyUsed).toBe('knowledge-query');
  });

  test('delegate-sub-agent step calls executeTask recursively', async () => {
    let delegated = false;
    const plan = JSON.stringify({
      goal: 'delegate test',
      steps: [{ id: 'step1', description: 'do sub-task', strategy: 'delegate-sub-agent', budgetFraction: 0.5 }],
      synthesisPrompt: 'Return step1.',
    });

    const result = await executeWorkflow(makeInput('delegate test'), {
      llmRegistry: {
        selectByTier: () => ({
          id: 'mock',
          generate: async () => ({ content: plan, tokensUsed: { input: 10, output: 10 } }),
        }),
      } as any,
      executeTask: async (subInput) => {
        delegated = true;
        expect(subInput.id).toContain('delegate-step1');
        return {
          id: subInput.id,
          status: 'completed',
          mutations: [],
          trace: { id: 'tr', taskId: subInput.id, timestamp: 0, routingLevel: 2, approach: 'sub', oracleVerdicts: {}, modelUsed: 'x', tokensConsumed: 50, durationMs: 10, outcome: 'success', affectedFiles: [] },
          answer: 'Sub-agent result',
        };
      },
    });

    expect(delegated).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.stepResults[0]!.output).toBe('Sub-agent result');
  });
});
