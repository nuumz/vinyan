/**
 * Phase 7c-2: tests for the `plan_update` control tool.
 *
 * These exercise the tool's execute() path in isolation — the agent loop is
 * out of scope here, so the tests wire `context.onPlanUpdate` as a stub that
 * records what the tool actually passed downstream and simulate both success
 * and rejection responses.
 */

import { describe, expect, test } from 'bun:test';
// Import via the aggregated re-exports in `built-in-tools.ts` to avoid the
// circular-dependency TDZ trap: control-tools.ts imports `makeResult` from
// built-in-tools.ts, so importing `planUpdate` directly from control-tools.ts
// in a test pulls in a half-initialized built-in-tools module.
import { planUpdate } from '../../../src/orchestrator/tools/built-in-tools.ts';
import type { ToolContext } from '../../../src/orchestrator/tools/tool-interface.ts';
import type { PlanTodoInput } from '../../../src/orchestrator/types.ts';

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    routingLevel: 1,
    allowedPaths: ['src/'],
    workspace: '/tmp/fake-workspace',
    ...overrides,
  };
}

describe('plan_update control tool', () => {
  test('descriptor is a control tool with plan_update name and L1+ routing', () => {
    const d = planUpdate.descriptor();
    expect(d.name).toBe('plan_update');
    expect(d.toolKind).toBe('control');
    expect(d.category).toBe('control');
    expect(d.sideEffect).toBe(false);
    // Phase 7c-2 sets minRoutingLevel to 1 — L0 workers get no plan tool.
    expect(d.minRoutingLevel).toBeGreaterThanOrEqual(1);
    expect(d.inputSchema.required).toContain('todos');
    expect(d.inputSchema.properties.todos).toBeDefined();
  });

  test('description mentions the single-in-progress invariant', () => {
    // The tool's description is what the LLM reads to figure out the contract.
    // The single-in-progress rule MUST be explicit or the LLM will send multi-
    // in-progress batches and collide with the orchestrator's validation.
    expect(planUpdate.description).toMatch(/one item.*in_progress|in_progress.*at a time/i);
  });

  test('happy path — invokes onPlanUpdate and returns success output', async () => {
    const received: PlanTodoInput[][] = [];
    const ctx = makeContext({
      onPlanUpdate: (todos) => {
        received.push(todos);
        return { ok: true, count: todos.length };
      },
    });

    const result = await planUpdate.execute(
      {
        callId: 'call-42',
        todos: [
          { content: 'Step A', activeForm: 'Doing A', status: 'in_progress' },
          { content: 'Step B', activeForm: 'Doing B', status: 'pending' },
        ],
      },
      ctx,
    );

    expect(result.status).toBe('success');
    expect(result.tool).toBe('plan_update');
    expect(result.callId).toBe('call-42');
    expect(result.output).toContain('installed 2');
    // The todos were passed through untouched.
    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(2);
    expect(received[0]![0]!.content).toBe('Step A');
  });

  test('returns denied when context.onPlanUpdate is missing', async () => {
    const ctx = makeContext(); // no onPlanUpdate wired
    const result = await planUpdate.execute(
      {
        callId: 'call-1',
        todos: [{ content: 'X', activeForm: 'Doing X', status: 'pending' }],
      },
      ctx,
    );
    expect(result.status).toBe('denied');
    expect(result.error).toContain('plan_update');
    expect(result.error).toContain('not available');
  });

  test('returns error when todos is not an array', async () => {
    const ctx = makeContext({
      onPlanUpdate: () => {
        throw new Error('onPlanUpdate should NOT be called when validation rejects');
      },
    });
    const result = await planUpdate.execute({ callId: 'call-1', todos: 'not-an-array' }, ctx);
    expect(result.status).toBe('error');
    expect(result.error).toContain('must be an array');
  });

  test('returns error when todos is omitted entirely', async () => {
    const ctx = makeContext({
      onPlanUpdate: () => {
        throw new Error('should not be invoked');
      },
    });
    const result = await planUpdate.execute({ callId: 'call-1' }, ctx);
    expect(result.status).toBe('error');
    expect(result.error).toContain('must be an array');
  });

  test('propagates rejection errors from the orchestrator hook', async () => {
    const ctx = makeContext({
      onPlanUpdate: () => ({ ok: false, error: 'exactly one item may be in_progress; got 2' }),
    });
    const result = await planUpdate.execute(
      {
        callId: 'call-err',
        todos: [
          { content: 'A', activeForm: 'Doing A', status: 'in_progress' },
          { content: 'B', activeForm: 'Doing B', status: 'in_progress' },
        ],
      },
      ctx,
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('plan_update rejected');
    expect(result.error).toContain('in_progress');
  });

  test('accepts an empty todos array (legal plan clear)', async () => {
    const ctx = makeContext({
      onPlanUpdate: (todos) => ({ ok: true, count: todos.length }),
    });
    const result = await planUpdate.execute({ callId: 'c', todos: [] }, ctx);
    expect(result.status).toBe('success');
    expect(result.output).toContain('installed 0');
  });

  test('tool is registered in BUILT_IN_TOOLS under plan_update', async () => {
    const { BUILT_IN_TOOLS } = await import('../../../src/orchestrator/tools/built-in-tools.ts');
    const tool = BUILT_IN_TOOLS.get('plan_update');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('plan_update');
    expect(tool!.descriptor().toolKind).toBe('control');
  });
});
