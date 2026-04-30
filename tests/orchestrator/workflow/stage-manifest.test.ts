/**
 * Stage Manifest tests — covers both the pure builder (`buildStageManifest`,
 * `classifyDecisionKind`, `classifyGroupMode`) and the executor's emission
 * contract (decision_recorded → todo_created → subtasks_planned → updates).
 *
 * Behavior tests only: every assertion exercises a public helper / an
 * observable bus event, never private internals. Mirrors the style of
 * `workflow-executor.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import type { TaskInput } from '../../../src/orchestrator/types.ts';
import {
  buildStageManifest,
  classifyDecisionKind,
  classifyGroupMode,
  parseWinnerVerdict,
} from '../../../src/orchestrator/workflow/stage-manifest.ts';
import type { WorkflowPlan } from '../../../src/orchestrator/workflow/types.ts';
import { executeWorkflow } from '../../../src/orchestrator/workflow/workflow-executor.ts';

function makePlan(steps: WorkflowPlan['steps'], synthesisPrompt = 'Combine results.'): WorkflowPlan {
  return { goal: 'g', steps, synthesisPrompt };
}

function delegateStep(id: string, agentId?: string): WorkflowPlan['steps'][number] {
  return {
    id,
    description: `do ${id}`,
    strategy: 'delegate-sub-agent',
    dependencies: [],
    inputs: {},
    expectedOutput: 'an answer',
    budgetFraction: 0.3,
    ...(agentId ? { agentId } : {}),
  };
}

function llmStep(id: string): WorkflowPlan['steps'][number] {
  return {
    id,
    description: `analyze ${id}`,
    strategy: 'llm-reasoning',
    dependencies: [],
    inputs: {},
    expectedOutput: '',
    budgetFraction: 0.3,
  };
}

function makeInput(goal = 'test goal'): TaskInput {
  return {
    id: 'task-stage-test',
    source: 'cli',
    goal,
    taskType: 'code',
    sessionId: 'sess-1',
    budget: { maxTokens: 10_000, maxDurationMs: 60_000, maxRetries: 1 },
  };
}

describe('classifyDecisionKind', () => {
  test('two delegate-sub-agent steps → multi-agent', () => {
    const plan = makePlan([delegateStep('s1'), delegateStep('s2')]);
    expect(classifyDecisionKind(plan)).toBe('multi-agent');
  });

  test('one delegate-sub-agent step → single-agent', () => {
    const plan = makePlan([delegateStep('s1')]);
    expect(classifyDecisionKind(plan)).toBe('single-agent');
  });

  test('all direct-tool steps → direct-tool', () => {
    const plan = makePlan([
      {
        id: 's1',
        description: 'ls',
        strategy: 'direct-tool',
        dependencies: [],
        inputs: {},
        expectedOutput: '',
        budgetFraction: 0.5,
      },
    ]);
    expect(classifyDecisionKind(plan)).toBe('direct-tool');
  });

  test('full-pipeline step → full-pipeline', () => {
    const plan = makePlan([
      {
        id: 's1',
        description: 'edit',
        strategy: 'full-pipeline',
        dependencies: [],
        inputs: {},
        expectedOutput: '',
        budgetFraction: 0.5,
      },
    ]);
    expect(classifyDecisionKind(plan)).toBe('full-pipeline');
  });
});

describe('parseWinnerVerdict', () => {
  const PARTICIPATING = ['researcher', 'mentor', 'author'];

  test('parses fenced JSON block with valid winner', () => {
    const text = `Researcher gave the most thorough answer.\n\n\`\`\`json\n{"winner":"researcher","reasoning":"strongest evidence"}\n\`\`\``;
    const verdict = parseWinnerVerdict(text, PARTICIPATING);
    expect(verdict).toBeDefined();
    expect(verdict!.winner).toBe('researcher');
    expect(verdict!.reasoning).toBe('strongest evidence');
  });

  test('accepts winner=null as a deliberate tie', () => {
    const text = `\`\`\`json\n{"winner":null,"reasoning":"all three were equally compelling"}\n\`\`\``;
    const verdict = parseWinnerVerdict(text, PARTICIPATING);
    expect(verdict).toBeDefined();
    expect(verdict!.winner).toBeNull();
  });

  test('rejects hallucinated winner id (not in participating set)', () => {
    const text = `\`\`\`json\n{"winner":"phantom-agent","reasoning":"a ghost"}\n\`\`\``;
    expect(parseWinnerVerdict(text, PARTICIPATING)).toBeUndefined();
  });

  test('returns undefined when no fenced block is present', () => {
    expect(parseWinnerVerdict('Just free-text, no JSON.', PARTICIPATING)).toBeUndefined();
  });

  test('returns undefined when JSON does not parse', () => {
    const text = '```json\n{ broken json\n```';
    expect(parseWinnerVerdict(text, PARTICIPATING)).toBeUndefined();
  });

  test('returns undefined when reasoning is missing or empty', () => {
    expect(
      parseWinnerVerdict('```json\n{"winner":"researcher"}\n```', PARTICIPATING),
    ).toBeUndefined();
    expect(
      parseWinnerVerdict('```json\n{"winner":"researcher","reasoning":""}\n```', PARTICIPATING),
    ).toBeUndefined();
  });

  test('keeps valid scores, drops bad-shape scores', () => {
    const goodText = `\`\`\`json\n${JSON.stringify({
      winner: 'mentor',
      reasoning: 'clear teaching voice',
      scores: { researcher: 7, mentor: 9, author: 8 },
    })}\n\`\`\``;
    const v = parseWinnerVerdict(goodText, PARTICIPATING);
    expect(v?.scores).toEqual({ researcher: 7, mentor: 9, author: 8 });

    // Out-of-range and non-int filtered.
    const partialText = `\`\`\`json\n${JSON.stringify({
      winner: 'mentor',
      reasoning: 'r',
      scores: { researcher: 7.5, mentor: 9, author: 11, phantom: 5 },
    })}\n\`\`\``;
    const partial = parseWinnerVerdict(partialText, PARTICIPATING);
    expect(partial?.scores).toEqual({ mentor: 9 });
  });

  test('uses the LAST fenced json block when multiple present', () => {
    const text = `Step1: \`\`\`json\n{"winner":"author","reasoning":"early take"}\n\`\`\`\nFinal: \`\`\`json\n{"winner":"researcher","reasoning":"considered verdict"}\n\`\`\``;
    const v = parseWinnerVerdict(text, PARTICIPATING);
    expect(v?.winner).toBe('researcher');
  });

  test('runnerUp survives valid id, dropped on hallucinated id', () => {
    const okText = `\`\`\`json\n${JSON.stringify({
      winner: 'researcher',
      runnerUp: 'mentor',
      reasoning: 'r',
    })}\n\`\`\``;
    expect(parseWinnerVerdict(okText, PARTICIPATING)?.runnerUp).toBe('mentor');

    const badText = `\`\`\`json\n${JSON.stringify({
      winner: 'researcher',
      runnerUp: 'phantom',
      reasoning: 'r',
    })}\n\`\`\``;
    expect(parseWinnerVerdict(badText, PARTICIPATING)?.runnerUp).toBeUndefined();
  });
});

describe('classifyGroupMode', () => {
  test('competition keyword in synthesis → competition', () => {
    const plan = makePlan([delegateStep('s1'), delegateStep('s2')], 'Pick the best answer in this competition.');
    expect(classifyGroupMode(plan)).toBe('competition');
  });

  test('debate keyword in synthesis → debate', () => {
    const plan = makePlan([delegateStep('s1'), delegateStep('s2')], 'Use the debate format to compare arguments.');
    expect(classifyGroupMode(plan)).toBe('debate');
  });

  test('single-agent plan → undefined', () => {
    const plan = makePlan([delegateStep('s1')]);
    expect(classifyGroupMode(plan)).toBeUndefined();
  });

  test('multi-agent default → comparison', () => {
    const plan = makePlan([delegateStep('s1'), delegateStep('s2')]);
    expect(classifyGroupMode(plan)).toBe('comparison');
  });
});

describe('buildStageManifest', () => {
  test('produces todo entry per plan step with stable ids', () => {
    const plan = makePlan([llmStep('step1'), llmStep('step2')]);
    const m = buildStageManifest({
      taskId: 'task-1',
      sessionId: 'sess-1',
      userPrompt: 'goal',
      plan,
    });
    expect(m.todoList).toHaveLength(2);
    expect(m.todoList.map((t) => t.id)).toEqual(['todo-step1', 'todo-step2']);
    expect(m.todoList.every((t) => t.status === 'pending')).toBe(true);
    expect(m.todoList[0]!.sourceStepId).toBe('step1');
  });

  test('produces multi-agent subtask record per delegate step with deterministic fallback labels', () => {
    const plan = makePlan([delegateStep('s1'), delegateStep('s2'), delegateStep('s3')]);
    const m = buildStageManifest({
      taskId: 'parent',
      sessionId: 'sess-1',
      userPrompt: 'แบ่ง Agent 3 ตัว แข่งกันถามตอบ',
      plan,
    });
    expect(m.multiAgentSubtasks).toHaveLength(3);
    expect(m.multiAgentSubtasks.map((s) => s.fallbackLabel)).toEqual(['Agent 1', 'Agent 2', 'Agent 3']);
    expect(m.multiAgentSubtasks.map((s) => s.subtaskId)).toEqual([
      'parent-delegate-s1',
      'parent-delegate-s2',
      'parent-delegate-s3',
    ]);
    expect(m.multiAgentSubtasks.every((s) => s.status === 'planned')).toBe(true);
  });

  test('non-delegate steps get ownerType=system, delegate steps ownerType=agent', () => {
    const plan = makePlan([llmStep('step1'), delegateStep('step2', 'developer')]);
    const m = buildStageManifest({
      taskId: 'task-2',
      userPrompt: 'g',
      plan,
    });
    expect(m.todoList[0]!.ownerType).toBe('system');
    expect(m.todoList[1]!.ownerType).toBe('agent');
    expect(m.todoList[1]!.ownerId).toBe('developer');
  });

  test('decision is multi-agent when ≥2 delegate-sub-agent steps', () => {
    const plan = makePlan([delegateStep('s1'), delegateStep('s2')]);
    const m = buildStageManifest({ taskId: 't', userPrompt: 'g', plan });
    expect(m.decision.decisionKind).toBe('multi-agent');
  });
});

describe('executeWorkflow — stage manifest emissions', () => {
  test('every plan step emits running and done todo_updated events (no stale pending)', async () => {
    // Reproduces the user-flagged "1 done · 3 running · 1 pending" symptom
    // where the historical replay surface showed a stale todo counter
    // because the post-dispatch todo_updated emissions were not landing.
    // Multi-iteration plan (1 → 3 in parallel → 1) drives the while loop
    // through three dispatch waves; every step must fire 'running' THEN
    // 'done' so the StageManifestSurface counter shows 5/5.
    const validPlan = JSON.stringify({
      goal: 'cascade',
      steps: [
        { id: 'step1', description: 'q', strategy: 'llm-reasoning', budgetFraction: 0.2 },
        {
          id: 'step2',
          description: 'a',
          strategy: 'delegate-sub-agent',
          dependencies: ['step1'],
          budgetFraction: 0.2,
        },
        {
          id: 'step3',
          description: 'a',
          strategy: 'delegate-sub-agent',
          dependencies: ['step1'],
          budgetFraction: 0.2,
        },
        {
          id: 'step4',
          description: 'a',
          strategy: 'delegate-sub-agent',
          dependencies: ['step1'],
          budgetFraction: 0.2,
        },
        {
          id: 'step5',
          description: 'compare',
          strategy: 'llm-reasoning',
          dependencies: ['step2', 'step3', 'step4'],
          budgetFraction: 0.2,
        },
      ],
      synthesisPrompt: 'Compare answers.',
    });
    const mockProvider = {
      id: 'mock',
      generate: async (req: { systemPrompt: string }) => {
        if (req.systemPrompt.includes('workflow planner')) {
          return { content: validPlan, tokensUsed: { input: 5, output: 5 } };
        }
        return { content: 'ok', tokensUsed: { input: 5, output: 5 } };
      },
    };
    const events: Array<{ event: string; payload: unknown }> = [];
    const bus = {
      emit: (event: string, payload: unknown) => events.push({ event, payload }),
    };
    await executeWorkflow(makeInput('cascade'), {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      llmRegistry: { selectByTier: () => mockProvider } as any,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      bus: bus as any,
      executeTask: async (sub) => ({
        id: sub.id,
        status: 'completed',
        mutations: [],
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        trace: { tokensConsumed: 1 } as any,
        answer: `answer-${sub.id}`,
      }),
    });

    const todoUpdates = events
      .filter((e) => e.event === 'workflow:todo_updated')
      .map((e) => e.payload as { todoId: string; status: string });

    // Group by todoId — every step must transition running → done.
    const byTodo = new Map<string, string[]>();
    for (const u of todoUpdates) {
      const arr = byTodo.get(u.todoId) ?? [];
      arr.push(u.status);
      byTodo.set(u.todoId, arr);
    }
    for (const stepId of ['step1', 'step2', 'step3', 'step4', 'step5']) {
      const transitions = byTodo.get(`todo-${stepId}`);
      expect(transitions).toBeDefined();
      expect(transitions).toEqual(['running', 'done']);
    }
  });

  test('emits decision_recorded + todo_created BEFORE any step runs', async () => {
    const validPlan = JSON.stringify({
      goal: 'two-step',
      steps: [
        { id: 'step1', description: 'first', strategy: 'llm-reasoning', budgetFraction: 0.5 },
        {
          id: 'step2',
          description: 'second',
          strategy: 'llm-reasoning',
          dependencies: ['step1'],
          budgetFraction: 0.5,
        },
      ],
      synthesisPrompt: 'Done.',
    });
    const mockProvider = {
      id: 'mock',
      generate: async (req: { systemPrompt: string }) => {
        if (req.systemPrompt.includes('workflow planner')) {
          return { content: validPlan, tokensUsed: { input: 10, output: 10 } };
        }
        return { content: 'out', tokensUsed: { input: 5, output: 5 } };
      },
    };
    const events: Array<{ event: string; payload: unknown }> = [];
    const bus = {
      emit: (event: string, payload: unknown) => {
        events.push({ event, payload });
      },
    };
    const result = await executeWorkflow(makeInput('two-step'), {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      llmRegistry: { selectByTier: () => mockProvider } as any,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      bus: bus as any,
    });
    expect(result.status).toBe('completed');

    // decision_recorded fires before any step_start; both fire before
    // workflow:complete. Check by index in the captured event log.
    const decisionIdx = events.findIndex((e) => e.event === 'workflow:decision_recorded');
    const todoIdx = events.findIndex((e) => e.event === 'workflow:todo_created');
    const stepStartIdx = events.findIndex((e) => e.event === 'workflow:step_start');
    expect(decisionIdx).toBeGreaterThanOrEqual(0);
    expect(todoIdx).toBeGreaterThanOrEqual(0);
    expect(stepStartIdx).toBeGreaterThan(0);
    expect(decisionIdx).toBeLessThan(stepStartIdx);
    expect(todoIdx).toBeLessThan(stepStartIdx);

    const decisionPayload = events[decisionIdx]!.payload as {
      taskId: string;
      sessionId?: string;
      decision: { decisionKind: string; userPrompt: string };
    };
    expect(decisionPayload.taskId).toBe('task-stage-test');
    expect(decisionPayload.sessionId).toBe('sess-1');
    expect(decisionPayload.decision.decisionKind).toBe('single-agent');
    expect(decisionPayload.decision.userPrompt).toBe('two-step');

    const todoPayload = events[todoIdx]!.payload as {
      taskId: string;
      todoList: Array<{ id: string; sourceStepId: string }>;
    };
    expect(todoPayload.todoList).toHaveLength(2);
    expect(todoPayload.todoList.map((t) => t.sourceStepId)).toEqual(['step1', 'step2']);
  });

  test('multi-agent plan emits subtasks_planned with one entry per delegate', async () => {
    const validPlan = JSON.stringify({
      goal: 'multi',
      steps: [
        { id: 's1', description: 'q', strategy: 'llm-reasoning', budgetFraction: 0.25 },
        {
          id: 's2',
          description: 'answer',
          strategy: 'delegate-sub-agent',
          dependencies: ['s1'],
          inputs: { q: '$s1.result' },
          budgetFraction: 0.25,
        },
        {
          id: 's3',
          description: 'answer',
          strategy: 'delegate-sub-agent',
          dependencies: ['s1'],
          inputs: { q: '$s1.result' },
          budgetFraction: 0.25,
        },
        {
          id: 's4',
          description: 'compare',
          strategy: 'llm-reasoning',
          dependencies: ['s2', 's3'],
          budgetFraction: 0.25,
        },
      ],
      synthesisPrompt: 'Compare the answers in this competition.',
    });
    const mockProvider = {
      id: 'mock',
      generate: async (req: { systemPrompt: string }) => {
        if (req.systemPrompt.includes('workflow planner')) {
          return { content: validPlan, tokensUsed: { input: 5, output: 5 } };
        }
        return { content: 'partial', tokensUsed: { input: 5, output: 5 } };
      },
    };
    const events: Array<{ event: string; payload: unknown }> = [];
    const bus = {
      emit: (event: string, payload: unknown) => events.push({ event, payload }),
    };
    // Subtask paths use deps.executeTask for dispatch — give it a stub that
    // immediately reports success with an answer so subtask_updated fires
    // through the success branch.
    await executeWorkflow(makeInput('multi'), {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      llmRegistry: { selectByTier: () => mockProvider } as any,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      bus: bus as any,
      executeTask: async (sub) => ({
        id: sub.id,
        status: 'completed',
        mutations: [],
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        trace: { tokensConsumed: 1 } as any,
        answer: `answer-${sub.id}`,
      }),
    });

    const planned = events.find((e) => e.event === 'workflow:subtasks_planned');
    expect(planned).toBeDefined();
    const payload = planned!.payload as {
      subtasks: Array<{ subtaskId: string; stepId: string; fallbackLabel: string }>;
      groupMode?: string;
    };
    expect(payload.subtasks).toHaveLength(2);
    expect(payload.subtasks.map((s) => s.fallbackLabel)).toEqual(['Agent 1', 'Agent 2']);
    expect(payload.groupMode).toBe('competition');

    // Each subtask transitions running → done with the right subtaskId pinned.
    const updates = events.filter((e) => e.event === 'workflow:subtask_updated');
    const byStep = new Map<string, string[]>();
    for (const u of updates) {
      const p = u.payload as { stepId: string; status: string };
      const arr = byStep.get(p.stepId) ?? [];
      arr.push(p.status);
      byStep.set(p.stepId, arr);
    }
    expect(byStep.get('s2')).toEqual(['running', 'done']);
    expect(byStep.get('s3')).toEqual(['running', 'done']);
  });

  test('failed delegate emits subtask_updated with structured errorKind + errorMessage', async () => {
    const validPlan = JSON.stringify({
      goal: 'one delegate',
      steps: [
        {
          id: 's1',
          description: 'answer',
          strategy: 'delegate-sub-agent',
          budgetFraction: 0.5,
        },
      ],
      synthesisPrompt: 'Combine.',
    });
    const mockProvider = {
      id: 'mock',
      generate: async (req: { systemPrompt: string }) => {
        if (req.systemPrompt.includes('workflow planner')) {
          return { content: validPlan, tokensUsed: { input: 5, output: 5 } };
        }
        return { content: 'unused', tokensUsed: { input: 5, output: 5 } };
      },
    };
    const events: Array<{ event: string; payload: unknown }> = [];
    const bus = {
      emit: (event: string, payload: unknown) => events.push({ event, payload }),
      // No `.on` — watchdog branch falls through (no liveness wiring) which
      // matches the legacy minimal-mock setup used by existing tests.
    };
    await executeWorkflow(makeInput('one delegate'), {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      llmRegistry: { selectByTier: () => mockProvider } as any,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      bus: bus as any,
      // Sub-task self-reports failure with a 429 quota explanation.
      executeTask: async (sub) => ({
        id: sub.id,
        status: 'failed',
        mutations: [],
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        trace: { tokensConsumed: 0 } as any,
        answer: 'rate-limited: HTTP 429 too many requests',
      }),
    });

    const failures = events
      .filter((e) => e.event === 'workflow:subtask_updated')
      .map((e) => e.payload as { status: string; errorKind?: string; errorMessage?: string });
    const last = failures[failures.length - 1]!;
    expect(last.status).toBe('failed');
    expect(last.errorKind).toBe('provider_quota');
    expect(last.errorMessage).toContain('429');
  });

  test('dependency-skip propagates as skipped with errorKind=dependency_failed', async () => {
    const validPlan = JSON.stringify({
      goal: 'cascade',
      steps: [
        { id: 's1', description: 'will fail', strategy: 'llm-reasoning', budgetFraction: 0.3 },
        {
          id: 's2',
          description: 'depends on s1',
          strategy: 'delegate-sub-agent',
          dependencies: ['s1'],
          budgetFraction: 0.3,
        },
      ],
      synthesisPrompt: 'Combine.',
    });
    const mockProvider = {
      id: 'mock',
      generate: async (req: { systemPrompt: string }) => {
        if (req.systemPrompt.includes('workflow planner')) {
          return { content: validPlan, tokensUsed: { input: 5, output: 5 } };
        }
        // step1 (llm-reasoning) — return content but mark via thrown error in the
        // generate path. Easier: throw to force the dispatch's catch branch to
        // surface a failed result. Without throw, llm-reasoning returns success.
        throw new Error('synthetic step1 failure');
      },
    };
    const events: Array<{ event: string; payload: unknown }> = [];
    const bus = {
      emit: (event: string, payload: unknown) => events.push({ event, payload }),
    };
    await executeWorkflow(makeInput('cascade'), {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      llmRegistry: { selectByTier: () => mockProvider } as any,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      bus: bus as any,
      executeTask: async (sub) => ({
        id: sub.id,
        status: 'completed',
        mutations: [],
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        trace: { tokensConsumed: 0 } as any,
        answer: 'never-runs',
      }),
    });
    // The s2 subtask should get a skipped update with errorKind=dependency_failed.
    const s2Updates = events
      .filter((e) => e.event === 'workflow:subtask_updated')
      .map((e) => e.payload as { stepId: string; status: string; errorKind?: string; errorMessage?: string });
    const s2 = s2Updates.find((u) => u.stepId === 's2');
    expect(s2).toBeDefined();
    expect(s2!.status).toBe('skipped');
    expect(s2!.errorKind).toBe('dependency_failed');
    expect(s2!.errorMessage).toContain('dependency failed');
  });
});
