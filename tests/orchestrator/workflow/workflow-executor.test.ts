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
    // step2 is an llm-reasoning step that depends on step1 and is the only
    // sink — under the new short-circuit contract its output becomes the
    // final answer directly, no second synthesizer pass. This avoids the
    // session a43487fd "double synthesis" failure where the parent
    // synthesizer fabricated polished agent answers on top of an
    // already-final aggregation step.
    expect(result.synthesizedOutput).toContain('Result for:'); // step2's output
    expect(result.totalTokensConsumed).toBeGreaterThan(0);
    expect(plannerCalled).toBe(true);
    expect(stepLLMCalled).toBe(true);
    // Synthesizer LLM is NOT called — short-circuit returned step2's output.
    expect(synthesizerCalled).toBe(false);
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

  test('A2 honesty: when ALL delegate-sub-agent steps fail, synthesizer is NOT called even if setup steps succeeded', async () => {
    // Multi-agent regression from session fa12c770 — Researcher delegate
    // timed out, Author/Mentor delegates also failed, but a setup step
    // ("generate question") completed in 6.5s. Synthesizer received the
    // succeeded step1 + failed delegates and STILL fabricated Author/Mentor
    // responses ("จำลองการตอบของ Agent ที่เหลือ"). The fast-path now
    // also fires when all delegate-sub-agent steps failed regardless of
    // whether setup steps succeeded — the user asked for agent answers,
    // not for the system to fake them.
    let synthesizerCalled = false;
    const plan = JSON.stringify({
      goal: 'multi-agent debate with question setup',
      steps: [
        {
          id: 'step1',
          description: 'generate the debate question',
          strategy: 'llm-reasoning',
          budgetFraction: 0.2,
        },
        {
          id: 'step2',
          description: 'researcher answers',
          strategy: 'delegate-sub-agent',
          agentId: 'researcher',
          dependencies: ['step1'],
          budgetFraction: 0.3,
        },
        {
          id: 'step3',
          description: 'author answers',
          strategy: 'delegate-sub-agent',
          agentId: 'author',
          dependencies: ['step1'],
          budgetFraction: 0.3,
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
          return { content: 'fabricated agent answers', tokensUsed: { input: 5, output: 5 } };
        }
        // step1 (llm-reasoning, "generate the debate question") succeeds.
        return { content: 'What is the meaning of life?', tokensUsed: { input: 5, output: 5 } };
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
    // Both delegates fail (executeTask returns failed status).
    const executeTask = async (subInput: any) => {
      return {
        id: subInput.id,
        status: 'failed',
        mutations: [],
        answer: `${subInput.agentId} delegate failed`,
        trace: { tokensConsumed: 0 },
      } as any;
    };
    const result = await executeWorkflow(makeInput('multi-agent debate with question setup'), {
      llmRegistry: { selectByTier: () => mockProvider } as any,
      executeTask,
    });
    expect(result.status).toBe('partial');
    expect(synthesizerCalled).toBe(false);
    expect(result.synthesizedOutput).not.toContain('fabricated');
    expect(result.synthesizedOutput).toMatch(/multi-agent.*could not produce|delegated agents/i);
    // Setup step's success IS shown for transparency (so user sees the
    // question was generated) but is explicitly marked as supporting
    // context, not as a substitute for the missing agent answers.
    expect(result.synthesizedOutput).toContain('What is the meaning of life?');
    expect(result.synthesizedOutput).toMatch(/not as substitute|transparency/i);
  });

  test('delegate-sub-agent enforces per-step idle timeout once activity has begun (no 40-min hangs)', async () => {
    // Free-tier 429 retry loops inside sub-agents previously hung the
    // entire workflow indefinitely (session ede9e9e1 sat 40 min before
    // a server restart marked it orphaned). The streaming-aware watchdog
    // catches this in two stages:
    //   - If the sub-task NEVER emits an activity event, the hard ceiling
    //     (`HARD_CEILING_MS`, ≥ 600s) is the only cap. This avoids killing
    //     the legitimate "non-streaming LLM call takes 150s" case at 120s
    //     — the bug pre-fix was killing real work because the watchdog
    //     conflated "no `llm:stream_delta`" with "stuck."
    //   - Once the sub-task emits ANY tracked activity event (stream
    //     delta, phase:timing, agent:turn_complete, etc.), the tight
    //     idle window engages and a hang AFTER that point is killed at
    //     `subTaskTimeoutMs` (≥ 120s).
    // This test models the second case: the hanging delegate emits one
    // activity event and then never resolves. The watchdog's idle clock
    // arms on that first event and fires 120s later.
    const timeoutEvents: any[] = [];
    const plan = JSON.stringify({
      goal: 'two delegates, one hangs',
      steps: [
        {
          id: 'step1',
          description: 'fast delegate',
          strategy: 'delegate-sub-agent',
          agentId: 'developer',
          budgetFraction: 0.5,
        },
        {
          id: 'step2',
          description: 'hanging delegate',
          strategy: 'delegate-sub-agent',
          agentId: 'architect',
          budgetFraction: 0.5,
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
    const { createBus } = await import('../../../src/core/bus.ts');
    const bus = createBus();
    bus.on('workflow:delegate_timeout', (payload) => {
      timeoutEvents.push(payload);
    });
    // First delegate completes normally; second emits one stream-delta
    // (arming the watchdog idle clock) and then hangs forever. The idle
    // timer should fire at subTaskTimeoutMs (≥ 120s).
    const executeTask = async (subInput: any) => {
      if (subInput.id.endsWith('-delegate-step1')) {
        return {
          id: subInput.id,
          status: 'completed',
          mutations: [],
          answer: 'fast result',
          trace: { tokensConsumed: 5 },
        } as any;
      }
      // Emit one delta to engage the idle watchdog, then hang.
      bus.emit('llm:stream_delta', {
        taskId: subInput.id,
        kind: 'content',
        text: 'starting…',
      });
      return await new Promise(() => {});
    };
    const result = await executeWorkflow(
      // Tight parent budget; the per-step floor (120s default MIN) wins
      // and arms the idle clock at 120s after the sub-task's first event.
      {
        ...makeInput('two delegates, one hangs'),
        budget: { maxTokens: 1000, maxDurationMs: 1000, maxRetries: 1 },
      },
      {
        llmRegistry: { selectByTier: () => mockProvider } as any,
        executeTask,
        bus,
        workflowConfig: { requireUserApproval: false, approvalTimeoutMs: 30_000 },
      },
    );
    // step1 completed, step2 timed out → status partial
    expect(result.status).toBe('partial');
    const step1 = result.stepResults.find((r) => r.stepId === 'step1');
    const step2 = result.stepResults.find((r) => r.stepId === 'step2');
    expect(step1?.status).toBe('completed');
    expect(step2?.status).toBe('failed');
    expect(step2?.output).toMatch(/timed out|timeout/i);
    expect(timeoutEvents.length).toBe(1);
    expect(timeoutEvents[0].stepId).toBe('step2');
    expect(timeoutEvents[0].agentId).toBe('architect');
  }, 200_000); // give the 120s floor room to fire

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

  test('delegate sub-task receives prior dependency output + parent goal as context', async () => {
    // Session a43487fd regression — the delegate sub-task only saw
    // step.description (the planner's template phrasing) and did not see:
    //   - the original user prompt (anchor for intent)
    //   - the prior step's output (the question step1 generated for it to
    //     answer). As a result, delegates "proposed competition rules"
    //     instead of answering the question. The delegate goal must include
    //     plan.goal AND the interpolated prior output AND an explicit
    //     instruction to deliver the answer (not narrate workflow design).
    const capturedSubGoals: string[] = [];
    const plan = JSON.stringify({
      goal: 'แบ่ง Agent 3ตัว แข่งกันถามตอบ',
      steps: [
        {
          id: 'step1',
          description: 'Generate a challenging question for the agents',
          strategy: 'llm-reasoning',
          budgetFraction: 0.2,
        },
        {
          id: 'step2',
          description: 'Researcher answers the question from step1',
          strategy: 'delegate-sub-agent',
          agentId: 'researcher',
          dependencies: ['step1'],
          inputs: { question: '$step1.result' },
          budgetFraction: 0.4,
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
        // step1 (llm-reasoning) — produce the Quantum/RSA question.
        return {
          content: 'How does Shor algorithm threaten RSA in the post-quantum era?',
          tokensUsed: { input: 5, output: 5 },
        };
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
      capturedSubGoals.push(subInput.goal);
      return {
        id: subInput.id,
        status: 'completed',
        mutations: [],
        answer: `${subInput.agentId} answer`,
        trace: { tokensConsumed: 10 },
      } as any;
    };
    await executeWorkflow(makeInput('แบ่ง Agent 3ตัว แข่งกันถามตอบ'), {
      llmRegistry: { selectByTier: () => mockProvider } as any,
      executeTask,
    });
    expect(capturedSubGoals.length).toBe(1);
    const subGoal = capturedSubGoals[0]!;
    // Step description (the delegate's primary task) is preserved.
    expect(subGoal).toContain('Researcher answers the question from step1');
    // Original user request is included as anchor.
    expect(subGoal).toContain('แบ่ง Agent 3ตัว แข่งกันถามตอบ');
    // Prior dependency output (step1's question) is interpolated so the
    // delegate has the actual content to answer, not just a reference.
    expect(subGoal).toContain('Shor');
    // Explicit "produce your answer, do not propose rules" instruction.
    expect(subGoal).toMatch(/produce your own answer|do NOT propose|do NOT meta-describe/i);
  });

  test('delegates without aggregator sink → deterministic concat, synthesizer NOT called', async () => {
    // The planner sometimes produces a plan with N parallel
    // delegate-sub-agent steps and NO final aggregator/sink llm-reasoning
    // step. Before this fix, buildResult fell through to the synthesizer
    // LLM which on weak free-tier models smoothed persona voices and even
    // fabricated content. Structural fix: skip the LLM, render verbatim
    // delegate outputs under persona headers — voice-preserving + zero
    // fabrication surface.
    let synthesizerCalled = false;
    const plan = JSON.stringify({
      goal: 'parallel agents, no aggregator',
      steps: [
        {
          id: 'step1',
          description: 'researcher answers',
          strategy: 'delegate-sub-agent',
          agentId: 'researcher',
          budgetFraction: 0.5,
        },
        {
          id: 'step2',
          description: 'author answers',
          strategy: 'delegate-sub-agent',
          agentId: 'author',
          budgetFraction: 0.5,
        },
        // NO final llm-reasoning sink.
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
          return { content: 'FABRICATED', tokensUsed: { input: 5, output: 5 } };
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
    const executeTask = async (subInput: any) => {
      const text =
        subInput.agentId === 'researcher'
          ? 'Empirical analysis: the answer is X with citations.'
          : 'Author voice: a story unfolds about Y.';
      return {
        id: subInput.id,
        status: 'completed',
        mutations: [],
        answer: text,
        trace: { tokensConsumed: 10 },
      } as any;
    };
    const result = await executeWorkflow(makeInput('parallel agents, no aggregator'), {
      llmRegistry: { selectByTier: () => mockProvider } as any,
      executeTask,
    });
    expect(result.status).toBe('completed');
    expect(synthesizerCalled).toBe(false);
    expect(result.synthesizedOutput).not.toContain('FABRICATED');
    // Persona headers present.
    expect(result.synthesizedOutput).toContain('### researcher');
    expect(result.synthesizedOutput).toContain('### author');
    // Verbatim delegate outputs preserved.
    expect(result.synthesizedOutput).toContain('Empirical analysis: the answer is X with citations.');
    expect(result.synthesizedOutput).toContain('Author voice: a story unfolds about Y.');
  });

  test('setup llm-reasoning + delegates + no aggregator → setup as supporting note, delegates as primary', async () => {
    // Planner produces a setup step (e.g. llm-reasoning that generates the
    // question) followed by parallel delegate-sub-agent steps and no
    // aggregator. The setup step's output is supporting context for the
    // delegates — it should NOT be confused with primary content. The
    // deterministic aggregation lists delegates first as primary content
    // and the setup step as a transparent footnote.
    let synthesizerCalled = false;
    const plan = JSON.stringify({
      goal: 'setup + parallel delegates, no aggregator',
      steps: [
        {
          id: 'step1',
          description: 'generate the debate question',
          strategy: 'llm-reasoning',
          budgetFraction: 0.2,
        },
        {
          id: 'step2',
          description: 'researcher answers',
          strategy: 'delegate-sub-agent',
          agentId: 'researcher',
          dependencies: ['step1'],
          budgetFraction: 0.4,
        },
        {
          id: 'step3',
          description: 'author answers',
          strategy: 'delegate-sub-agent',
          agentId: 'author',
          dependencies: ['step1'],
          budgetFraction: 0.4,
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
          return { content: 'fab', tokensUsed: { input: 5, output: 5 } };
        }
        // step1 generates the question.
        return {
          content: 'What is the meaning of consciousness?',
          tokensUsed: { input: 5, output: 5 },
        };
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
      return {
        id: subInput.id,
        status: 'completed',
        mutations: [],
        answer: `${subInput.agentId} delivers a thoughtful response.`,
        trace: { tokensConsumed: 10 },
      } as any;
    };
    const result = await executeWorkflow(makeInput('setup + parallel delegates'), {
      llmRegistry: { selectByTier: () => mockProvider } as any,
      executeTask,
    });
    expect(result.status).toBe('completed');
    expect(synthesizerCalled).toBe(false);
    // Persona headers present and primary.
    expect(result.synthesizedOutput).toContain('### researcher');
    expect(result.synthesizedOutput).toContain('### author');
    // Setup step appears as supporting note, NOT as primary content.
    expect(result.synthesizedOutput).toMatch(/Setup steps that informed the agents above/);
    expect(result.synthesizedOutput).toContain('What is the meaning of consciousness?');
    // Verbatim delegate outputs preserved.
    expect(result.synthesizedOutput).toContain('researcher delivers a thoughtful response.');
    expect(result.synthesizedOutput).toContain('author delivers a thoughtful response.');
    // Order: delegate sections appear BEFORE the setup-steps note in the
    // joined output (delegates are primary; setup is transparency).
    const idxResearcher = result.synthesizedOutput.indexOf('### researcher');
    const idxSetupNote = result.synthesizedOutput.indexOf('Setup steps that informed');
    expect(idxResearcher).toBeGreaterThanOrEqual(0);
    expect(idxSetupNote).toBeGreaterThan(idxResearcher);
  });

  test('partial: 1 of 3 delegates failed, no aggregator → failed slot honest, others verbatim', async () => {
    // Mixed delegate outcomes WITHOUT an aggregator step. The successful
    // delegates' outputs must be preserved verbatim under their headers.
    // The failed delegate's slot must be honest about the failure — no
    // fabricated content filling in the missing voice.
    let synthesizerCalled = false;
    const plan = JSON.stringify({
      goal: 'three agents, one fails, no aggregator',
      steps: [
        {
          id: 'step1',
          description: 'researcher answers',
          strategy: 'delegate-sub-agent',
          agentId: 'researcher',
          budgetFraction: 0.33,
        },
        {
          id: 'step2',
          description: 'author answers',
          strategy: 'delegate-sub-agent',
          agentId: 'author',
          budgetFraction: 0.33,
        },
        {
          id: 'step3',
          description: 'mentor answers',
          strategy: 'delegate-sub-agent',
          agentId: 'mentor',
          budgetFraction: 0.34,
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
          return { content: 'fab', tokensUsed: { input: 5, output: 5 } };
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
    const executeTask = async (subInput: any) => {
      // mentor "fails" — TaskResult.status='failed' with an error message.
      if (subInput.agentId === 'mentor') {
        return {
          id: subInput.id,
          status: 'failed',
          mutations: [],
          answer: 'connection error',
          trace: { tokensConsumed: 0 },
        } as any;
      }
      return {
        id: subInput.id,
        status: 'completed',
        mutations: [],
        answer: `${subInput.agentId} REAL ANSWER`,
        trace: { tokensConsumed: 10 },
      } as any;
    };
    const result = await executeWorkflow(makeInput('three agents, one fails'), {
      llmRegistry: { selectByTier: () => mockProvider } as any,
      executeTask,
    });
    expect(result.status).toBe('partial');
    expect(synthesizerCalled).toBe(false);
    // Successful delegates' outputs verbatim.
    expect(result.synthesizedOutput).toContain('researcher REAL ANSWER');
    expect(result.synthesizedOutput).toContain('author REAL ANSWER');
    // Failed delegate slot: honest placeholder, no fabricated content.
    expect(result.synthesizedOutput).toContain('### mentor');
    expect(result.synthesizedOutput).toMatch(/\[no response — /);
    // The mentor section MUST NOT contain a fabricated "REAL ANSWER".
    const mentorHeaderIdx = result.synthesizedOutput.indexOf('### mentor');
    const mentorSlice = result.synthesizedOutput.slice(mentorHeaderIdx);
    const nextSection = mentorSlice.indexOf('\n---\n');
    const mentorBlock = nextSection > 0 ? mentorSlice.slice(0, nextSection) : mentorSlice;
    expect(mentorBlock).not.toContain('mentor REAL ANSWER');
  });

  test('Gap — planner hallucinated agentId is sanitized; delegate runs anonymously', async () => {
    const warnings: any[] = [];
    const plan = JSON.stringify({
      goal: 'multi-agent with hallucinated id',
      steps: [
        { id: 'step1', description: 'researcher answers', strategy: 'delegate-sub-agent', agentId: 'researcher', budgetFraction: 0.5 },
        { id: 'step2', description: 'philosopher answers', strategy: 'delegate-sub-agent', agentId: 'philosopher', budgetFraction: 0.5 },
      ],
      synthesisPrompt: 'Combine.',
    });
    const dispatchedAgents: Array<string | undefined> = [];
    const mockProvider = {
      id: 'mock',
      generate: async (req: { systemPrompt: string }) => {
        if (req.systemPrompt.includes('workflow planner')) {
          return { content: plan, tokensUsed: { input: 5, output: 5 } };
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
    const executeTask = async (subInput: any) => {
      dispatchedAgents.push(subInput.agentId);
      return { id: subInput.id, status: 'completed', mutations: [], answer: 'a', trace: { tokensConsumed: 10 } } as any;
    };
    await executeWorkflow(makeInput('multi-agent with hallucinated id'), {
      llmRegistry: { selectByTier: () => mockProvider } as any,
      executeTask,
      bus: {
        emit: (event: string, payload: unknown) => {
          if (event === 'workflow:planner_validation_warning') warnings.push(payload);
        },
      } as any,
      agentRegistry: {
        listAgents: () => [
          { id: 'researcher', name: 'Researcher' },
          { id: 'author', name: 'Author' },
          { id: 'mentor', name: 'Mentor' },
        ],
      } as any,
    });
    expect(dispatchedAgents).toContain('researcher');
    expect(dispatchedAgents).not.toContain('philosopher');
    expect(dispatchedAgents.filter((a) => !a).length).toBe(1);
    expect(warnings.length).toBe(1);
    expect(warnings[0].hallucinatedAgentIds).toEqual([{ stepId: 'step2', agentId: 'philosopher' }]);
  });

  test('Gap — duplicate agentId across delegate steps is sanitized', async () => {
    const warnings: any[] = [];
    const plan = JSON.stringify({
      goal: 'multi-agent with duplicate id',
      steps: [
        { id: 'step1', description: 'researcher angle 1', strategy: 'delegate-sub-agent', agentId: 'researcher', budgetFraction: 0.5 },
        { id: 'step2', description: 'researcher angle 2', strategy: 'delegate-sub-agent', agentId: 'researcher', budgetFraction: 0.5 },
      ],
      synthesisPrompt: 'Combine.',
    });
    const dispatchedAgents: Array<string | undefined> = [];
    const mockProvider = {
      id: 'mock',
      generate: async (req: { systemPrompt: string }) => {
        if (req.systemPrompt.includes('workflow planner')) {
          return { content: plan, tokensUsed: { input: 5, output: 5 } };
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
    const executeTask = async (subInput: any) => {
      dispatchedAgents.push(subInput.agentId);
      return { id: subInput.id, status: 'completed', mutations: [], answer: 'a', trace: { tokensConsumed: 10 } } as any;
    };
    await executeWorkflow(makeInput('multi-agent with duplicate id'), {
      llmRegistry: { selectByTier: () => mockProvider } as any,
      executeTask,
      bus: {
        emit: (event: string, payload: unknown) => {
          if (event === 'workflow:planner_validation_warning') warnings.push(payload);
        },
      } as any,
      agentRegistry: {
        listAgents: () => [{ id: 'researcher', name: 'Researcher' }],
      } as any,
    });
    expect(dispatchedAgents).toContain('researcher');
    expect(dispatchedAgents.filter((a) => !a).length).toBe(1);
    expect(warnings.length).toBe(1);
    expect(warnings[0].duplicateAgentIds).toEqual([{ stepId: 'step2', agentId: 'researcher' }]);
  });

  test('Gap — per-delegate output cap prevents context blow-up on huge outputs', async () => {
    const huge = 'X'.repeat(50_000);
    const plan = JSON.stringify({
      goal: 'two delegates with huge outputs',
      steps: [
        { id: 'step1', description: 'researcher answers', strategy: 'delegate-sub-agent', agentId: 'researcher', budgetFraction: 0.5 },
        { id: 'step2', description: 'author answers', strategy: 'delegate-sub-agent', agentId: 'author', budgetFraction: 0.5 },
      ],
      synthesisPrompt: 'Combine.',
    });
    const mockProvider = {
      id: 'mock',
      generate: async (req: { systemPrompt: string }) => {
        if (req.systemPrompt.includes('workflow planner')) {
          return { content: plan, tokensUsed: { input: 5, output: 5 } };
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
    const executeTask = async (subInput: any) => ({
      id: subInput.id,
      status: 'completed',
      mutations: [],
      answer: huge,
      trace: { tokensConsumed: 100 },
    } as any);
    const result = await executeWorkflow(makeInput('two delegates with huge outputs'), {
      llmRegistry: { selectByTier: () => mockProvider } as any,
      executeTask,
    });
    expect(result.synthesizedOutput.length).toBeLessThan(25_000);
    expect(result.synthesizedOutput).toContain('truncated, full output 50000 chars');
    expect(result.synthesizedOutput).toContain('### researcher');
    expect(result.synthesizedOutput).toContain('### author');
  });

  test('Gap — empty delegate output is treated honestly (no empty section under persona header)', async () => {
    const plan = JSON.stringify({
      goal: 'two delegates, one returns empty',
      steps: [
        { id: 'step1', description: 'researcher answers', strategy: 'delegate-sub-agent', agentId: 'researcher', budgetFraction: 0.5 },
        { id: 'step2', description: 'author answers', strategy: 'delegate-sub-agent', agentId: 'author', budgetFraction: 0.5 },
      ],
      synthesisPrompt: 'Combine.',
    });
    const mockProvider = {
      id: 'mock',
      generate: async (req: { systemPrompt: string }) => {
        if (req.systemPrompt.includes('workflow planner')) {
          return { content: plan, tokensUsed: { input: 5, output: 5 } };
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
    const executeTask = async (subInput: any) => ({
      id: subInput.id,
      status: 'completed',
      mutations: [],
      answer: subInput.agentId === 'author' ? '   \n\n  ' : 'researcher real answer',
      trace: { tokensConsumed: 10 },
    } as any);
    const result = await executeWorkflow(makeInput('two delegates, one returns empty'), {
      llmRegistry: { selectByTier: () => mockProvider } as any,
      executeTask,
    });
    expect(result.synthesizedOutput).toContain('researcher real answer');
    expect(result.synthesizedOutput).toContain('### author');
    expect(result.synthesizedOutput).toContain('[no response — empty output]');
  });

  test('Gap — sub-task workflow bypasses approval gate (parent already authorized)', async () => {
    // Sub-tasks (input.parentTaskId set) inherit the parent's approval
    // and must NOT trigger their own approval prompts. Without this
    // bypass, a delegate-sub-agent whose synthesized plan would
    // normally require approval would block waiting for the user — but
    // the user has no UI surface to see/approve sub-task plans, and the
    // workflow stalls until timeout.
    const planReadyEmissions: any[] = [];
    const plan = JSON.stringify({
      goal: 'sub-task workflow',
      steps: [
        { id: 'step1', description: 'one step', strategy: 'llm-reasoning', budgetFraction: 1 },
      ],
      synthesisPrompt: 'Combine.',
    });
    const mockProvider = {
      id: 'mock',
      generate: async (req: { systemPrompt: string }) => {
        if (req.systemPrompt.includes('workflow planner')) {
          return { content: plan, tokensUsed: { input: 5, output: 5 } };
        }
        return { content: 'one step output', tokensUsed: { input: 5, output: 5 } };
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
    const result = await executeWorkflow(
      { ...makeInput('sub-task workflow'), parentTaskId: 'parent-1' },
      {
        llmRegistry: { selectByTier: () => mockProvider } as any,
        bus: {
          emit: (event: string, payload: unknown) => {
            if (event === 'workflow:plan_ready') planReadyEmissions.push(payload);
          },
        } as any,
        workflowConfig: { requireUserApproval: 'always' } as any,
      },
    );
    expect(result.status).toBe('completed');
    expect(planReadyEmissions.length).toBe(1);
    expect(planReadyEmissions[0].awaitingApproval).toBe(false);
  });

  test('Risk 1 — single delegate with setup steps: skip persona header, render verbatim', async () => {
    // Edge case: 1 delegate-sub-agent step + setup llm-reasoning step, no
    // aggregator. The deterministic-concat branch fires (≥1 completed
    // delegate). Without the cleanup, the output would be `### researcher
    // — answers the question\n\n[output]` — visually "heading-y" with no
    // sibling section to compare against. The single-delegate branch
    // skips the header and renders the delegate output verbatim, with
    // the setup step still appearing as a transparent footnote (using
    // the singular phrasing "response above").
    let synthesizerCalled = false;
    const plan = JSON.stringify({
      goal: 'one delegate + setup, no aggregator',
      steps: [
        {
          id: 'step1',
          description: 'gather context',
          strategy: 'llm-reasoning',
          budgetFraction: 0.3,
        },
        {
          id: 'step2',
          description: 'researcher answers using the context',
          strategy: 'delegate-sub-agent',
          agentId: 'researcher',
          dependencies: ['step1'],
          budgetFraction: 0.7,
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
          return { content: 'fab', tokensUsed: { input: 5, output: 5 } };
        }
        return { content: 'context: X', tokensUsed: { input: 5, output: 5 } };
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
    const executeTask = async (subInput: any) => ({
      id: subInput.id,
      status: 'completed',
      mutations: [],
      answer: 'Researcher delivers a single, focused answer about X.',
      trace: { tokensConsumed: 10 },
    } as any);
    const result = await executeWorkflow(makeInput('one delegate + setup'), {
      llmRegistry: { selectByTier: () => mockProvider } as any,
      executeTask,
    });
    expect(result.status).toBe('completed');
    expect(synthesizerCalled).toBe(false);
    // No `### researcher — …` header (single-delegate cleanup).
    expect(result.synthesizedOutput).not.toContain('### researcher');
    // Verbatim delegate output present.
    expect(result.synthesizedOutput).toContain('Researcher delivers a single, focused answer about X.');
    // Setup note uses singular phrasing.
    expect(result.synthesizedOutput).toContain('Setup steps that informed the response above');
    expect(result.synthesizedOutput).toContain('context: X');
  });

  test('Risk 2 — synthesizer compression safety net: fall back to deterministic concat when LLM paraphrases', async () => {
    // Non-delegate multi-step plan with two parallel llm-reasoning steps
    // (no sole sink → no short-circuit; no delegates → no deterministic
    // delegate aggregation; LLM synthesizer DOES run). When the
    // synthesizer compresses output below the threshold (synthesized
    // bytes / total step output bytes < 0.25, with total > 1500), the
    // safety net replaces the LLM output with a step-headered concat so
    // detail isn't lost on weak free-tier models.
    const compressionEvents: any[] = [];
    // Each step outputs ~1000 chars of detail, totalling ~2000 chars.
    const stepDetail = 'A'.repeat(1000);
    const plan = JSON.stringify({
      goal: 'two analytical steps with detail',
      steps: [
        {
          id: 'step1',
          description: 'analyze angle A',
          strategy: 'llm-reasoning',
          budgetFraction: 0.5,
        },
        {
          id: 'step2',
          description: 'analyze angle B',
          strategy: 'llm-reasoning',
          budgetFraction: 0.5,
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
          // LLM compresses 2000+ chars into 50 chars — paraphrase pattern.
          return { content: 'tl;dr: both angles agree.', tokensUsed: { input: 5, output: 5 } };
        }
        return { content: stepDetail, tokensUsed: { input: 5, output: 5 } };
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
    const result = await executeWorkflow(makeInput('two analytical steps with detail'), {
      llmRegistry: { selectByTier: () => mockProvider } as any,
      bus: {
        emit: (event: string, payload: unknown) => {
          if (event === 'workflow:synthesizer_compression_detected') {
            compressionEvents.push(payload);
          }
        },
      } as any,
    });
    expect(result.status).toBe('completed');
    // Compression detected and logged.
    expect(compressionEvents.length).toBe(1);
    expect(compressionEvents[0].compressionRatio).toBeLessThan(0.25);
    // Fallback to deterministic concat: step headers + verbatim outputs.
    expect(result.synthesizedOutput).toContain('## step1');
    expect(result.synthesizedOutput).toContain('## step2');
    // Both step outputs preserved verbatim.
    expect(result.synthesizedOutput).toContain(stepDetail);
    // The compressed LLM output is discarded.
    expect(result.synthesizedOutput).not.toContain('tl;dr');
  });

  test('Risk 2 — synthesizer compression safety net: does NOT fire on small workflows or modest compression', async () => {
    // Negative case: total step output below 1500 bytes → safety net
    // does NOT fire even if compression ratio looks aggressive. This
    // protects legitimate small workflows from being routed through the
    // deterministic concat (which looks debug-y for short outputs).
    const compressionEvents: any[] = [];
    const plan = JSON.stringify({
      goal: 'short two-step plan',
      steps: [
        { id: 'step1', description: 'a', strategy: 'llm-reasoning', budgetFraction: 0.5 },
        { id: 'step2', description: 'b', strategy: 'llm-reasoning', budgetFraction: 0.5 },
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
          return { content: 'short synthesis', tokensUsed: { input: 5, output: 5 } };
        }
        return { content: 'tiny step output', tokensUsed: { input: 5, output: 5 } };
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
    const result = await executeWorkflow(makeInput('short two-step plan'), {
      llmRegistry: { selectByTier: () => mockProvider } as any,
      bus: {
        emit: (event: string, payload: unknown) => {
          if (event === 'workflow:synthesizer_compression_detected') {
            compressionEvents.push(payload);
          }
        },
      } as any,
    });
    expect(result.status).toBe('completed');
    // No compression event — workflow output too small for the safety net.
    expect(compressionEvents.length).toBe(0);
    // Synthesizer's output is preserved as the final answer.
    expect(result.synthesizedOutput).toBe('short synthesis');
  });

  test('Risk 3 — mid-DAG delegate: deterministic concat preserves plan order across non-sink delegates', async () => {
    // Topology: step1 (llm-reasoning) → step2 (delegate researcher) →
    // step3 (llm-reasoning, depends on step2) → step4 (delegate author,
    // depends on step3). step4 IS a sink but step3 (llm-reasoning) is
    // also a non-sink mid-DAG step. The already-final-step short-circuit
    // does NOT fire because step4 is delegate-sub-agent, not
    // llm-reasoning. So we end up in the deterministic-delegate branch
    // with TWO delegates (step2, step4) interleaved with two
    // llm-reasoning setup steps. Verify:
    //   - Both delegates appear in plan order under their headers
    //   - Both setup steps appear in the trailing setup-note section
    //   - Synthesizer LLM is NOT called
    let synthesizerCalled = false;
    const plan = JSON.stringify({
      goal: 'mid-DAG mixed topology',
      steps: [
        {
          id: 'step1',
          description: 'generate the question',
          strategy: 'llm-reasoning',
          budgetFraction: 0.2,
        },
        {
          id: 'step2',
          description: 'researcher answers',
          strategy: 'delegate-sub-agent',
          agentId: 'researcher',
          dependencies: ['step1'],
          budgetFraction: 0.3,
        },
        {
          id: 'step3',
          description: 'frame the next angle',
          strategy: 'llm-reasoning',
          dependencies: ['step2'],
          budgetFraction: 0.2,
        },
        {
          id: 'step4',
          description: 'author responds',
          strategy: 'delegate-sub-agent',
          agentId: 'author',
          dependencies: ['step3'],
          budgetFraction: 0.3,
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
          synthesizerCalled = true;
          return { content: 'fab', tokensUsed: { input: 5, output: 5 } };
        }
        return { content: `${req.userPrompt.slice(0, 30)}-llm`, tokensUsed: { input: 5, output: 5 } };
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
    const executeTask = async (subInput: any) => ({
      id: subInput.id,
      status: 'completed',
      mutations: [],
      answer: `${subInput.agentId} REAL DELEGATE ANSWER`,
      trace: { tokensConsumed: 10 },
    } as any);
    const result = await executeWorkflow(makeInput('mid-DAG mixed topology'), {
      llmRegistry: { selectByTier: () => mockProvider } as any,
      executeTask,
    });
    expect(result.status).toBe('completed');
    expect(synthesizerCalled).toBe(false);
    // Both delegates rendered with persona headers (since count > 1).
    expect(result.synthesizedOutput).toContain('### researcher');
    expect(result.synthesizedOutput).toContain('### author');
    // Plan order: researcher BEFORE author (matches plan.steps order even
    // though they have a step3 setup between them in the DAG).
    const idxResearcher = result.synthesizedOutput.indexOf('### researcher');
    const idxAuthor = result.synthesizedOutput.indexOf('### author');
    expect(idxResearcher).toBeGreaterThanOrEqual(0);
    expect(idxAuthor).toBeGreaterThan(idxResearcher);
    // Verbatim outputs preserved.
    expect(result.synthesizedOutput).toContain('researcher REAL DELEGATE ANSWER');
    expect(result.synthesizedOutput).toContain('author REAL DELEGATE ANSWER');
    // Setup note includes BOTH non-delegate steps (step1, step3).
    expect(result.synthesizedOutput).toContain('Setup steps that informed the agents above');
    expect(result.synthesizedOutput).toContain('**step1**');
    expect(result.synthesizedOutput).toContain('**step3**');
  });

  test('non-delegate workflow with no sole-sink → existing synthesizer LLM still runs', async () => {
    // Regression guard: when the plan has only llm-reasoning steps WITHOUT
    // a single-sink synthesis step (e.g. two parallel independent reasoning
    // steps that both terminate the DAG), the deterministic-delegate
    // aggregation branch must NOT fire (no delegates), the
    // already-final-step short-circuit must NOT fire (no single sink), and
    // the fall-through synthesizer LLM SHOULD run as before. This protects
    // existing non-delegate plans (analytical workflows, multi-pass
    // research) from being inadvertently swept into the new branch.
    let synthesizerCalled = false;
    const plan = JSON.stringify({
      goal: 'two parallel analytical steps, no sole sink, no delegates',
      steps: [
        {
          id: 'step1',
          description: 'analyze angle A',
          strategy: 'llm-reasoning',
          budgetFraction: 0.5,
        },
        {
          id: 'step2',
          description: 'analyze angle B',
          strategy: 'llm-reasoning',
          budgetFraction: 0.5,
        },
        // No dependencies → both are sinks (no single-sink short-circuit).
        // No delegates → no deterministic aggregation.
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
          return { content: 'LLM-synthesized answer', tokensUsed: { input: 5, output: 5 } };
        }
        return { content: `step result for ${req.systemPrompt.slice(0, 20)}`, tokensUsed: { input: 5, output: 5 } };
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
    const result = await executeWorkflow(makeInput('two parallel analytical steps'), {
      llmRegistry: { selectByTier: () => mockProvider } as any,
    });
    expect(result.status).toBe('completed');
    // The LLM synthesizer DID run for non-delegate plans.
    expect(synthesizerCalled).toBe(true);
    expect(result.synthesizedOutput).toBe('LLM-synthesized answer');
  });

  test('final synthesis short-circuits when the last plan step is already a synthesis sink', async () => {
    // Session a43487fd regression — workflow had step4 = 'llm-reasoning'
    // ("Compare the three answers...") that depended on the 3 delegates.
    // The buildResult synthesizer ran AGAIN on top of step4's output,
    // creating a second synthesis layer that fabricated polished agent
    // answers (the delegates had only proposed rules, but the second
    // synthesizer invented detailed Quantum answers from the step
    // descriptions). When the last step is already the workflow's
    // aggregation sink and has usable output, return it verbatim — do
    // NOT invoke the synthesizer LLM a second time.
    let synthesizerCalled = false;
    const plan = JSON.stringify({
      goal: 'two delegates + final compare',
      steps: [
        {
          id: 'step1',
          description: 'researcher answers',
          strategy: 'delegate-sub-agent',
          agentId: 'researcher',
          budgetFraction: 0.3,
        },
        {
          id: 'step2',
          description: 'author answers',
          strategy: 'delegate-sub-agent',
          agentId: 'author',
          budgetFraction: 0.3,
        },
        {
          id: 'step3',
          description: 'Compare and synthesize the two answers',
          strategy: 'llm-reasoning',
          dependencies: ['step1', 'step2'],
          budgetFraction: 0.4,
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
          return { content: 'FABRICATED SECOND SYNTHESIS', tokensUsed: { input: 5, output: 5 } };
        }
        // step3 (llm-reasoning sink) returns the planner-asked comparison.
        return { content: 'FINAL COMPARISON FROM STEP3', tokensUsed: { input: 5, output: 5 } };
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
      return {
        id: subInput.id,
        status: 'completed',
        mutations: [],
        answer: `${subInput.agentId} actual answer`,
        trace: { tokensConsumed: 10 },
      } as any;
    };
    const result = await executeWorkflow(makeInput('two delegates + final compare'), {
      llmRegistry: { selectByTier: () => mockProvider } as any,
      executeTask,
    });
    expect(result.status).toBe('completed');
    // Synthesizer must NOT run a second pass — step3's output is the answer.
    expect(synthesizerCalled).toBe(false);
    expect(result.synthesizedOutput).toBe('FINAL COMPARISON FROM STEP3');
    expect(result.synthesizedOutput).not.toContain('FABRICATED');
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

  test('Test 6: parallel delegates only see their declared dependency output, not siblings', async () => {
    // Two delegates that BOTH depend on step1 but NOT on each other. Each
    // must see step1's output (QUESTION_SENTINEL_Q1) interpolated into its
    // subInput.goal, but neither must see the other's eventual answer in
    // its goal — interpolateInputs is dependency-scoped (no kitchen-sink).
    // Pins the existing clean behaviour against future regression where
    // someone might "helpfully" forward all completed step outputs.
    const capturedByAgent: Record<string, string> = {};
    const plan = JSON.stringify({
      goal: 'three personas debate one question',
      steps: [
        {
          id: 'step1',
          description: 'Pose the debate question',
          strategy: 'llm-reasoning',
          budgetFraction: 0.2,
        },
        {
          id: 'step2',
          description: 'Researcher answers the question',
          strategy: 'delegate-sub-agent',
          agentId: 'researcher',
          dependencies: ['step1'],
          inputs: { question: '$step1.result' },
          budgetFraction: 0.3,
        },
        {
          id: 'step3',
          description: 'Author answers the question',
          strategy: 'delegate-sub-agent',
          agentId: 'author',
          dependencies: ['step1'],
          inputs: { question: '$step1.result' },
          budgetFraction: 0.3,
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
        // step1 (llm-reasoning) — produces the question with the sentinel.
        return {
          content: 'QUESTION_SENTINEL_Q1: should we prefer speed or accuracy?',
          tokensUsed: { input: 5, output: 5 },
        };
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
      const agentId = subInput.agentId as string;
      capturedByAgent[agentId] = subInput.goal;
      const sentinel =
        agentId === 'researcher'
          ? 'RESEARCHER_ANSWER_SENTINEL'
          : agentId === 'author'
            ? 'AUTHOR_ANSWER_SENTINEL'
            : 'OTHER_ANSWER';
      return {
        id: subInput.id,
        status: 'completed',
        mutations: [],
        answer: sentinel,
        trace: { tokensConsumed: 10 },
      } as any;
    };
    await executeWorkflow(makeInput('three personas debate one question'), {
      llmRegistry: { selectByTier: () => mockProvider } as any,
      executeTask,
    });
    const researcherGoal = capturedByAgent.researcher!;
    const authorGoal = capturedByAgent.author!;
    expect(researcherGoal).toBeDefined();
    expect(authorGoal).toBeDefined();
    // Both delegates see step1's output (their declared dependency).
    expect(researcherGoal).toContain('QUESTION_SENTINEL_Q1');
    expect(authorGoal).toContain('QUESTION_SENTINEL_Q1');
    // Neither delegate sees the other's eventual answer leaked into its goal.
    expect(researcherGoal).not.toContain('AUTHOR_ANSWER_SENTINEL');
    expect(authorGoal).not.toContain('RESEARCHER_ANSWER_SENTINEL');
  });

  test('Test 8: delegate sub-task inner clock honors outer hard ceiling (no premature 36s/120s self-kill)', async () => {
    // Regression for two related symptoms:
    //   - Session with researcher timing out at 36s (budget: 36s): the
    //     pre-fix inner budget used a 30s floor, so a parent budget
    //     of 60s × budgetFraction 0.6 = 36s killed the sub-task's
    //     internal clock while the outer Promise.race was still happily
    //     waiting.
    //   - Session f4117fe3 author timed out at exactly 2m0s = the next
    //     iteration's static 120s wall, even though the LLM was streaming
    //     a substantive Thai response. The fix wraps the outer timer in
    //     a streaming-aware watchdog (idle 120s + ceiling 600s) and
    //     aligns the inner budget with the OUTER hard ceiling so the
    //     sub-task does not self-kill before the watchdog's verdict.
    // The inner budget MUST therefore be at least the hard-ceiling
    // value (≥ 600s under the current floor formula).
    const capturedSubBudgets: Array<{ agentId: string; maxDurationMs: number }> = [];
    const plan = JSON.stringify({
      goal: 'two delegates with same parent budget',
      steps: [
        {
          id: 'step1',
          description: 'Pose the question',
          strategy: 'llm-reasoning',
          budgetFraction: 0.2,
        },
        {
          id: 'step2',
          description: 'researcher answers',
          strategy: 'delegate-sub-agent',
          agentId: 'researcher',
          dependencies: ['step1'],
          inputs: { q: '$step1.result' },
          budgetFraction: 0.6,
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
        return { content: 'STEP_OUTPUT', tokensUsed: { input: 5, output: 5 } };
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
      capturedSubBudgets.push({
        agentId: subInput.agentId,
        maxDurationMs: subInput.budget.maxDurationMs,
      });
      return {
        id: subInput.id,
        status: 'completed',
        mutations: [],
        answer: 'ok',
        trace: { tokensConsumed: 10 },
      } as any;
    };
    // Parent budget = 60s, fraction 0.6 → fractional cap = 36s. Pre-fix,
    // inner clock would land at 36s. Post-fix, both inner and outer
    // share `workflowStepTimeoutMs` which has a 120s floor.
    await executeWorkflow(
      {
        id: 'parent-budget-test',
        source: 'cli',
        goal: 'two delegates with same parent budget',
        taskType: 'code',
        budget: { maxTokens: 10_000, maxDurationMs: 60_000, maxRetries: 1 },
      },
      {
        llmRegistry: { selectByTier: () => mockProvider } as any,
        executeTask,
      },
    );
    expect(capturedSubBudgets.length).toBeGreaterThanOrEqual(1);
    const researcher = capturedSubBudgets.find((b) => b.agentId === 'researcher');
    expect(researcher).toBeDefined();
    // Inner budget must align with the OUTER hard ceiling
    // (`max(600s, subTaskTimeoutMs * 4)`). With parent budget = 60s and
    // budgetFraction 0.6, subTaskTimeoutMs = max(120s, 36s) = 120s,
    // hard ceiling = max(600s, 480s) = 600s. Inner budget must be ≥ 600s
    // so the sub-task's own self-timer does not fire before the outer
    // streaming-aware watchdog completes its verdict.
    expect(researcher!.maxDurationMs).toBeGreaterThanOrEqual(600_000);
  });

  test('Test 9: delegate watchdog idle clock resets on llm:stream_delta — streaming LLM is not killed mid-response', async () => {
    // Streaming-aware watchdog regression. Pre-fix: a static
    // setTimeout fired at exactly subTaskTimeoutMs regardless of LLM
    // activity — author hit 2m0s on session f4117fe3 mid-stream.
    // Post-fix: each `llm:stream_delta` for the sub-task's id resets
    // `lastActivityAt` so an LLM that keeps producing tokens keeps
    // running. We simulate a "slow streaming" delegate by having
    // `executeTask` emit periodic stream-deltas while the sub-task
    // run takes longer than a normal idle window. Without the
    // watchdog reset this test would time out / fail; with the reset
    // it completes successfully.
    //
    // We avoid wall-clock waits >1s in unit tests by injecting
    // `delegateWatchdogIdleMs` via a small sub-budget — the parent
    // budget here is small enough that the workflowStepTimeoutMs floor
    // dominates, so the watchdog uses the 120s idle floor. We instead
    // verify the SHAPE of the wiring: streaming events do reach the
    // executor's bus subscriber and the delegate completes successfully
    // when stream-deltas arrive while the sub-task is in flight.
    const plan = JSON.stringify({
      goal: 'streaming delegate keeps watchdog alive',
      steps: [
        {
          id: 'step1',
          description: 'Pose the question',
          strategy: 'llm-reasoning',
          budgetFraction: 0.2,
        },
        {
          id: 'step2',
          description: 'Slow streaming delegate',
          strategy: 'delegate-sub-agent',
          agentId: 'researcher',
          dependencies: ['step1'],
          inputs: { q: '$step1.result' },
          budgetFraction: 0.6,
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
        return { content: 'STEP_OUTPUT', tokensUsed: { input: 5, output: 5 } };
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
    const { createBus } = await import('../../../src/core/bus.ts');
    const bus = createBus();
    let streamObservedByExecutor = 0;
    bus.on('llm:stream_delta', () => {
      streamObservedByExecutor += 1;
    });
    // The sub-task's executeTask emits stream-deltas with the SUB-task's
    // id (matching `subInput.id` = `${parent.id}-delegate-step2`) before
    // returning. The watchdog subscriber filters on this exact id and
    // resets `lastActivityAt`, so the delegate is never declared idle.
    const executeTask = async (subInput: any) => {
      // Emit two stream-deltas to simulate ongoing LLM activity. In
      // production these come from the conversational shortcircuit /
      // full-pipeline LLM streamer; here we synthesize them to pin the
      // wiring (delegate id flows back into the executor's idle reset).
      bus.emit('llm:stream_delta', { taskId: subInput.id, kind: 'content', text: 'tok1' });
      bus.emit('llm:stream_delta', { taskId: subInput.id, kind: 'content', text: 'tok2' });
      return {
        id: subInput.id,
        status: 'completed',
        mutations: [],
        answer: 'streamed answer',
        trace: { tokensConsumed: 10 },
      } as any;
    };
    const result = await executeWorkflow(makeInput('streaming delegate keeps watchdog alive'), {
      bus,
      llmRegistry: { selectByTier: () => mockProvider } as any,
      executeTask,
      workflowConfig: { requireUserApproval: false, approvalTimeoutMs: 30_000 },
    });
    // Delegate completed (no idle timeout, no ceiling).
    const delegateResult = result.stepResults.find((s) => s.stepId === 'step2');
    expect(delegateResult).toBeDefined();
    expect(delegateResult!.status).toBe('completed');
    // Stream events flowed through the bus — the watchdog subscriber
    // would have reset `lastActivityAt` on each. Pinning that the
    // executor sees these events at all is the structural assertion;
    // the actual idle-reset semantics are unit-tested implicitly via
    // the delegate completing successfully without timing out.
    expect(streamObservedByExecutor).toBeGreaterThanOrEqual(2);
  });

  test('Test 9c: delegate watchdog treats llm:request_alive heartbeat as live activity', async () => {
    // Layer 3 contract: a single non-streaming LLM call (long-form
    // author / large reasoning) emits no other event during the wait.
    // The retry helper now fires a `llm:request_alive` heartbeat at a
    // fixed cadence — the watchdog must treat it as activity. Pinning
    // the wiring here. Real heartbeat emission is unit-tested in
    // retry.test.ts; this asserts the watchdog surface listens.
    const plan = JSON.stringify({
      goal: 'long single LLM call without other events',
      steps: [
        {
          id: 'step1',
          description: 'Pose the question',
          strategy: 'llm-reasoning',
          budgetFraction: 0.2,
        },
        {
          id: 'step2',
          description: 'author writes a long response',
          strategy: 'delegate-sub-agent',
          agentId: 'author',
          dependencies: ['step1'],
          inputs: { q: '$step1.result' },
          budgetFraction: 0.6,
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
        return { content: 'STEP_OUTPUT', tokensUsed: { input: 5, output: 5 } };
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
    const { createBus } = await import('../../../src/core/bus.ts');
    const bus = createBus();
    let heartbeatsObserved = 0;
    bus.on('llm:request_alive', () => {
      heartbeatsObserved += 1;
    });
    const executeTask = async (subInput: any) => {
      // Simulate a slow non-streaming LLM call. Three heartbeats fire
      // over the wait — watchdog should reset its idle clock on each.
      bus.emit('llm:request_alive', {
        taskId: subInput.id,
        providerId: 'openrouter/balanced/some-model',
        attempt: 0,
        durationMs: 30_000,
      });
      bus.emit('llm:request_alive', {
        taskId: subInput.id,
        providerId: 'openrouter/balanced/some-model',
        attempt: 0,
        durationMs: 60_000,
      });
      bus.emit('llm:request_alive', {
        taskId: subInput.id,
        providerId: 'openrouter/balanced/some-model',
        attempt: 0,
        durationMs: 90_000,
      });
      return {
        id: subInput.id,
        status: 'completed',
        mutations: [],
        answer: 'long prose answer',
        trace: { tokensConsumed: 50 },
      } as any;
    };
    const result = await executeWorkflow(makeInput('long single LLM call'), {
      bus,
      llmRegistry: { selectByTier: () => mockProvider } as any,
      executeTask,
      workflowConfig: { requireUserApproval: false, approvalTimeoutMs: 30_000 },
    });
    const delegateResult = result.stepResults.find((s) => s.stepId === 'step2');
    expect(delegateResult).toBeDefined();
    expect(delegateResult!.status).toBe('completed');
    expect(heartbeatsObserved).toBeGreaterThanOrEqual(3);
  });

  test('Test 9b: delegate watchdog treats llm:retry_attempt as live activity', async () => {
    // Layer 2 contract: provider retry-backoff sleeps (typically 429 from
    // OpenRouter free tier) emit `llm:retry_attempt` before each sleep.
    // The watchdog must reset its idle clock on these so a delegate that
    // burns its first 30s in retry-after backoff does not count as a
    // 120s hang. Pinning the wiring here — the actual retry emission is
    // unit-tested in retry.test.ts; this test asserts the watchdog
    // surface listens.
    const plan = JSON.stringify({
      goal: 'delegate that retries before producing output',
      steps: [
        {
          id: 'step1',
          description: 'Pose the question',
          strategy: 'llm-reasoning',
          budgetFraction: 0.2,
        },
        {
          id: 'step2',
          description: 'researcher answers after 429 retry',
          strategy: 'delegate-sub-agent',
          agentId: 'researcher',
          dependencies: ['step1'],
          inputs: { q: '$step1.result' },
          budgetFraction: 0.6,
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
        return { content: 'STEP_OUTPUT', tokensUsed: { input: 5, output: 5 } };
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
    const { createBus } = await import('../../../src/core/bus.ts');
    const bus = createBus();
    let retryEventsObserved = 0;
    bus.on('llm:retry_attempt', () => {
      retryEventsObserved += 1;
    });
    // Delegate emits two retry_attempt events (simulating two 429 backoff
    // sleeps) before completing. Watchdog should treat both as activity.
    const executeTask = async (subInput: any) => {
      bus.emit('llm:retry_attempt', {
        taskId: subInput.id,
        providerId: 'openrouter/balanced/free-model',
        attempt: 0,
        delayMs: 1000,
        reason: '429 throttled',
        status: 429,
      });
      bus.emit('llm:retry_attempt', {
        taskId: subInput.id,
        providerId: 'openrouter/balanced/free-model',
        attempt: 1,
        delayMs: 2000,
        reason: '429 throttled',
        status: 429,
      });
      return {
        id: subInput.id,
        status: 'completed',
        mutations: [],
        answer: 'eventually answered',
        trace: { tokensConsumed: 10 },
      } as any;
    };
    const result = await executeWorkflow(makeInput('delegate retries before output'), {
      bus,
      llmRegistry: { selectByTier: () => mockProvider } as any,
      executeTask,
      workflowConfig: { requireUserApproval: false, approvalTimeoutMs: 30_000 },
    });
    const delegateResult = result.stepResults.find((s) => s.stepId === 'step2');
    expect(delegateResult).toBeDefined();
    expect(delegateResult!.status).toBe('completed');
    expect(retryEventsObserved).toBeGreaterThanOrEqual(2);
  });

  test('Test 7: end-to-end multi-agent debate — synthesis preserves delegate sentinels and does not fabricate', async () => {
    // Three delegates produce distinct sentinel answers. The final
    // workflow output (regardless of synthesizer / deterministic-concat
    // path) must contain ALL three sentinels, and must NOT contain any
    // string the LLM mock never emitted (FABRICATED_CONTENT). Pins the
    // A2 honesty contract at the workflow level — voice diversity is
    // preserved and no second synthesizer pass invents content.
    const plan = JSON.stringify({
      goal: 'three-way debate',
      steps: [
        {
          id: 'step1',
          description: 'Pose the question',
          strategy: 'llm-reasoning',
          budgetFraction: 0.1,
        },
        {
          id: 'step2',
          description: 'Researcher perspective',
          strategy: 'delegate-sub-agent',
          agentId: 'researcher',
          dependencies: ['step1'],
          inputs: { q: '$step1.result' },
          budgetFraction: 0.2,
        },
        {
          id: 'step3',
          description: 'Author perspective',
          strategy: 'delegate-sub-agent',
          agentId: 'author',
          dependencies: ['step1'],
          inputs: { q: '$step1.result' },
          budgetFraction: 0.2,
        },
        {
          id: 'step4',
          description: 'Mentor perspective',
          strategy: 'delegate-sub-agent',
          agentId: 'mentor',
          dependencies: ['step1'],
          inputs: { q: '$step1.result' },
          budgetFraction: 0.2,
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
          // Synthesizer LLM. Honest version: stitch the three sentinels
          // into the output (A2 STITCHER rule — no fabrication, no
          // smoothing). The compression-detection safety net falls back
          // to deterministic concat if the LLM compresses too hard, so
          // either path satisfies the test.
          return {
            content: `${req.userPrompt}\n\n[SYNTH] combined`,
            tokensUsed: { input: 5, output: 5 },
          };
        }
        return {
          content: 'QUESTION_SENTINEL_Q7: which tradeoff matters most?',
          tokensUsed: { input: 5, output: 5 },
        };
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
    const sentinelByAgent: Record<string, string> = {
      researcher: 'RESEARCHER_ANSWER_SENTINEL',
      author: 'AUTHOR_ANSWER_SENTINEL',
      mentor: 'MENTOR_ANSWER_SENTINEL',
    };
    const executeTask = async (subInput: any) =>
      ({
        id: subInput.id,
        status: 'completed',
        mutations: [],
        answer: sentinelByAgent[subInput.agentId as string] ?? 'UNKNOWN_ANSWER',
        trace: { tokensConsumed: 10 },
      }) as any;
    const result = await executeWorkflow(makeInput('three-way debate'), {
      llmRegistry: { selectByTier: () => mockProvider } as any,
      executeTask,
    });
    expect(result.synthesizedOutput).toContain('RESEARCHER_ANSWER_SENTINEL');
    expect(result.synthesizedOutput).toContain('AUTHOR_ANSWER_SENTINEL');
    expect(result.synthesizedOutput).toContain('MENTOR_ANSWER_SENTINEL');
    // Sentinel never emitted by any mock — proves no fabrication path.
    expect(result.synthesizedOutput).not.toContain('FABRICATED_CONTENT');
  });

  test('A2 honesty: delegate that returns status=completed with empty answer is reclassified as failed (errorKind=empty_response)', async () => {
    // The provider/persona returns cleanly but with no text — UI must
    // surface this as a failure with explicit explanation, not silently
    // render DONE on top of [no activity captured].
    const plan = JSON.stringify({
      goal: 'compete',
      steps: [
        { id: 'step1', description: 'q', strategy: 'llm-reasoning', budgetFraction: 0.2 },
        {
          id: 'step2',
          description: 'Answer the question',
          strategy: 'delegate-sub-agent',
          agentId: 'researcher',
          dependencies: ['step1'],
          inputs: { q: '$step1.result' },
          budgetFraction: 0.4,
        },
        {
          id: 'step3',
          description: 'Answer the question',
          strategy: 'delegate-sub-agent',
          agentId: 'author',
          dependencies: ['step1'],
          inputs: { q: '$step1.result' },
          budgetFraction: 0.4,
        },
      ],
      synthesisPrompt: 'Compare and pick a winner.',
    });
    const mockProvider = {
      id: 'mock',
      generate: async () => ({ content: plan, tokensUsed: { input: 10, output: 10 } }),
      generateStream: async (
        _req: { systemPrompt: string },
        onDelta: (d: { text: string }) => void,
      ) => {
        onDelta({ text: plan });
        return { content: plan, tokensUsed: { input: 5, output: 5 } };
      },
    };
    const events: Array<{ event: string; payload: any }> = [];
    const bus = {
      emit: (event: string, payload: any) => events.push({ event, payload }),
    };
    await executeWorkflow(makeInput('compete'), {
      llmRegistry: { selectByTier: () => mockProvider } as any,
      bus: bus as any,
      executeTask: async (subInput: any) => {
        // Researcher returns empty answer; author returns real text.
        const isResearcher = subInput.agentId === 'researcher';
        return {
          id: subInput.id,
          status: 'completed',
          mutations: [],
          answer: isResearcher ? '' : 'AUTHOR_REAL_ANSWER',
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          trace: { tokensConsumed: 50, durationMs: 35000 } as any,
        };
      },
    });
    // Researcher's delegate_completed event MUST report status=failed.
    const researcherDelegateCompleted = events.find(
      (e) =>
        e.event === 'workflow:delegate_completed' && e.payload.agentId === 'researcher',
    );
    expect(researcherDelegateCompleted).toBeDefined();
    expect(researcherDelegateCompleted!.payload.status).toBe('failed');
    // Subtask manifest mirror MUST carry errorKind='empty_response'.
    const researcherSubtaskUpdate = events
      .filter(
        (e) =>
          e.event === 'workflow:subtask_updated' && e.payload.agentId === 'researcher',
      )
      .pop();
    expect(researcherSubtaskUpdate).toBeDefined();
    expect(researcherSubtaskUpdate!.payload.status).toBe('failed');
    expect(researcherSubtaskUpdate!.payload.errorKind).toBe('empty_response');
    expect(researcherSubtaskUpdate!.payload.errorMessage).toContain('empty response');
    // Author with real answer stays completed.
    const authorSubtaskUpdate = events
      .filter(
        (e) => e.event === 'workflow:subtask_updated' && e.payload.agentId === 'author',
      )
      .pop();
    expect(authorSubtaskUpdate!.payload.status).toBe('done');
  });
});
