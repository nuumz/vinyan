/**
 * Phase-13 — A1 Epistemic Separation in workflow-executor's
 * `delegate-sub-agent` dispatch path.
 *
 * Verifies:
 *   - verify-style step on code-mutation parent → sub-task forced to canonical Verifier
 *   - verify-style step on non-code parent → no override (sub-task inherits)
 *   - non-verify step on code parent → no override
 *   - missing agentRegistry → no override (legacy path safe)
 *   - emits `workflow:a1_verifier_routed` when override fires
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgentRegistry } from '../../../src/orchestrator/agents/registry.ts';
import type { TaskInput, TaskResult, TaskType } from '../../../src/orchestrator/types.ts';
import { executeWorkflow } from '../../../src/orchestrator/workflow/workflow-executor.ts';

function makeInput(goal: string, taskType: TaskType = 'code'): TaskInput {
  return {
    id: 'task-a1',
    source: 'cli',
    goal,
    taskType,
    budget: { maxTokens: 10_000, maxDurationMs: 60_000, maxRetries: 1 },
  };
}

function mockResult(id: string): TaskResult {
  return {
    id,
    status: 'completed',
    mutations: [],
    trace: {
      id: `tr-${id}`,
      taskId: id,
      timestamp: 0,
      routingLevel: 2,
      approach: 'sub',
      oracleVerdicts: {},
      modelUsed: 'x',
      tokensConsumed: 0,
      durationMs: 0,
      outcome: 'success',
      affectedFiles: [],
    },
    answer: 'sub-result',
  };
}

function planJSON(stepDescription: string): string {
  return JSON.stringify({
    goal: 'parent',
    steps: [{ id: 'step1', description: stepDescription, strategy: 'delegate-sub-agent', budgetFraction: 0.5 }],
    synthesisPrompt: 'Return step1.',
  });
}

function makeRegistry() {
  const ws = mkdtempSync(join(tmpdir(), 'vinyan-a1-wf-'));
  const reg = loadAgentRegistry(ws, undefined);
  return { reg, cleanup: () => rmSync(ws, { recursive: true, force: true }) };
}

function makePlannerProvider(plan: string) {
  return {
    selectByTier: () =>
      ({
        id: 'mock',
        generate: async () => ({ content: plan, tokensUsed: { input: 10, output: 10 } }),
      } as unknown as ReturnType<NonNullable<Parameters<typeof executeWorkflow>[1]['llmRegistry']>['selectByTier']>),
  };
}

describe('Phase-13 A1 verifier routing in delegate-sub-agent', () => {
  test('code parent + verify description → sub-task forced to reviewer', async () => {
    const { reg, cleanup } = makeRegistry();
    try {
      const captured: TaskInput[] = [];
      const events: Array<{ event: string; payload: unknown }> = [];
      const result = await executeWorkflow(makeInput('refactor', 'code'), {
        llmRegistry: makePlannerProvider(planJSON('review the implementation for correctness')) as any,
        agentRegistry: reg,
        executeTask: async (subInput) => {
          captured.push(subInput);
          return mockResult(subInput.id);
        },
        bus: { emit: (event: string, payload: unknown) => events.push({ event, payload }) } as any,
      });
      expect(result.status).toBe('completed');
      expect(captured).toHaveLength(1);
      expect(captured[0]!.agentId).toBe('reviewer');
      const a1Events = events.filter((e) => e.event === 'workflow:a1_verifier_routed');
      expect(a1Events).toHaveLength(1);
      expect((a1Events[0]!.payload as { verifierAgentId: string }).verifierAgentId).toBe('reviewer');
    } finally {
      cleanup();
    }
  });

  test('non-code parent + verify description → NO override', async () => {
    const { reg, cleanup } = makeRegistry();
    try {
      const captured: TaskInput[] = [];
      await executeWorkflow(makeInput('write essay', 'reasoning'), {
        llmRegistry: makePlannerProvider(planJSON('review the draft')) as any,
        agentRegistry: reg,
        executeTask: async (subInput) => {
          captured.push(subInput);
          return mockResult(subInput.id);
        },
      });
      expect(captured).toHaveLength(1);
      expect(captured[0]!.agentId).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test('code parent + non-verify description → NO override', async () => {
    const { reg, cleanup } = makeRegistry();
    try {
      const captured: TaskInput[] = [];
      await executeWorkflow(makeInput('refactor', 'code'), {
        llmRegistry: makePlannerProvider(planJSON('extract a helper function')) as any,
        agentRegistry: reg,
        executeTask: async (subInput) => {
          captured.push(subInput);
          return mockResult(subInput.id);
        },
      });
      expect(captured).toHaveLength(1);
      expect(captured[0]!.agentId).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test('agentRegistry omitted → no override (legacy / minimal setups)', async () => {
    const captured: TaskInput[] = [];
    await executeWorkflow(makeInput('refactor', 'code'), {
      llmRegistry: makePlannerProvider(planJSON('review the implementation')) as any,
      executeTask: async (subInput) => {
        captured.push(subInput);
        return mockResult(subInput.id);
      },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.agentId).toBeUndefined();
  });

  test('parent already running as reviewer → NO override (would re-enter same agent)', async () => {
    const { reg, cleanup } = makeRegistry();
    try {
      const captured: TaskInput[] = [];
      const events: Array<{ event: string; payload: unknown }> = [];
      const parent = makeInput('audit code', 'code');
      parent.agentId = 'reviewer';
      await executeWorkflow(parent, {
        llmRegistry: makePlannerProvider(planJSON('verify the patch')) as any,
        agentRegistry: reg,
        executeTask: async (subInput) => {
          captured.push(subInput);
          return mockResult(subInput.id);
        },
        bus: { emit: (event: string, payload: unknown) => events.push({ event, payload }) } as any,
      });
      // No override → no agentId forced, no a1_verifier_routed event
      expect(captured[0]!.agentId).toBeUndefined();
      expect(events.filter((e) => e.event === 'workflow:a1_verifier_routed')).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test('verify-verb variants all trigger override', async () => {
    const verbs = ['verify', 'review', 'audit', 'critique', 'validate', 'evaluate', 'assess', 'sanity-check'];
    for (const verb of verbs) {
      const { reg, cleanup } = makeRegistry();
      try {
        const captured: TaskInput[] = [];
        await executeWorkflow(makeInput('refactor', 'code'), {
          llmRegistry: makePlannerProvider(planJSON(`${verb} the code`)) as any,
          agentRegistry: reg,
          executeTask: async (subInput) => {
            captured.push(subInput);
            return mockResult(subInput.id);
          },
        });
        expect(captured[0]!.agentId).toBe('reviewer');
      } finally {
        cleanup();
      }
    }
  });
});
