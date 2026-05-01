/**
 * Q1 + Q2 — step-level resilience tests for the workflow executor.
 *
 * These pin three contracts:
 *
 *   1. `retryBudget` is honoured at the step level for delegate-sub-agent
 *      steps (transient failures retry up to the configured cap; the
 *      `workflow:step_retry` event records each attempt; permanent
 *      failures skip retry; budget=0 preserves the legacy single-attempt
 *      behaviour).
 *
 *   2. The deterministic plan normalizer (`normalizeWorkflowPlan`):
 *      - sets a default `retryBudget` per strategy
 *      - clamps out-of-range planner output
 *      - auto-adds `fallbackStrategy: 'llm-reasoning'` for SINGLE
 *        delegate-sub-agent plans
 *      - leaves multi-delegate plans alone (no fake-diversity collapse)
 *      - rejects invalid planner-emitted fallbacks (e.g. recursive
 *        delegate-sub-agent, human-input)
 *
 *   3. The executor honours the new `fallbackOrigin` provenance and
 *      suppresses fallback for infrastructure-level failures so a
 *      misconfigured deployment does not silently swap personas.
 *
 * Wiring assertion: every retry / fallback path is exercised through
 * `executeWorkflow` — i.e. the real workflow execution path, not a
 * helper module call. No stubs, no mock-only success.
 */
import { describe, expect, test } from 'bun:test';
import { asPersonaId } from '../../../src/core/agent-vocabulary.ts';
import { createBus } from '../../../src/core/bus.ts';
import type { TaskInput } from '../../../src/orchestrator/types.ts';
import { executeWorkflow } from '../../../src/orchestrator/workflow/workflow-executor.ts';
import { normalizeWorkflowPlan } from '../../../src/orchestrator/workflow/plan-normalizer.ts';
import {
  DEFAULT_DELEGATE_RETRY_BUDGET,
  MAX_STEP_RETRY_BUDGET,
  type WorkflowPlan,
} from '../../../src/orchestrator/workflow/types.ts';

function makeInput(goal: string, overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 'task-resilience-1',
    source: 'cli',
    goal,
    taskType: 'reasoning',
    budget: { maxTokens: 10_000, maxDurationMs: 60_000, maxRetries: 1 },
    ...overrides,
  };
}

function makeProvider(planJson: string) {
  const generate = async (req: { systemPrompt: string }) => {
    if (req.systemPrompt.includes('workflow planner')) {
      return { content: planJson, tokensUsed: { input: 5, output: 5 } };
    }
    if (req.systemPrompt.includes('final answer for the user')) {
      return { content: 'final', tokensUsed: { input: 5, output: 5 } };
    }
    // llm-reasoning step (used as auto-fallback) lands here too — return
    // a deterministic string the assertions can check for.
    return { content: 'fallback-llm-answer', tokensUsed: { input: 5, output: 5 } };
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

// Single delegate plan — exercises the auto-fallback + retry default.
const SINGLE_DELEGATE = JSON.stringify({
  goal: 'researcher answers',
  steps: [
    {
      id: 'step1',
      description: 'researcher delivers',
      strategy: 'delegate-sub-agent',
      agentId: 'researcher',
      budgetFraction: 1,
    },
  ],
  synthesisPrompt: 'Combine.',
});

const SINGLE_DELEGATE_NO_RETRY = JSON.stringify({
  goal: 'researcher answers — no retry',
  steps: [
    {
      id: 'step1',
      description: 'researcher delivers',
      strategy: 'delegate-sub-agent',
      agentId: 'researcher',
      budgetFraction: 1,
      retryBudget: 0,
    },
  ],
  synthesisPrompt: 'Combine.',
});

const SINGLE_DELEGATE_RETRY_2 = JSON.stringify({
  goal: 'researcher answers — retry twice',
  steps: [
    {
      id: 'step1',
      description: 'researcher delivers',
      strategy: 'delegate-sub-agent',
      agentId: 'researcher',
      budgetFraction: 1,
      retryBudget: 2,
    },
  ],
  synthesisPrompt: 'Combine.',
});

describe('Q1 — delegate-sub-agent retry budget', () => {
  test('retryBudget=1 retries exactly once on transient failure and the workflow continues', async () => {
    const bus = createBus();
    const retryEvents: Array<{ attempt: number; maxAttempts: number; errorClass: string }> = [];
    bus.on('workflow:step_retry', (p) =>
      retryEvents.push({ attempt: p.attempt, maxAttempts: p.maxAttempts, errorClass: p.errorClass }),
    );

    let calls = 0;
    const executeTask = async (subInput: { id: string }) => {
      calls += 1;
      if (calls === 1) {
        // First attempt: simulate provider quota / 429 — transient.
        return {
          id: subInput.id,
          status: 'failed',
          mutations: [],
          answer: '429 too many requests from upstream',
          trace: { tokensConsumed: 0 },
        } as unknown as Record<string, unknown>;
      }
      return {
        id: subInput.id,
        status: 'completed',
        mutations: [],
        answer: 'researcher REAL ANSWER',
        trace: { tokensConsumed: 10 },
      } as unknown as Record<string, unknown>;
    };

    const result = await executeWorkflow(makeInput('one delegate'), {
      bus,
      llmRegistry: { selectByTier: () => makeProvider(SINGLE_DELEGATE) } as never,
      executeTask: executeTask as never,
      workflowConfig: { requireUserApproval: false, approvalTimeoutMs: 30_000 },
    });

    expect(calls).toBe(2);
    expect(retryEvents).toHaveLength(1);
    expect(retryEvents[0]!.attempt).toBe(1);
    expect(retryEvents[0]!.maxAttempts).toBe(2);
    expect(retryEvents[0]!.errorClass).toBe('provider_quota');
    expect(result.status).toBe('completed');
    const step1 = result.stepResults.find((r) => r.stepId === 'step1');
    expect(step1?.status).toBe('completed');
    expect(step1?.output).toContain('researcher REAL ANSWER');
  });

  test('retryBudget=2 retries up to two times before giving up', async () => {
    const bus = createBus();
    const retryEvents: Array<{ attempt: number }> = [];
    bus.on('workflow:step_retry', (p) => retryEvents.push({ attempt: p.attempt }));

    let calls = 0;
    const executeTask = async (subInput: { id: string }) => {
      calls += 1;
      if (calls < 3) {
        return {
          id: subInput.id,
          status: 'failed',
          mutations: [],
          answer: 'rate-limit hit (transient)',
          trace: { tokensConsumed: 0 },
        } as unknown as Record<string, unknown>;
      }
      return {
        id: subInput.id,
        status: 'completed',
        mutations: [],
        answer: 'finally',
        trace: { tokensConsumed: 5 },
      } as unknown as Record<string, unknown>;
    };

    const result = await executeWorkflow(makeInput('retry twice'), {
      bus,
      llmRegistry: { selectByTier: () => makeProvider(SINGLE_DELEGATE_RETRY_2) } as never,
      executeTask: executeTask as never,
      workflowConfig: { requireUserApproval: false, approvalTimeoutMs: 30_000 },
    });

    expect(calls).toBe(3);
    expect(retryEvents.map((e) => e.attempt)).toEqual([1, 2]);
    expect(result.status).toBe('completed');
  });

  test('retry exhausted then fallbackStrategy executes', async () => {
    const bus = createBus();
    const fallbackEvents: Array<{ origin?: string; reason?: string }> = [];
    bus.on('workflow:step_fallback', (p) =>
      fallbackEvents.push({ origin: p.fallbackOrigin, reason: p.reason }),
    );

    const executeTask = async (subInput: { id: string }) =>
      ({
        id: subInput.id,
        status: 'failed',
        mutations: [],
        answer: 'rate-limit hit (transient)',
        trace: { tokensConsumed: 0 },
      }) as unknown as Record<string, unknown>;

    const result = await executeWorkflow(makeInput('retry then fallback'), {
      bus,
      llmRegistry: { selectByTier: () => makeProvider(SINGLE_DELEGATE) } as never,
      executeTask: executeTask as never,
      workflowConfig: { requireUserApproval: false, approvalTimeoutMs: 30_000 },
    });

    expect(fallbackEvents).toHaveLength(1);
    expect(fallbackEvents[0]!.origin).toBe('auto-normalizer');
    expect(fallbackEvents[0]!.reason).toMatch(/provider_quota/);
    // Auto fallback runs llm-reasoning which the mock returns 'fallback-llm-answer'.
    const step1 = result.stepResults.find((r) => r.stepId === 'step1');
    expect(step1?.status).toBe('completed');
    expect(step1?.output).toContain('fallback-llm-answer');
    expect(step1?.strategyUsed).toBe('llm-reasoning');
  });

  test('retryBudget=0 preserves legacy no-retry behaviour', async () => {
    const bus = createBus();
    const retryEvents: unknown[] = [];
    bus.on('workflow:step_retry', (p) => retryEvents.push(p));

    let calls = 0;
    const executeTask = async (subInput: { id: string }) => {
      calls += 1;
      return {
        id: subInput.id,
        status: 'failed',
        mutations: [],
        answer: 'rate-limit hit (transient)',
        trace: { tokensConsumed: 0 },
      } as unknown as Record<string, unknown>;
    };

    await executeWorkflow(makeInput('no retry'), {
      bus,
      llmRegistry: { selectByTier: () => makeProvider(SINGLE_DELEGATE_NO_RETRY) } as never,
      executeTask: executeTask as never,
      workflowConfig: { requireUserApproval: false, approvalTimeoutMs: 30_000 },
    });

    expect(calls).toBe(1);
    expect(retryEvents).toHaveLength(0);
  });

  test('non-retryable failure (contract violation) does NOT retry', async () => {
    const bus = createBus();
    const retryEvents: unknown[] = [];
    bus.on('workflow:step_retry', (p) => retryEvents.push(p));

    let calls = 0;
    const executeTask = async (subInput: { id: string }) => {
      calls += 1;
      return {
        id: subInput.id,
        status: 'failed',
        mutations: [],
        answer: 'guardrail injection detected — refusing',
        trace: { tokensConsumed: 0 },
      } as unknown as Record<string, unknown>;
    };

    await executeWorkflow(makeInput('contract violation'), {
      bus,
      llmRegistry: { selectByTier: () => makeProvider(SINGLE_DELEGATE) } as never,
      executeTask: executeTask as never,
      workflowConfig: { requireUserApproval: false, approvalTimeoutMs: 30_000 },
    });

    expect(calls).toBe(1);
    expect(retryEvents).toHaveLength(0);
  });

  test('infrastructure-level failure (executeTask not wired) skips BOTH retry AND fallback', async () => {
    const bus = createBus();
    const retryEvents: unknown[] = [];
    const fallbackEvents: unknown[] = [];
    bus.on('workflow:step_retry', (p) => retryEvents.push(p));
    bus.on('workflow:step_fallback', (p) => fallbackEvents.push(p));

    const result = await executeWorkflow(makeInput('infra missing'), {
      bus,
      llmRegistry: { selectByTier: () => makeProvider(SINGLE_DELEGATE) } as never,
      // No executeTask — dispatch returns "executeTask not available"
      workflowConfig: { requireUserApproval: false, approvalTimeoutMs: 30_000 },
    });

    expect(retryEvents).toHaveLength(0);
    expect(fallbackEvents).toHaveLength(0);
    const step1 = result.stepResults.find((r) => r.stepId === 'step1');
    expect(step1?.status).toBe('failed');
    expect(step1?.output).toMatch(/executeTask not available/);
  });

  test('schema rejects retryBudget > MAX_STEP_RETRY_BUDGET', () => {
    // Validation happens at WorkflowPlanSchema parse time. The normalizer
    // also clamps as a defense-in-depth, but the schema is the primary
    // gate so a bad planner output never lands as-is.
    const { WorkflowPlanSchema } = require('../../../src/orchestrator/workflow/types.ts');
    const tooLarge = {
      goal: 'x',
      steps: [
        {
          id: 'step1',
          description: 'd',
          strategy: 'delegate-sub-agent',
          retryBudget: MAX_STEP_RETRY_BUDGET + 5,
        },
      ],
      synthesisPrompt: 'x',
    };
    const parsed = WorkflowPlanSchema.safeParse(tooLarge);
    expect(parsed.success).toBe(false);
  });
});

describe('Q2 — deterministic fallback / retry normalizer', () => {
  test('single delegate-sub-agent step without fallback gets auto fallback (llm-reasoning, auto-normalizer)', () => {
    const plan: WorkflowPlan = {
      goal: 'one delegate',
      steps: [
        {
          id: 'step1',
          description: 'researcher',
          strategy: 'delegate-sub-agent',
          agentId: asPersonaId('researcher'),
          dependencies: [],
          inputs: {},
          expectedOutput: '',
          budgetFraction: 1,
        },
      ],
      synthesisPrompt: 'Combine.',
    };
    const out = normalizeWorkflowPlan(plan);
    expect(out.steps[0]!.fallbackStrategy).toBe('llm-reasoning');
    expect(out.steps[0]!.fallbackOrigin).toBe('auto-normalizer');
    expect(out.steps[0]!.retryBudget).toBe(DEFAULT_DELEGATE_RETRY_BUDGET);
  });

  test('explicit valid fallbackStrategy is preserved with planner origin', () => {
    const plan: WorkflowPlan = {
      goal: 'one delegate',
      steps: [
        {
          id: 'step1',
          description: 'researcher',
          strategy: 'delegate-sub-agent',
          agentId: asPersonaId('researcher'),
          dependencies: [],
          inputs: {},
          expectedOutput: '',
          budgetFraction: 1,
          fallbackStrategy: 'knowledge-query',
        },
      ],
      synthesisPrompt: 'Combine.',
    };
    const out = normalizeWorkflowPlan(plan);
    expect(out.steps[0]!.fallbackStrategy).toBe('knowledge-query');
    expect(out.steps[0]!.fallbackOrigin).toBe('planner');
  });

  test('invalid fallbackStrategy (recursive delegate-sub-agent) is rejected then auto-replaced for single-delegate plans', () => {
    const plan: WorkflowPlan = {
      goal: 'one delegate',
      steps: [
        {
          id: 'step1',
          description: 'researcher',
          strategy: 'delegate-sub-agent',
          agentId: asPersonaId('researcher'),
          dependencies: [],
          inputs: {},
          expectedOutput: '',
          budgetFraction: 1,
          // Recursive — planner shouldn't have emitted this. Normalizer
          // drops it; single-delegate path then auto-adds llm-reasoning.
          fallbackStrategy: 'delegate-sub-agent',
        },
      ],
      synthesisPrompt: 'Combine.',
    };
    const out = normalizeWorkflowPlan(plan);
    expect(out.steps[0]!.fallbackStrategy).toBe('llm-reasoning');
    expect(out.steps[0]!.fallbackOrigin).toBe('auto-normalizer');
  });

  test('invalid fallbackStrategy (human-input) is rejected for multi-delegate plans (no auto-add)', () => {
    const plan: WorkflowPlan = {
      goal: 'three delegates',
      steps: [
        {
          id: 'step1',
          description: 'researcher',
          strategy: 'delegate-sub-agent',
          agentId: asPersonaId('researcher'),
          dependencies: [],
          inputs: {},
          expectedOutput: '',
          budgetFraction: 0.33,
          fallbackStrategy: 'human-input',
        },
        {
          id: 'step2',
          description: 'author',
          strategy: 'delegate-sub-agent',
          agentId: asPersonaId('author'),
          dependencies: [],
          inputs: {},
          expectedOutput: '',
          budgetFraction: 0.33,
        },
        {
          id: 'step3',
          description: 'mentor',
          strategy: 'delegate-sub-agent',
          agentId: asPersonaId('mentor'),
          dependencies: [],
          inputs: {},
          expectedOutput: '',
          budgetFraction: 0.34,
        },
      ],
      synthesisPrompt: 'Combine.',
    };
    const out = normalizeWorkflowPlan(plan);
    // Recursive / invalid fallback dropped, but multi-delegate plans
    // never get auto-fallback — would collapse persona diversity.
    expect(out.steps[0]!.fallbackStrategy).toBeUndefined();
    expect(out.steps[1]!.fallbackStrategy).toBeUndefined();
    expect(out.steps[2]!.fallbackStrategy).toBeUndefined();
  });

  test('multi-delegate plan does NOT collapse all specialists into one fallback', () => {
    const plan: WorkflowPlan = {
      goal: 'three delegates debate',
      steps: [
        {
          id: 'step1',
          description: 'researcher',
          strategy: 'delegate-sub-agent',
          agentId: asPersonaId('researcher'),
          dependencies: [],
          inputs: {},
          expectedOutput: '',
          budgetFraction: 0.33,
        },
        {
          id: 'step2',
          description: 'author',
          strategy: 'delegate-sub-agent',
          agentId: asPersonaId('author'),
          dependencies: [],
          inputs: {},
          expectedOutput: '',
          budgetFraction: 0.33,
        },
        {
          id: 'step3',
          description: 'mentor',
          strategy: 'delegate-sub-agent',
          agentId: asPersonaId('mentor'),
          dependencies: [],
          inputs: {},
          expectedOutput: '',
          budgetFraction: 0.34,
        },
      ],
      synthesisPrompt: 'Combine.',
    };
    const out = normalizeWorkflowPlan(plan);
    for (const step of out.steps) {
      expect(step.fallbackStrategy).toBeUndefined();
      expect(step.fallbackOrigin).toBeUndefined();
      expect(step.retryBudget).toBe(DEFAULT_DELEGATE_RETRY_BUDGET);
    }
  });

  test('non-delegate steps default retryBudget to 0 and never get auto-fallback', () => {
    const plan: WorkflowPlan = {
      goal: 'reason',
      steps: [
        {
          id: 'step1',
          description: 'reason directly',
          strategy: 'llm-reasoning',
          dependencies: [],
          inputs: {},
          expectedOutput: '',
          budgetFraction: 1,
        },
      ],
      synthesisPrompt: 'Pass-through.',
    };
    const out = normalizeWorkflowPlan(plan);
    expect(out.steps[0]!.retryBudget).toBe(0);
    expect(out.steps[0]!.fallbackStrategy).toBeUndefined();
  });

  test('out-of-range retryBudget is clamped at runtime even when bypassing schema', () => {
    // Defense-in-depth: hand-craft a plan with retryBudget=99 (above
    // MAX_STEP_RETRY_BUDGET) without going through Zod. The normalizer
    // must still clamp it.
    const plan: WorkflowPlan = {
      goal: 'one',
      steps: [
        {
          id: 'step1',
          description: 'd',
          strategy: 'delegate-sub-agent',
          dependencies: [],
          inputs: {},
          expectedOutput: '',
          budgetFraction: 1,
          retryBudget: 99,
        },
      ],
      synthesisPrompt: 'x',
    };
    const out = normalizeWorkflowPlan(plan);
    expect(out.steps[0]!.retryBudget).toBe(MAX_STEP_RETRY_BUDGET);
  });
});

describe('Q1+Q2 wiring — fallback events carry origin through executeWorkflow', () => {
  test('fallback fired by retry-exhaustion records auto-normalizer origin in the live event', async () => {
    const bus = createBus();
    const fallbackEvents: Array<{ origin?: string }> = [];
    bus.on('workflow:step_fallback', (p) =>
      fallbackEvents.push({ origin: p.fallbackOrigin }),
    );

    const executeTask = async (subInput: { id: string }) =>
      ({
        id: subInput.id,
        status: 'failed',
        mutations: [],
        answer: '429',
        trace: { tokensConsumed: 0 },
      }) as unknown as Record<string, unknown>;

    await executeWorkflow(makeInput('observable fallback'), {
      bus,
      llmRegistry: { selectByTier: () => makeProvider(SINGLE_DELEGATE) } as never,
      executeTask: executeTask as never,
      workflowConfig: { requireUserApproval: false, approvalTimeoutMs: 30_000 },
    });

    expect(fallbackEvents).toHaveLength(1);
    expect(fallbackEvents[0]!.origin).toBe('auto-normalizer');
  });
});

describe('Risk closures — tighter classifier, budget-aware retry, honest fallback', () => {
  test('subtask_failed (broad catch-all) does NOT retry — falls straight to fallback', async () => {
    const bus = createBus();
    const retryEvents: unknown[] = [];
    const fallbackEvents: unknown[] = [];
    bus.on('workflow:step_retry', (p) => retryEvents.push(p));
    bus.on('workflow:step_fallback', (p) => fallbackEvents.push(p));

    let calls = 0;
    const executeTask = async (subInput: { id: string }) => {
      calls += 1;
      // Generic error string — no `429`, no `timeout`, no `quota`. The
      // classifier maps this to `subtask_failed`, which is no longer
      // retryable after the risk-#2 tightening.
      return {
        id: subInput.id,
        status: 'failed',
        mutations: [],
        answer: 'oracle verdict was contradictory and the worker bailed',
        trace: { tokensConsumed: 0 },
      } as unknown as Record<string, unknown>;
    };

    await executeWorkflow(makeInput('subtask_failed no retry'), {
      bus,
      llmRegistry: { selectByTier: () => makeProvider(SINGLE_DELEGATE) } as never,
      executeTask: executeTask as never,
      workflowConfig: { requireUserApproval: false, approvalTimeoutMs: 30_000 },
    });

    expect(calls).toBe(1); // primary attempt only
    expect(retryEvents).toHaveLength(0);
    // Fallback still fires because the failure was `subtask_failed`,
    // not `infrastructure_unavailable` — this is the right rung of
    // the degradation ladder when retry isn't justified.
    expect(fallbackEvents).toHaveLength(1);
  });

  test('budget veto — retry is skipped and a step_retry_skipped event is emitted', async () => {
    const bus = createBus();
    const retryEvents: unknown[] = [];
    const skippedEvents: Array<{
      reason: string;
      attemptsUsed: number;
      lastAttemptDurationMs: number;
      remainingBudgetMs: number;
    }> = [];
    bus.on('workflow:step_retry', (p) => retryEvents.push(p));
    bus.on('workflow:step_retry_skipped', (p) =>
      skippedEvents.push({
        reason: p.reason,
        attemptsUsed: p.attemptsUsed,
        lastAttemptDurationMs: p.lastAttemptDurationMs,
        remainingBudgetMs: p.remainingBudgetMs,
      }),
    );

    let calls = 0;
    const executeTask = async (subInput: { id: string }) => {
      calls += 1;
      // Burn ~120ms per attempt — first attempt's duration becomes
      // the projected cost the budget gate compares against.
      await new Promise((r) => setTimeout(r, 120));
      return {
        id: subInput.id,
        status: 'failed',
        mutations: [],
        answer: '429 rate-limited',
        trace: { tokensConsumed: 0 },
      } as unknown as Record<string, unknown>;
    };

    // Budget tight enough that a retry's projected cost would overrun
    // remaining wall-clock. With 200ms parent budget and ~120ms first
    // attempt, the elapsed-after-attempt-1 already eats most of the
    // budget; retrying would project ~120ms more, so the gate vetos.
    await executeWorkflow(
      makeInput('tight budget', {
        budget: { maxTokens: 1000, maxDurationMs: 200, maxRetries: 1 },
      }),
      {
        bus,
        llmRegistry: { selectByTier: () => makeProvider(SINGLE_DELEGATE) } as never,
        executeTask: executeTask as never,
        workflowConfig: { requireUserApproval: false, approvalTimeoutMs: 30_000 },
      },
    );

    expect(calls).toBe(1);
    expect(retryEvents).toHaveLength(0);
    expect(skippedEvents).toHaveLength(1);
    expect(skippedEvents[0]!.reason).toBe('budget_exhausted');
    expect(skippedEvents[0]!.lastAttemptDurationMs).toBeGreaterThan(0);
    expect(skippedEvents[0]!.attemptsUsed).toBe(1);
  });

  test('fallback on a delegate clears agentId and stamps fallbackUsed on the step result', async () => {
    const bus = createBus();
    const executeTask = async (subInput: { id: string }) =>
      ({
        id: subInput.id,
        status: 'failed',
        mutations: [],
        answer: '429 rate-limited',
        trace: { tokensConsumed: 0 },
      }) as unknown as Record<string, unknown>;

    const result = await executeWorkflow(makeInput('honest attribution'), {
      bus,
      llmRegistry: { selectByTier: () => makeProvider(SINGLE_DELEGATE) } as never,
      executeTask: executeTask as never,
      workflowConfig: { requireUserApproval: false, approvalTimeoutMs: 30_000 },
    });

    const step1 = result.stepResults.find((r) => r.stepId === 'step1');
    expect(step1).toBeDefined();
    // Primary delegate failed, fallback (llm-reasoning) ran and
    // succeeded. The result must NOT carry the requested persona's
    // agentId, and must carry the honest `fallbackUsed: true` marker.
    expect(step1?.fallbackUsed).toBe(true);
    expect(step1?.agentId).toBeUndefined();
    expect(step1?.strategyUsed).toBe('llm-reasoning');
    // Synthesizer-side proof: the deterministic aggregation must not
    // attribute the fallback's output to the requested persona name.
    expect(result.synthesizedOutput).not.toMatch(/\*\*researcher\*\*/);
    expect(result.synthesizedOutput).toMatch(/fallback for researcher|Note:.+researcher.+unavailable/i);
  });
});
