/**
 * Tests for the approval-gate behaviour in workflow-executor.
 *
 * The executor calls `classifyApprovalRequirement(config, goal, plan)` to
 * pick a `WorkflowApprovalMode`:
 *   - 'none'             → dispatch immediately.
 *   - 'agent-discretion' → emit plan_ready, await decision, on timeout call
 *                          `evaluateAutoApproval` (read-only → approve;
 *                          mutating → reject) with `auto: true`.
 *   - 'human-required'   → emit plan_ready, await decision, on timeout
 *                          surface "human decision required" failure with
 *                          `auto: true` BUT NEVER call evaluateAutoApproval.
 *
 * `workflow:plan_ready` carries `approvalMode`, `timeoutMs`,
 * `autoDecisionAllowed` so the UI can render mode-specific copy.
 */
import { describe, expect, test } from 'bun:test';
import { createBus } from '../../../src/core/bus.ts';
import { executeWorkflow } from '../../../src/orchestrator/workflow/workflow-executor.ts';
import type { TaskInput } from '../../../src/orchestrator/types.ts';

function makeInput(goal: string, overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 'task-exec-1',
    source: 'cli',
    goal,
    taskType: 'reasoning',
    budget: { maxTokens: 1000, maxDurationMs: 10_000, maxRetries: 1 },
    ...overrides,
  };
}

describe('executeWorkflow — approval gate', () => {
  test('emits plan_ready with awaitingApproval=false when approval is not required', async () => {
    const bus = createBus();
    const events: Array<{ name: string; payload: unknown }> = [];
    bus.on('workflow:plan_ready', (p) => events.push({ name: 'plan_ready', payload: p }));
    await executeWorkflow(makeInput('hi'), {
      bus,
      workflowConfig: { requireUserApproval: false, approvalTimeoutMs: 30_000 },
    });
    const planReady = events.find((e) => e.name === 'plan_ready');
    expect(planReady).toBeDefined();
    expect((planReady!.payload as { awaitingApproval: boolean }).awaitingApproval).toBe(false);
  });

  test('emits plan_ready with awaitingApproval=true and waits for approval when required', async () => {
    const bus = createBus();
    const events: Array<{ name: string; payload: unknown }> = [];
    bus.on('workflow:plan_ready', (p) => events.push({ name: 'plan_ready', payload: p }));

    const run = executeWorkflow(makeInput('analyse something'), {
      bus,
      workflowConfig: { requireUserApproval: true, approvalTimeoutMs: 30_000 },
    });

    // Give the executor a tick to subscribe + emit plan_ready.
    await new Promise((r) => setTimeout(r, 20));
    const planReady = events.find((e) => e.name === 'plan_ready');
    expect(planReady).toBeDefined();
    expect((planReady!.payload as { awaitingApproval: boolean }).awaitingApproval).toBe(true);

    bus.emit('workflow:plan_approved', { taskId: 'task-exec-1' });
    const result = await run;
    // synthesizedOutput should NOT be the rejection message — approval went through.
    expect(result.synthesizedOutput).not.toContain('rejected');
    expect(result.synthesizedOutput).not.toContain('timed out');
  });

  test('returns a failed WorkflowResult when the user rejects the plan', async () => {
    const bus = createBus();
    const run = executeWorkflow(makeInput('analyse something'), {
      bus,
      workflowConfig: { requireUserApproval: true, approvalTimeoutMs: 30_000 },
    });
    await new Promise((r) => setTimeout(r, 20));
    bus.emit('workflow:plan_rejected', { taskId: 'task-exec-1', reason: 'nah' });
    const result = await run;
    expect(result.status).toBe('failed');
    expect(result.synthesizedOutput).toContain('rejected');
    expect(result.stepResults).toHaveLength(0);
  });

  test('auto-approves a safe plan when the approval timer expires (Vinyan discretion)', async () => {
    // On timeout the executor calls `evaluateAutoApproval`. With no LLM
    // registry, the planner falls back to a single `llm-reasoning` step —
    // read-only, so Vinyan auto-approves and continues into step execution.
    // The emitted approval event MUST carry `auto: true` and a rationale so
    // dashboards can distinguish a human approval from Vinyan's deferred
    // judgement.
    const bus = createBus();
    const events: Array<{ name: string; payload: unknown }> = [];
    bus.on('workflow:plan_approved', (p) =>
      events.push({ name: 'plan_approved', payload: p }),
    );
    const result = await executeWorkflow(makeInput('analyse something'), {
      bus,
      workflowConfig: { requireUserApproval: true, approvalTimeoutMs: 50 },
    });
    const approved = events.find((e) => e.name === 'plan_approved');
    expect(approved).toBeDefined();
    const payload = approved!.payload as {
      taskId: string;
      auto?: boolean;
      rationale?: string;
    };
    expect(payload.taskId).toBe('task-exec-1');
    expect(payload.auto).toBe(true);
    expect(payload.rationale).toMatch(/Auto-approved on timeout/);
    expect(result.synthesizedOutput).not.toContain('rejected');
  });

  test('auto-rejects a risky plan when the approval timer expires (Vinyan discretion)', async () => {
    // When the plan contains code-mutating or destructive steps, Vinyan
    // declines to proceed without a human reviewer. The result MUST be a
    // failed WorkflowResult whose synthesized output names the offending
    // steps (so the user knows *why* their workflow stopped on timeout)
    // and the bus MUST emit `workflow:plan_rejected` with `auto: true`.
    //
    // We simulate a risky plan via an LLM provider mock that returns a
    // workflow JSON containing a `full-pipeline` step — `evaluateAutoApproval`
    // classifies that as risky and rejects.
    const riskyPlan = JSON.stringify({
      goal: 'refactor the auth module',
      steps: [
        {
          id: 'step1',
          description: 'refactor auth',
          strategy: 'full-pipeline',
          budgetFraction: 1.0,
        },
      ],
      synthesisPrompt: 'Combine.',
    });
    const mockProvider = {
      id: 'mock',
      capabilities: { codeGeneration: true, structuredOutput: true },
      generate: async () => ({ content: riskyPlan, tokensUsed: { input: 10, output: 10 } }),
    };
    const bus = createBus();
    const events: Array<{ name: string; payload: unknown }> = [];
    bus.on('workflow:plan_rejected', (p) =>
      events.push({ name: 'plan_rejected', payload: p }),
    );
    const result = await executeWorkflow(makeInput('refactor the auth module'), {
      bus,
      llmRegistry: { selectByTier: () => mockProvider } as any,
      workflowConfig: { requireUserApproval: true, approvalTimeoutMs: 50 },
    });
    const rejected = events.find((e) => e.name === 'plan_rejected');
    expect(rejected).toBeDefined();
    const payload = rejected!.payload as {
      taskId: string;
      auto?: boolean;
      rationale?: string;
    };
    expect(payload.auto).toBe(true);
    expect(payload.rationale).toMatch(/Auto-approval declined on timeout/);
    expect(payload.rationale).toMatch(/full-pipeline/);
    expect(result.status).toBe('failed');
    expect(result.synthesizedOutput).toMatch(/Auto-approval declined/);
    expect(result.stepResults).toHaveLength(0);
  });

  test('honours auto mode — long-form goals require approval', async () => {
    const bus = createBus();
    const longGoal = 'Please ' + 'draft a detailed plan for the quarterly marketing review with multiple stakeholders';
    expect(longGoal.length).toBeGreaterThan(60);
    const run = executeWorkflow(makeInput(longGoal), {
      bus,
      workflowConfig: { requireUserApproval: 'auto', approvalTimeoutMs: 30_000 },
    });
    await new Promise((r) => setTimeout(r, 20));
    // The run should be waiting — we can prove that by emitting reject and
    // observing the failed rejection path.
    bus.emit('workflow:plan_rejected', { taskId: 'task-exec-1' });
    const result = await run;
    expect(result.status).toBe('failed');
    expect(result.synthesizedOutput).toContain('rejected');
  });

  test('honours auto mode — short goals skip approval entirely', async () => {
    const bus = createBus();
    const events: Array<{ name: string; payload: unknown }> = [];
    bus.on('workflow:plan_ready', (p) => events.push({ name: 'plan_ready', payload: p }));
    // No approval event is ever emitted — if the gate were required, this
    // test would hang until timeout. The 30s config timeout ensures this
    // test actually fails (by timing out the test runner) if the gate fires.
    await executeWorkflow(makeInput('hi'), {
      bus,
      workflowConfig: { requireUserApproval: 'auto', approvalTimeoutMs: 30_000 },
    });
    const planReady = events.find((e) => e.name === 'plan_ready');
    expect((planReady!.payload as { awaitingApproval: boolean }).awaitingApproval).toBe(false);
  });

  test('plan_ready carries approvalMode + timeoutMs + autoDecisionAllowed for agent-discretion', async () => {
    const bus = createBus();
    const events: Array<{ name: string; payload: unknown }> = [];
    bus.on('workflow:plan_ready', (p) => events.push({ name: 'plan_ready', payload: p }));
    const run = executeWorkflow(makeInput('analyse something'), {
      bus,
      workflowConfig: { requireUserApproval: true, approvalTimeoutMs: 12_345 },
    });
    await new Promise((r) => setTimeout(r, 20));
    const planReady = events.find((e) => e.name === 'plan_ready');
    const payload = planReady!.payload as {
      awaitingApproval: boolean;
      approvalMode?: string;
      timeoutMs?: number;
      autoDecisionAllowed?: boolean;
    };
    expect(payload.awaitingApproval).toBe(true);
    expect(payload.approvalMode).toBe('agent-discretion');
    expect(payload.timeoutMs).toBe(12_345);
    expect(payload.autoDecisionAllowed).toBe(true);
    bus.emit('workflow:plan_approved', { taskId: 'task-exec-1' });
    await run;
  });

  test('human-required: timeout does NOT auto-approve and surfaces human-needed failure', async () => {
    // Force the planner into a `human-input` step by mocking the LLM to
    // return a plan that the classifier will tag as human-required.
    const humanRequiredPlan = JSON.stringify({
      goal: 'pick one',
      steps: [
        {
          id: 'step1',
          description: 'Please choose which option you want to proceed with',
          strategy: 'human-input',
          budgetFraction: 1.0,
        },
      ],
      synthesisPrompt: 'Combine.',
    });
    const mockProvider = {
      id: 'mock',
      capabilities: { codeGeneration: true, structuredOutput: true },
      generate: async () => ({ content: humanRequiredPlan, tokensUsed: { input: 10, output: 10 } }),
    };
    const bus = createBus();
    const planReadyEvents: Array<unknown> = [];
    const planRejectedEvents: Array<unknown> = [];
    const planApprovedEvents: Array<unknown> = [];
    bus.on('workflow:plan_ready', (p) => planReadyEvents.push(p));
    bus.on('workflow:plan_rejected', (p) => planRejectedEvents.push(p));
    bus.on('workflow:plan_approved', (p) => planApprovedEvents.push(p));

    const result = await executeWorkflow(makeInput('pick one'), {
      bus,
      llmRegistry: { selectByTier: () => mockProvider } as any,
      workflowConfig: { requireUserApproval: 'auto', approvalTimeoutMs: 50 },
    });

    // plan_ready must carry human-required mode + autoDecisionAllowed=false.
    const planReady = planReadyEvents[0] as {
      approvalMode?: string;
      autoDecisionAllowed?: boolean;
    };
    expect(planReady.approvalMode).toBe('human-required');
    expect(planReady.autoDecisionAllowed).toBe(false);

    // No auto-approval allowed in human-required mode.
    expect(planApprovedEvents).toHaveLength(0);
    // Backend tears the gate down with plan_rejected (auto:true) so the UI
    // can unmount the card.
    const rejected = planRejectedEvents[0] as { auto?: boolean; rationale?: string };
    expect(rejected.auto).toBe(true);
    expect(rejected.rationale).toMatch(/Human decision required/);

    expect(result.status).toBe('failed');
    expect(result.synthesizedOutput).toMatch(/Human decision required/);
    expect(result.stepResults).toHaveLength(0);
  });

  test('human-required: explicit user approval still proceeds', async () => {
    const humanRequiredPlan = JSON.stringify({
      goal: 'choose one',
      steps: [
        {
          id: 'step1',
          description: 'Confirm which output you want',
          strategy: 'llm-reasoning',
          budgetFraction: 1.0,
        },
      ],
      synthesisPrompt: 'Combine.',
    });
    const mockProvider = {
      id: 'mock',
      capabilities: { codeGeneration: true, structuredOutput: true },
      generate: async () => ({ content: humanRequiredPlan, tokensUsed: { input: 10, output: 10 } }),
    };
    const bus = createBus();
    const run = executeWorkflow(makeInput('choose one'), {
      bus,
      llmRegistry: { selectByTier: () => mockProvider } as any,
      workflowConfig: { requireUserApproval: 'auto', approvalTimeoutMs: 30_000 },
    });
    await new Promise((r) => setTimeout(r, 20));
    bus.emit('workflow:plan_approved', { taskId: 'task-exec-1' });
    const result = await run;
    expect(result.synthesizedOutput).not.toMatch(/Human decision required/);
  });
});
