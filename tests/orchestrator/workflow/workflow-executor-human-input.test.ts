/**
 * Tests for the `human-input` step dispatch in workflow-executor.
 *
 * Background — incident b749e5bd: a 5-step plan whose step1 was
 * "Ask the user for the topic" (strategy=human-input) returned skipped
 * immediately on dispatch, cascading "Skipped: dependency failed (step1)"
 * through every downstream delegate. The fix pauses the executor on
 * human-input until `workflow:human_input_provided` arrives (or the
 * approval window expires). This file pins the new behaviour:
 *
 *   - emits `workflow:human_input_needed` with taskId + stepId + question
 *   - resolves with the user's value as the step output (status='completed')
 *   - downstream dependents now see the answer in `interpolatedInputs`
 *   - on timeout the step fails honestly (no fabricated value)
 *   - empty answers are rejected (do not feed empty string downstream)
 */
import { describe, expect, test } from 'bun:test';
import { createBus } from '../../../src/core/bus.ts';
import { executeWorkflow } from '../../../src/orchestrator/workflow/workflow-executor.ts';
import type { TaskInput } from '../../../src/orchestrator/types.ts';

function makeInput(goal: string): TaskInput {
  return {
    id: 'task-hi-1',
    source: 'cli',
    goal,
    taskType: 'reasoning',
    budget: { maxTokens: 1000, maxDurationMs: 10_000, maxRetries: 1 },
  };
}

const HUMAN_INPUT_PLAN = JSON.stringify({
  goal: 'ask for topic then echo it',
  steps: [
    {
      id: 'step1',
      description: 'Ask the user for the topic',
      strategy: 'human-input',
      budgetFraction: 0.3,
    },
    {
      id: 'step2',
      description: 'Echo the topic back',
      strategy: 'llm-reasoning',
      dependencies: ['step1'],
      inputs: { topic: '$step1.result' },
      budgetFraction: 0.7,
    },
  ],
  synthesisPrompt: 'Combine.',
});

function makeProvider(planJson: string, echoPayload = 'echo: {{topic}}') {
  let callCount = 0;
  return {
    id: 'mock',
    capabilities: { codeGeneration: true, structuredOutput: true },
    generate: async () => {
      callCount += 1;
      // First call is the planner, second is the step2 llm-reasoning.
      if (callCount === 1) {
        return { content: planJson, tokensUsed: { input: 10, output: 10 } };
      }
      return { content: echoPayload, tokensUsed: { input: 5, output: 5 } };
    },
  };
}

describe('executeWorkflow — human-input pause', () => {
  test('emits human_input_needed with taskId + stepId + question', async () => {
    const bus = createBus();
    const events: Array<{ name: string; payload: unknown }> = [];
    bus.on('workflow:human_input_needed', (p) =>
      events.push({ name: 'human_input_needed', payload: p }),
    );
    const run = executeWorkflow(makeInput('ask topic'), {
      bus,
      llmRegistry: { selectByTier: () => makeProvider(HUMAN_INPUT_PLAN) } as any,
      // Disable approval gate so the test focuses on the human-input dispatch.
      workflowConfig: { requireUserApproval: false, approvalTimeoutMs: 30_000 },
    });
    // Give the executor time to plan + dispatch step1.
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as {
      taskId: string;
      stepId: string;
      question: string;
    };
    expect(payload.taskId).toBe('task-hi-1');
    expect(payload.stepId).toBe('step1');
    expect(payload.question).toMatch(/Ask the user/);
    // Resolve the wait so the run promise settles cleanly.
    bus.emit('workflow:human_input_provided', {
      taskId: 'task-hi-1',
      stepId: 'step1',
      value: 'Quantum computing',
    });
    await run;
  });

  test('user answer becomes step output and feeds downstream', async () => {
    const bus = createBus();
    const result = (async () => {
      // Settle the human_input wait shortly after the executor emits _needed.
      const unsub = bus.on('workflow:human_input_needed', (p) => {
        unsub();
        bus.emit('workflow:human_input_provided', {
          taskId: p.taskId,
          stepId: p.stepId,
          value: 'Climate change',
        });
      });
      return executeWorkflow(makeInput('ask topic'), {
        bus,
        llmRegistry: { selectByTier: () => makeProvider(HUMAN_INPUT_PLAN) } as any,
        workflowConfig: { requireUserApproval: false, approvalTimeoutMs: 30_000 },
      });
    })();
    const wf = await result;
    const step1 = wf.stepResults.find((r) => r.stepId === 'step1')!;
    expect(step1.status).toBe('completed');
    expect(step1.output).toBe('Climate change');
    // step2 ran (it was llm-reasoning and the mock provider returned a string).
    const step2 = wf.stepResults.find((r) => r.stepId === 'step2')!;
    expect(step2.status).toBe('completed');
  });

  test('timeout fails the step honestly — no fabricated value', async () => {
    const bus = createBus();
    const wf = await executeWorkflow(makeInput('ask topic'), {
      bus,
      llmRegistry: { selectByTier: () => makeProvider(HUMAN_INPUT_PLAN) } as any,
      // Tight ceiling — no response will arrive in time.
      workflowConfig: { requireUserApproval: false, approvalTimeoutMs: 50 },
    });
    const step1 = wf.stepResults.find((r) => r.stepId === 'step1')!;
    expect(step1.status).toBe('failed');
    expect(step1.output).toMatch(/timed out/);
    // step2 must NOT execute — its dependency failed.
    const step2 = wf.stepResults.find((r) => r.stepId === 'step2');
    expect(step2?.status).toBe('skipped');
  });

  test('empty answer is rejected — refuses to feed "" downstream', async () => {
    const bus = createBus();
    const wf = await (async () => {
      const unsub = bus.on('workflow:human_input_needed', (p) => {
        unsub();
        bus.emit('workflow:human_input_provided', {
          taskId: p.taskId,
          stepId: p.stepId,
          value: '   ',
        });
      });
      return executeWorkflow(makeInput('ask topic'), {
        bus,
        llmRegistry: { selectByTier: () => makeProvider(HUMAN_INPUT_PLAN) } as any,
        workflowConfig: { requireUserApproval: false, approvalTimeoutMs: 30_000 },
      });
    })();
    const step1 = wf.stepResults.find((r) => r.stepId === 'step1')!;
    expect(step1.status).toBe('failed');
    expect(step1.output).toMatch(/empty answer/);
  });

  test('mismatched taskId on response does not resolve the wait', async () => {
    const bus = createBus();
    const wf = await (async () => {
      const unsub = bus.on('workflow:human_input_needed', () => {
        unsub();
        bus.emit('workflow:human_input_provided', {
          taskId: 'wrong-task',
          stepId: 'step1',
          value: 'irrelevant',
        });
      });
      return executeWorkflow(makeInput('ask topic'), {
        bus,
        llmRegistry: { selectByTier: () => makeProvider(HUMAN_INPUT_PLAN) } as any,
        workflowConfig: { requireUserApproval: false, approvalTimeoutMs: 50 },
      });
    })();
    const step1 = wf.stepResults.find((r) => r.stepId === 'step1')!;
    expect(step1.status).toBe('failed');
    expect(step1.output).toMatch(/timed out/);
  });
});
