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
        // Synthesizer prompt anchors on "final answer for the user" — the
        // distinctive phrase in workflow-executor's buildResult system prompt.
        if (req.systemPrompt.includes('final answer for the user')) {
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

  test('llm-reasoning step user prompt includes prior session turns when present', async () => {
    // Multi-turn coherence: when the same session has prior turns (e.g. user
    // wrote "เขียนนิทาน 1 บท" earlier), the per-step LLM call MUST see those
    // turns so a follow-up "เขียนต่อบทที่ 2" continues the same dragon story
    // rather than starting fresh.
    const validPlan = JSON.stringify({
      goal: 'continue chapter 2',
      steps: [
        { id: 'step1', description: 'draft chapter 2', strategy: 'llm-reasoning', budgetFraction: 1.0 },
      ],
      synthesisPrompt: 'Return step1.',
    });
    let stepUserPromptCaptured = '';
    const mockProvider = {
      id: 'mock',
      generate: async (req: { systemPrompt: string; userPrompt: string }) => {
        if (req.systemPrompt.includes('workflow planner')) {
          return { content: validPlan, tokensUsed: { input: 10, output: 10 } };
        }
        // First non-planner call is the step. Capture its user prompt.
        if (!stepUserPromptCaptured) stepUserPromptCaptured = req.userPrompt;
        return { content: 'ok', tokensUsed: { input: 10, output: 10 } };
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
    const sessionTurns = [
      {
        id: 'u0',
        sessionId: 's1',
        seq: 0,
        role: 'user' as const,
        blocks: [{ type: 'text' as const, text: 'เขียนนิทาน 1 บท เกี่ยวกับมังกรน้อย' }],
        tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        createdAt: 1,
      },
      {
        id: 'a1',
        sessionId: 's1',
        seq: 1,
        role: 'assistant' as const,
        blocks: [
          {
            type: 'text' as const,
            text: 'บทที่ 1: มังกรน้อยตื่นมาเช้าวันนี้พบฟองสบู่สีรุ้ง...',
          },
        ],
        tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        createdAt: 2,
      },
    ];
    await executeWorkflow(makeInput('continue chapter 2'), {
      llmRegistry: { selectByTier: () => mockProvider } as any,
      sessionTurns,
    });
    expect(stepUserPromptCaptured).toContain('Prior conversation');
    expect(stepUserPromptCaptured).toContain('มังกรน้อย');
    expect(stepUserPromptCaptured).toContain('ฟองสบู่');
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

  test('records a failed approach when at least one step fails', async () => {
    // 2-step plan: step1 = direct-tool (no toolExecutor wired → fails),
    // step2 depends on step1 (so it never runs / completes as 'failed' with
    // dependencies). That gives us a failed step → workflow status='partial'
    // → recordFailedApproach should fire with failureOracle='workflow-step-failed'.
    const plan = JSON.stringify({
      goal: 'inspect repo state and analyze',
      steps: [
        { id: 'step1', description: 'ls -la /tmp', strategy: 'direct-tool', budgetFraction: 0.5 },
        {
          id: 'step2',
          description: 'analyze the listing',
          strategy: 'llm-reasoning',
          dependencies: ['step1'],
          inputs: { listing: '$step1.result' },
          budgetFraction: 0.5,
        },
      ],
      synthesisPrompt: 'Combine.',
    });
    const mockProvider = {
      id: 'mock',
      generate: async (req: { systemPrompt: string }) => {
        if (req.systemPrompt.includes('workflow planner')) {
          return { content: plan, tokensUsed: { input: 10, output: 10 } };
        }
        return { content: 'analyzed', tokensUsed: { input: 5, output: 5 } };
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
    const recorded: Array<unknown> = [];
    const agentMemory = {
      recordFailedApproach: async (entry: unknown) => {
        recorded.push(entry);
      },
    } as any;
    await executeWorkflow(makeInput('inspect repo state and analyze'), {
      llmRegistry: { selectByTier: () => mockProvider } as any,
      // No toolExecutor wired → step1 (direct-tool) fails.
      agentMemory,
    });
    expect(recorded.length).toBeGreaterThanOrEqual(1);
    const entry = recorded[0] as {
      taskId: string;
      failureOracle: string;
      routingLevel: number;
      approach: string;
    };
    expect(entry.failureOracle).toBe('workflow-step-failed');
    expect(entry.routingLevel).toBe(2);
    expect(entry.approach).toContain('agentic-workflow');
    expect(entry.approach).toMatch(/failed:step\d+/);
  });

  test('direct-tool prefers explicit `command` over `description`', async () => {
    // Capture the command actually dispatched to the tool executor so we can
    // verify the executor uses `step.command` instead of the natural-language
    // description (which would error as a shell command).
    let capturedCommand: string | null = null as string | null;
    const toolExecutor = {
      executeProposedTools: async (
        calls: Array<{ id: string; tool: string; parameters: { command: string } }>,
      ) => {
        capturedCommand = calls[0]!.parameters.command;
        return [{ id: calls[0]!.id, status: 'success' as const, output: 'a.txt\nb.txt\n' }];
      },
    };
    const plan = JSON.stringify({
      goal: 'list files',
      steps: [
        {
          id: 'step1',
          description: 'List files in ~/Desktop',
          command: 'ls -la ~/Desktop',
          strategy: 'direct-tool',
          budgetFraction: 1.0,
        },
      ],
      synthesisPrompt: 'Return step1.',
    });
    const mockProvider = {
      id: 'mock',
      generate: async () => ({ content: plan, tokensUsed: { input: 5, output: 5 } }),
    };

    const result = await executeWorkflow(makeInput('list files'), {
      llmRegistry: { selectByTier: () => mockProvider } as any,
      toolExecutor: toolExecutor as any,
    });

    expect(capturedCommand).toBe('ls -la ~/Desktop');
    expect(result.stepResults[0]!.status).toBe('completed');
    // Multi-line stdout must be wrapped in a fenced code block so the chat
    // UI preserves columns instead of collapsing newlines.
    expect(result.stepResults[0]!.output.startsWith('```')).toBe(true);
    expect(result.stepResults[0]!.output).toContain('a.txt');
  });

  test('direct-tool falls back to `description` when `command` is absent (legacy plans)', async () => {
    let capturedCommand: string | null = null as string | null;
    const toolExecutor = {
      executeProposedTools: async (
        calls: Array<{ id: string; tool: string; parameters: { command: string } }>,
      ) => {
        capturedCommand = calls[0]!.parameters.command;
        return [{ id: calls[0]!.id, status: 'success' as const, output: 'ok' }];
      },
    };
    const plan = JSON.stringify({
      goal: 'echo',
      steps: [{ id: 'step1', description: 'echo legacy', strategy: 'direct-tool', budgetFraction: 1.0 }],
      synthesisPrompt: 'Return step1.',
    });
    const mockProvider = {
      id: 'mock',
      generate: async () => ({ content: plan, tokensUsed: { input: 5, output: 5 } }),
    };

    await executeWorkflow(makeInput('echo'), {
      llmRegistry: { selectByTier: () => mockProvider } as any,
      toolExecutor: toolExecutor as any,
    });
    expect(capturedCommand).toBe('echo legacy');
  });

  test('failed dependency cascades into a skipped dependent (does not run the dependent)', async () => {
    // step1 = direct-tool that fails (no toolExecutor wired).
    // step2 depends on step1 and MUST be marked `skipped`, not executed —
    // otherwise it would silently run on missing/failed upstream data.
    let step2Executed = false;
    const plan = JSON.stringify({
      goal: 'inspect and analyze',
      steps: [
        { id: 'step1', description: 'inspect tmp', command: 'ls -la /tmp', strategy: 'direct-tool', budgetFraction: 0.5 },
        {
          id: 'step2',
          description: 'analyze',
          strategy: 'llm-reasoning',
          dependencies: ['step1'],
          inputs: { listing: '$step1.result' },
          budgetFraction: 0.5,
        },
      ],
      synthesisPrompt: 'Combine.',
    });
    const mockProvider = {
      id: 'mock',
      generate: async (req: { systemPrompt: string; userPrompt: string }) => {
        if (req.systemPrompt.includes('workflow planner')) {
          return { content: plan, tokensUsed: { input: 5, output: 5 } };
        }
        if (req.systemPrompt.includes('final answer for the user')) {
          return { content: 'final', tokensUsed: { input: 5, output: 5 } };
        }
        step2Executed = true;
        return { content: 'analyzed', tokensUsed: { input: 5, output: 5 } };
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

    const result = await executeWorkflow(makeInput('inspect and analyze'), {
      llmRegistry: { selectByTier: () => mockProvider } as any,
      // Intentionally no toolExecutor → step1 fails → step2 must skip.
    });

    expect(step2Executed).toBe(false);
    const step1 = result.stepResults.find((r) => r.stepId === 'step1')!;
    const step2 = result.stepResults.find((r) => r.stepId === 'step2')!;
    expect(step1.status).toBe('failed');
    expect(step2.status).toBe('skipped');
    expect(step2.output).toContain('step1');
    // Workflow as a whole is partial: there is no usable final step but the
    // contract still surfaces partial vs failed for the boundary test below.
    expect(result.status).toBe('partial');
  });

  test('independent step still runs when a sibling fails; workflow is partial', async () => {
    // step1 fails (no toolExecutor); step2 is independent (no deps) and
    // succeeds. The workflow must be `partial` — NOT `failed` — because we
    // produced a usable answer.
    const plan = JSON.stringify({
      goal: 'two independent things',
      steps: [
        { id: 'step1', description: 'shell', command: 'will-not-run', strategy: 'direct-tool', budgetFraction: 0.5 },
        { id: 'step2', description: 'reason', strategy: 'llm-reasoning', budgetFraction: 0.5 },
      ],
      synthesisPrompt: 'Return whichever step completed.',
    });
    const mockProvider = {
      id: 'mock',
      generate: async (req: { systemPrompt: string; userPrompt: string }) => {
        if (req.systemPrompt.includes('workflow planner')) {
          return { content: plan, tokensUsed: { input: 5, output: 5 } };
        }
        if (req.systemPrompt.includes('final answer for the user')) {
          return { content: 'final synthesis from step2', tokensUsed: { input: 5, output: 5 } };
        }
        return { content: 'step2 result', tokensUsed: { input: 5, output: 5 } };
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

    const result = await executeWorkflow(makeInput('two independent things'), {
      llmRegistry: { selectByTier: () => mockProvider } as any,
    });

    expect(result.status).toBe('partial');
    const step1 = result.stepResults.find((r) => r.stepId === 'step1')!;
    const step2 = result.stepResults.find((r) => r.stepId === 'step2')!;
    expect(step1.status).toBe('failed');
    expect(step2.status).toBe('completed');
    expect(result.synthesizedOutput).toContain('step2');
  });

  test('A2 honesty: when ALL steps fail, synthesizer is NOT called and output is a deterministic failure report', async () => {
    // Free-tier 429 incident on session 44c83a53: workflow dispatched 3
    // delegated sub-agents which all 429'd. Synthesizer LLM was given the
    // failed step outputs and confabulated the agents' answers ("จำลอง
    // สถานการณ์การแข่งขัน") instead of admitting failure. Fast-path now
    // refuses to invoke the synthesizer when zero steps succeeded — the
    // only safe output is a structured failure report.
    let synthesizerCalled = false;
    const plan = JSON.stringify({
      goal: 'two failing things',
      steps: [
        {
          id: 'step1',
          description: 'shell that cannot run',
          command: 'will-not-run',
          strategy: 'direct-tool',
          budgetFraction: 0.5,
        },
        {
          id: 'step2',
          description: 'shell that cannot run either',
          command: 'also-cannot',
          strategy: 'direct-tool',
          budgetFraction: 0.5,
        },
      ],
      synthesisPrompt: 'Combine outputs.',
    });
    const mockProvider = {
      id: 'mock',
      generate: async (req: { systemPrompt: string; userPrompt: string }) => {
        if (req.systemPrompt.includes('workflow planner')) {
          return { content: plan, tokensUsed: { input: 5, output: 5 } };
        }
        if (req.systemPrompt.includes('final answer for the user')) {
          synthesizerCalled = true;
          return { content: 'fabricated success', tokensUsed: { input: 5, output: 5 } };
        }
        return { content: 'noop', tokensUsed: { input: 5, output: 5 } };
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

    const result = await executeWorkflow(makeInput('two failing things'), {
      llmRegistry: { selectByTier: () => mockProvider } as any,
      // No toolExecutor → both direct-tool steps fail.
    });

    expect(result.status).toBe('partial');
    expect(result.stepResults.every((r) => r.status === 'failed' || r.status === 'skipped')).toBe(
      true,
    );
    // The honesty fast-path must not call the synthesizer.
    expect(synthesizerCalled).toBe(false);
    expect(result.synthesizedOutput).not.toContain('fabricated success');
    expect(result.synthesizedOutput).toMatch(/could not produce|step\(s\) failed or were skipped/i);
    expect(result.synthesizedOutput).toContain('step1');
  });

  test('A2 honesty: zero-step plan also refuses synthesis (planner produced no usable steps)', async () => {
    // Forces the executor to reach buildResult with zero stepResults by
    // returning a plan that has only one step which fails at dispatch
    // (executeTask not provided → delegate fails). Earlier version of the
    // guard required `length > 0` and let the synthesizer run on empty
    // step summaries → fabricated entire multi-agent simulation from the
    // goal alone (incident: session 46e730ed).
    let synthesizerCalled = false;
    const plan = JSON.stringify({
      goal: 'multi-agent debate',
      steps: [
        {
          id: 'step1',
          description: 'developer answers',
          strategy: 'delegate-sub-agent',
          agentId: 'developer',
          budgetFraction: 1,
        },
      ],
      synthesisPrompt: 'Combine.',
    });
    const mockProvider = {
      id: 'mock',
      generate: async (req: { systemPrompt: string }) => {
        if (req.systemPrompt.includes('workflow planner')) {
          return { content: plan, tokensUsed: { input: 5, output: 5 } };
        }
        if (req.systemPrompt.includes('final answer for the user')) {
          synthesizerCalled = true;
          return { content: 'fabricated', tokensUsed: { input: 5, output: 5 } };
        }
        return { content: 'noop', tokensUsed: { input: 5, output: 5 } };
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
    const result = await executeWorkflow(makeInput('multi-agent debate'), {
      llmRegistry: { selectByTier: () => mockProvider } as any,
      // No executeTask → delegate-sub-agent step fails at dispatch.
    });
    expect(synthesizerCalled).toBe(false);
    expect(result.synthesizedOutput).not.toContain('fabricated');
    expect(result.synthesizedOutput).toMatch(/could not produce|step\(s\) failed/i);
  });

  test('delegate-sub-agent step.agentId is plumbed through to the sub-task', async () => {
    // Multi-agent fix: planner-assigned `agentId` MUST reach the sub-task's
    // TaskInput so each delegate runs under a distinct persona. Without
    // this every delegate falls through to the default coordinator and
    // "have 3 agents debate" degenerates into one persona role-playing
    // three (incident: session 46e730ed).
    const dispatchedAgentIds: Array<string | undefined> = [];
    const plan = JSON.stringify({
      goal: 'have developer and architect debate microservices',
      steps: [
        {
          id: 'step1',
          description: 'developer perspective',
          strategy: 'delegate-sub-agent',
          agentId: 'developer',
          budgetFraction: 0.4,
        },
        {
          id: 'step2',
          description: 'architect perspective',
          strategy: 'delegate-sub-agent',
          agentId: 'architect',
          budgetFraction: 0.4,
        },
        {
          id: 'step3',
          description: 'synthesize debate',
          strategy: 'llm-reasoning',
          dependencies: ['step1', 'step2'],
          budgetFraction: 0.2,
        },
      ],
      synthesisPrompt: 'Combine.',
    });
    const mockProvider = {
      id: 'mock',
      generate: async (req: { systemPrompt: string }) => {
        if (req.systemPrompt.includes('workflow planner')) {
          return { content: plan, tokensUsed: { input: 5, output: 5 } };
        }
        if (req.systemPrompt.includes('final answer for the user')) {
          return { content: 'final', tokensUsed: { input: 5, output: 5 } };
        }
        return { content: 'reasoning result', tokensUsed: { input: 5, output: 5 } };
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
    const executeTask = async (subInput: any) => {
      dispatchedAgentIds.push(subInput.agentId);
      return {
        id: subInput.id,
        status: 'completed',
        mutations: [],
        answer: `${subInput.agentId} answer`,
        trace: { tokensConsumed: 10 },
      } as any;
    };
    const result = await executeWorkflow(
      makeInput('have developer and architect debate microservices'),
      {
        llmRegistry: { selectByTier: () => mockProvider } as any,
        executeTask,
      },
    );
    expect(result.status).toBe('completed');
    expect(dispatchedAgentIds).toContain('developer');
    expect(dispatchedAgentIds).toContain('architect');
    expect(dispatchedAgentIds.length).toBe(2);
  });

  test('honesty contract is included in the synthesizer system prompt when failures exist', async () => {
    // Mixed case: one step succeeds, one fails. Synthesizer IS invoked
    // (we still have something real to deliver) but the honesty contract
    // must be present in the system prompt and step tags must mark the
    // failed step. Without this the synthesizer can fabricate around the
    // failure (the original 429 vector at lower amplitude).
    let capturedSystemPrompt = '';
    let capturedUserPrompt = '';
    const plan = JSON.stringify({
      goal: 'mixed',
      steps: [
        {
          id: 'step1',
          description: 'shell that cannot run',
          command: 'will-not-run',
          strategy: 'direct-tool',
          budgetFraction: 0.5,
        },
        { id: 'step2', description: 'reason', strategy: 'llm-reasoning', budgetFraction: 0.5 },
      ],
      synthesisPrompt: 'Combine.',
    });
    const mockProvider = {
      id: 'mock',
      generate: async (req: { systemPrompt: string; userPrompt: string }) => {
        if (req.systemPrompt.includes('workflow planner')) {
          return { content: plan, tokensUsed: { input: 5, output: 5 } };
        }
        if (req.systemPrompt.includes('final answer for the user')) {
          capturedSystemPrompt = req.systemPrompt;
          capturedUserPrompt = req.userPrompt;
          return { content: 'final', tokensUsed: { input: 5, output: 5 } };
        }
        return { content: 'step2 result', tokensUsed: { input: 5, output: 5 } };
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

    const result = await executeWorkflow(makeInput('mixed'), {
      llmRegistry: { selectByTier: () => mockProvider } as any,
    });

    expect(result.status).toBe('partial');
    expect(capturedSystemPrompt).toContain('HONESTY CONTRACT');
    expect(capturedSystemPrompt).toMatch(/Do NOT invent|fabricat/i);
    // Failed step must be tagged so the synthesizer can apply the contract.
    expect(capturedUserPrompt).toContain('— FAILED');
    expect(capturedUserPrompt).toContain('[STEP STATUS]');
  });
});
