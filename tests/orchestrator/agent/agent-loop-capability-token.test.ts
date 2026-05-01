/**
 * R4 integration — buildSubTaskInput → TaskInput.capabilityToken
 *                  → ToolContext (mirrors agent-loop wiring)
 *                  → ToolExecutor.checkCapability → allow/deny.
 *
 * Verifies the full runtime chain end-to-end without spinning up the
 * full agent loop (which needs an LLM provider, workspace, etc.). The
 * one piece we DON'T exercise here is the agent-loop's literal spread
 * of `input.capabilityToken` onto ToolContext — we replicate that exact
 * spread here and assert the resulting context enforces the token.
 *
 * If this test breaks when agent-loop changes how it constructs its
 * ToolContext, the integration broke and the failsafe path needs review.
 */
import { describe, expect, test } from 'bun:test';
import { buildSubTaskInput } from '../../../src/orchestrator/delegation-router.ts';
import type { AgentBudget, DelegationRequest } from '../../../src/orchestrator/protocol.ts';
import { ToolExecutor } from '../../../src/orchestrator/tools/tool-executor.ts';
import type { ToolContext } from '../../../src/orchestrator/tools/tool-interface.ts';
import type { RoutingDecision, TaskInput, ToolCall } from '../../../src/orchestrator/types.ts';

function makeBudget(): AgentBudget {
  return {
    maxTokens: 10_000,
    maxTurns: 30,
    maxDurationMs: 60_000,
    contextWindow: 128_000,
    base: 6000,
    negotiable: 2500,
    delegation: 1500,
    maxExtensionRequests: 3,
    maxToolCallsPerTurn: 10,
    maxToolCalls: 20,
    delegationDepth: 0,
    maxDelegationDepth: 2,
  };
}

function makeParent(): TaskInput {
  return {
    id: 'task-parent',
    source: 'cli',
    goal: 'Fix bug',
    taskType: 'code',
    targetFiles: ['src/foo.ts', 'src/bar.ts'],
    budget: { maxTokens: 10_000, maxDurationMs: 60_000, maxRetries: 3 },
  };
}

function makeRouting(): RoutingDecision {
  return { level: 2, model: 'claude-sonnet', budgetTokens: 10_000, latencyBudgetMs: 30_000 };
}

/**
 * Mirror of agent-loop.ts:993 ToolContext construction — keep in sync if
 * agent-loop changes how it threads token + parentTaskId.
 */
function makeContextFromInput(input: TaskInput): ToolContext {
  return {
    routingLevel: 2,
    allowedPaths: input.targetFiles ?? [],
    workspace: '/tmp/workspace',
    taskId: input.id,
    ...(input.capabilityToken ? { capabilityToken: input.capabilityToken } : {}),
    ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
  };
}

describe('R4 integration — delegation-router → agent-loop ToolContext → tool-executor', () => {
  test("explore sub-task: file_write on a target file is denied with tool_forbidden", async () => {
    const request: DelegationRequest = {
      goal: 'Survey the auth module',
      targetFiles: ['src/foo.ts'],
      subagentType: 'explore',
    };
    const subInput = buildSubTaskInput(request, makeParent(), makeRouting(), makeBudget());
    expect(subInput.capabilityToken).toBeDefined();
    expect(subInput.parentTaskId).toBe('task-parent');

    const exec = new ToolExecutor();
    const ctx = makeContextFromInput(subInput);

    const calls: ToolCall[] = [
      { id: 'c1', tool: 'file_write', parameters: { path: 'src/foo.ts', content: '...' } },
    ];
    const results = await exec.executeProposedTools(calls, ctx);
    expect(results[0]?.status).toBe('denied');
    expect(results[0]?.error).toContain('capability_token');
    expect(results[0]?.error).toContain('tool_forbidden');
  });

  test('general-purpose sub-task: write within allowedPaths is permitted by capability check', async () => {
    const request: DelegationRequest = {
      goal: 'Edit a helper',
      targetFiles: ['src/foo.ts'],
      subagentType: 'general-purpose',
      requiredTools: ['file_read', 'file_edit'],
    };
    const subInput = buildSubTaskInput(request, makeParent(), makeRouting(), makeBudget());

    const exec = new ToolExecutor();
    const ctx = makeContextFromInput(subInput);

    // Capability check should ALLOW file_edit on src/foo.ts. The tool
    // may then fail for unrelated reasons (validation, file missing) —
    // we only assert the rejection is NOT a capability_token rejection.
    const calls: ToolCall[] = [
      { id: 'c1', tool: 'file_edit', parameters: { path: 'src/foo.ts' } },
    ];
    const results = await exec.executeProposedTools(calls, ctx);
    expect(results[0]?.error ?? '').not.toContain('capability_token');
  });

  test('general-purpose sub-task: write OUTSIDE allowedPaths is denied with path_out_of_scope', async () => {
    const request: DelegationRequest = {
      goal: 'Edit a helper',
      targetFiles: ['src/foo.ts'],
      subagentType: 'general-purpose',
      requiredTools: ['file_edit'],
    };
    const subInput = buildSubTaskInput(request, makeParent(), makeRouting(), makeBudget());
    const exec = new ToolExecutor();
    const ctx = makeContextFromInput(subInput);
    const calls: ToolCall[] = [
      { id: 'c1', tool: 'file_edit', parameters: { path: 'src/escaped.ts', content: '...' } },
    ];
    const results = await exec.executeProposedTools(calls, ctx);
    expect(results[0]?.status).toBe('denied');
    expect(results[0]?.error).toContain('path_out_of_scope');
  });

  test('top-level task (no buildSubTaskInput call) preserves pre-R4 pass-through', async () => {
    const top: TaskInput = makeParent();
    const exec = new ToolExecutor();
    const ctx = makeContextFromInput(top); // no token, no parentTaskId
    const calls: ToolCall[] = [
      { id: 'c1', tool: 'file_read', parameters: { path: 'src/foo.ts' } },
    ];
    const results = await exec.executeProposedTools(calls, ctx);
    expect(results[0]?.error ?? '').not.toContain('capability_token');
  });
});
