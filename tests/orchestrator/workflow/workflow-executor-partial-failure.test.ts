/**
 * Tests for the partial-failure decision gate added in 2026-04-30.
 *
 * Background — image-4 reproduction (incident 2026-04-29): when one of
 * three delegates timed out (author, 5m5s) the executor cascade-skipped the
 * Compare step (which depended on all three) and silently shipped a
 * deterministic concat of the surviving two delegates as the final answer.
 * The user wanted a runtime decision card before that ship — pause, ask
 * the user "continue with partial / abort", and only proceed on their
 * explicit choice.
 *
 * What this file pins:
 *   - emits `workflow:partial_failure_decision_needed` with the right
 *     failed/skipped/completed step ids + a partialPreview excerpt
 *   - on `decision='continue'` the executor proceeds and result.status
 *     stays 'partial' (caller's existing aggregation behaviour)
 *   - on `decision='abort'` result.status flips to 'failed' and
 *     synthesizedOutput is the rationale (no partial answer leak)
 *   - on timeout the executor self-emits an `auto: true` _provided event
 *     and aborts with a timeout-specific rationale
 *   - sub-tasks (input.parentTaskId set) BYPASS the gate — the parent's
 *     gate covers the user surface
 *   - leaf failure (no cascade-skip) does NOT trigger the gate — only
 *     true partial-answer-cannot-deliver scenarios pause
 */
import { describe, expect, test } from 'bun:test';
import { createBus } from '../../../src/core/bus.ts';
import type { TaskInput } from '../../../src/orchestrator/types.ts';
import { executeWorkflow } from '../../../src/orchestrator/workflow/workflow-executor.ts';

function makeInput(goal: string, overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 'task-pf-1',
    source: 'cli',
    goal,
    taskType: 'reasoning',
    budget: { maxTokens: 10_000, maxDurationMs: 60_000, maxRetries: 1 },
    ...overrides,
  };
}

// 3 delegates + Compare step that depends on all of them. Mirrors the
// image-4 plan shape (researcher / author / mentor + a Compare aggregator).
const THREE_AGENTS_WITH_COMPARE = JSON.stringify({
  goal: 'three agents debate then compare',
  steps: [
    {
      id: 'step1',
      description: 'researcher answers',
      strategy: 'delegate-sub-agent',
      agentId: 'researcher',
      budgetFraction: 0.25,
    },
    {
      id: 'step2',
      description: 'author answers',
      strategy: 'delegate-sub-agent',
      agentId: 'author',
      budgetFraction: 0.25,
    },
    {
      id: 'step3',
      description: 'mentor answers',
      strategy: 'delegate-sub-agent',
      agentId: 'mentor',
      budgetFraction: 0.25,
    },
    {
      id: 'step4',
      description: 'Compare the three answers',
      strategy: 'llm-reasoning',
      dependencies: ['step1', 'step2', 'step3'],
      budgetFraction: 0.25,
    },
  ],
  synthesisPrompt: 'Combine.',
});

function makeProvider(planJson: string) {
  const generate = async (req: { systemPrompt: string }) => {
    if (req.systemPrompt.includes('workflow planner')) {
      return { content: planJson, tokensUsed: { input: 5, output: 5 } };
    }
    return { content: 'noop', tokensUsed: { input: 5, output: 5 } };
  };
  return {
    id: 'mock',
    generate,
    generateStream: async (
      req: { systemPrompt: string; userPrompt: string },
      onDelta: (d: { text: string }) => void,
    ) => {
      const r = await generate(req);
      onDelta({ text: r.content });
      return r;
    },
  };
}

// Sub-agent dispatch where author always fails (image-4 reproduction).
function makeExecuteTaskWithAuthorFail() {
  return async (subInput: { id: string; agentId?: string }) => {
    if (subInput.agentId === 'author') {
      return {
        id: subInput.id,
        status: 'failed',
        mutations: [],
        answer: 'timed out after 300s',
        trace: { tokensConsumed: 0 },
      } as unknown as Record<string, unknown>;
    }
    return {
      id: subInput.id,
      status: 'completed',
      mutations: [],
      answer: `${subInput.agentId ?? 'agent'} REAL ANSWER`,
      trace: { tokensConsumed: 10 },
    } as unknown as Record<string, unknown>;
  };
}

describe('executeWorkflow — partial-failure decision gate', () => {
  test('emits decision_needed with failed/skipped/completed step ids when cascade-skip happens', async () => {
    const bus = createBus();
    const events: Array<{ name: string; payload: unknown }> = [];
    bus.on('workflow:partial_failure_decision_needed', (p) =>
      events.push({ name: 'needed', payload: p }),
    );

    // Resolve the gate on first emit so the run terminates.
    const unsub = bus.on('workflow:partial_failure_decision_needed', (p) => {
      unsub();
      bus.emit('workflow:partial_failure_decision_provided', {
        taskId: p.taskId,
        decision: 'continue',
      });
    });

    const result = await executeWorkflow(makeInput('three agents'), {
      bus,
      llmRegistry: { selectByTier: () => makeProvider(THREE_AGENTS_WITH_COMPARE) } as any,
      executeTask: makeExecuteTaskWithAuthorFail() as any,
      workflowConfig: { requireUserApproval: false, approvalTimeoutMs: 30_000 },
    });

    expect(events.length).toBeGreaterThanOrEqual(1);
    const payload = events[0]!.payload as {
      taskId: string;
      failedStepIds: string[];
      skippedStepIds: string[];
      completedStepIds: string[];
      summary: string;
      partialPreview?: string;
      timeoutMs: number;
    };
    expect(payload.taskId).toBe('task-pf-1');
    // author (step2) failed; researcher (step1) + mentor (step3) succeeded;
    // Compare (step4) was cascade-skipped because step2 was its dep.
    expect(payload.failedStepIds).toEqual(['step2']);
    expect(payload.skippedStepIds).toEqual(['step4']);
    expect(payload.completedStepIds.sort()).toEqual(['step1', 'step3']);
    expect(payload.summary).toMatch(/1 of 4 steps failed/);
    expect(payload.summary).toMatch(/1 dependent step skipped/);
    expect(payload.timeoutMs).toBe(30_000);
    // Preview must reference at least one surviving delegate so the user
    // can judge "is partial useful?" without expanding the answer.
    expect(payload.partialPreview).toContain('researcher');
    // status is 'partial' (the user picked continue) and the synthesized
    // output is the existing deterministic aggregation — i.e. the gate is
    // a pure GATE, not a transformer of the result content.
    expect(result.status).toBe('partial');
  });

  test("decision='continue' lets the workflow ship the partial result", async () => {
    const bus = createBus();
    const provided: Array<unknown> = [];
    bus.on('workflow:partial_failure_decision_provided', (p) => provided.push(p));

    const unsub = bus.on('workflow:partial_failure_decision_needed', (p) => {
      unsub();
      bus.emit('workflow:partial_failure_decision_provided', {
        taskId: p.taskId,
        decision: 'continue',
      });
    });

    const result = await executeWorkflow(makeInput('three agents'), {
      bus,
      llmRegistry: { selectByTier: () => makeProvider(THREE_AGENTS_WITH_COMPARE) } as any,
      executeTask: makeExecuteTaskWithAuthorFail() as any,
      workflowConfig: { requireUserApproval: false, approvalTimeoutMs: 30_000 },
    });

    expect(result.status).toBe('partial');
    // Surviving delegates' verbatim outputs must remain in the aggregation
    // — gate must not strip them.
    expect(result.synthesizedOutput).toContain('researcher REAL ANSWER');
    expect(result.synthesizedOutput).toContain('mentor REAL ANSWER');
    // Two _provided events: the user's, plus the executor's echo.
    expect(provided.length).toBeGreaterThanOrEqual(1);
    const echoes = provided.filter((p): p is { decision: string } =>
      typeof (p as { decision?: string }).decision === 'string',
    );
    expect(echoes.some((e) => e.decision === 'continue')).toBe(true);
  });

  test("decision='abort' flips status to failed with rationale", async () => {
    const bus = createBus();

    const unsub = bus.on('workflow:partial_failure_decision_needed', (p) => {
      unsub();
      bus.emit('workflow:partial_failure_decision_provided', {
        taskId: p.taskId,
        decision: 'abort',
        rationale: 'I want to redo step2 before shipping',
      });
    });

    const result = await executeWorkflow(makeInput('three agents'), {
      bus,
      llmRegistry: { selectByTier: () => makeProvider(THREE_AGENTS_WITH_COMPARE) } as any,
      executeTask: makeExecuteTaskWithAuthorFail() as any,
      workflowConfig: { requireUserApproval: false, approvalTimeoutMs: 30_000 },
    });

    expect(result.status).toBe('failed');
    // synthesizedOutput is the rationale, NOT the deterministic aggregation
    // — partial answers must NOT leak through on abort.
    expect(result.synthesizedOutput).toMatch(/User chose to abort/);
    expect(result.synthesizedOutput).not.toContain('researcher REAL ANSWER');
  });

  test('no decision arrives → executor auto-aborts on timeout with auto: true echo', async () => {
    const bus = createBus();
    const provided: Array<{ decision: string; auto?: boolean; rationale?: string }> = [];
    bus.on('workflow:partial_failure_decision_provided', (p) =>
      provided.push(p as { decision: string; auto?: boolean; rationale?: string }),
    );

    const result = await executeWorkflow(makeInput('three agents'), {
      bus,
      llmRegistry: { selectByTier: () => makeProvider(THREE_AGENTS_WITH_COMPARE) } as any,
      executeTask: makeExecuteTaskWithAuthorFail() as any,
      // Tight gate ceiling — no user response will arrive in time.
      workflowConfig: { requireUserApproval: false, approvalTimeoutMs: 60 },
    });

    expect(result.status).toBe('failed');
    expect(result.synthesizedOutput).toMatch(/did not respond/);
    // The executor must have echoed the auto-abort on the bus so observers
    // (UI, recorder) can distinguish a user-driven abort from an auto one.
    const autoEcho = provided.find((p) => p.auto === true);
    expect(autoEcho).toBeDefined();
    expect(autoEcho!.decision).toBe('abort');
  });

  test('sub-task (parentTaskId set) bypasses the gate and returns partial directly', async () => {
    const bus = createBus();
    const events: unknown[] = [];
    bus.on('workflow:partial_failure_decision_needed', (p) => events.push(p));

    const result = await executeWorkflow(
      makeInput('three agents', { id: 'sub-task-1', parentTaskId: 'parent-1' }),
      {
        bus,
        llmRegistry: { selectByTier: () => makeProvider(THREE_AGENTS_WITH_COMPARE) } as any,
        executeTask: makeExecuteTaskWithAuthorFail() as any,
        workflowConfig: { requireUserApproval: false, approvalTimeoutMs: 30_000 },
      },
    );

    expect(events).toHaveLength(0);
    expect(result.status).toBe('partial');
    // Parent's gate (when this sub-task's parent runs) is the user surface;
    // the sub-task ships its partial deterministically.
    expect(result.synthesizedOutput).toContain('researcher REAL ANSWER');
  });

  test('leaf failure with no dependent step does NOT trigger the gate', async () => {
    // 2 delegates, no Compare step. author fails — the result is partial
    // but no dependent step gets cascade-skipped, so the user is not asked.
    // Distinguishes "result is incomplete in shape" from "result delivers
    // less than the user asked for". The latter is what needs the gate.
    const TWO_AGENTS_NO_COMPARE = JSON.stringify({
      goal: 'two agents, no aggregator',
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
      ],
      synthesisPrompt: 'Combine.',
    });
    const bus = createBus();
    const events: unknown[] = [];
    bus.on('workflow:partial_failure_decision_needed', (p) => events.push(p));

    const result = await executeWorkflow(makeInput('two agents'), {
      bus,
      llmRegistry: { selectByTier: () => makeProvider(TWO_AGENTS_NO_COMPARE) } as any,
      executeTask: makeExecuteTaskWithAuthorFail() as any,
      workflowConfig: { requireUserApproval: false, approvalTimeoutMs: 30_000 },
    });

    expect(events).toHaveLength(0);
    expect(result.status).toBe('partial');
  });
});
