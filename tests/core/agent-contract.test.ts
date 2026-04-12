/**
 * Tests for K1.2 AgentContract — types, factory, and budget bridge.
 */
import { describe, expect, test } from 'bun:test';
import { createContract } from '../../src/core/agent-contract.ts';
import type { RoutingDecision, TaskInput } from '../../src/orchestrator/types.ts';
import { AgentBudgetTracker } from '../../src/orchestrator/worker/agent-budget.ts';

const mockTask: TaskInput = {
  id: 'test-task-1',
  source: 'cli',
  goal: 'Fix the bug',
  taskType: 'code',
  budget: { maxTokens: 50_000, maxRetries: 3, maxDurationMs: 60_000 },
};

function makeRouting(level: 0 | 1 | 2 | 3): RoutingDecision {
  return {
    level,
    model: level === 0 ? null : 'test-model',
    budgetTokens: level * 25_000,
    latencyBudgetMs: level * 15_000,
  };
}

describe('createContract', () => {
  test('L0 → no capabilities', () => {
    const contract = createContract(mockTask, makeRouting(0));
    expect(contract.routingLevel).toBe(0);
    expect(contract.capabilities).toEqual([]);
    expect(contract.maxToolCalls).toBe(0);
    expect(contract.immutable).toBe(true);
  });

  test('L1 → read-only capabilities', () => {
    const contract = createContract(mockTask, makeRouting(1));
    expect(contract.routingLevel).toBe(1);
    const types = contract.capabilities.map((c) => c.type);
    expect(types).toContain('file_read');
    expect(types).toContain('shell_read');
    expect(types).not.toContain('file_write');
    expect(types).not.toContain('shell_exec');
    expect(contract.maxToolCalls).toBe(0);
  });

  test('L2 → read + write in workspace', () => {
    const contract = createContract(mockTask, makeRouting(2));
    expect(contract.routingLevel).toBe(2);
    const types = contract.capabilities.map((c) => c.type);
    expect(types).toContain('file_read');
    expect(types).toContain('file_write');
    expect(types).toContain('shell_exec');
    expect(types).toContain('llm_call');
    // Phase 7e: MCP access at L2+
    expect(types).toContain('mcp_call');
    expect(contract.maxToolCalls).toBe(20);
  });

  test('L3 → full access', () => {
    const contract = createContract(mockTask, makeRouting(3));
    expect(contract.routingLevel).toBe(3);
    const types = contract.capabilities.map((c) => c.type);
    expect(types).toContain('file_read');
    expect(types).toContain('file_write');
    expect(types).toContain('shell_exec');
    expect(types).toContain('llm_call');
    expect(types).toContain('mcp_call');
    expect(contract.maxToolCalls).toBe(50);
  });

  test('L0/L1 → no mcp_call capability', () => {
    const l0 = createContract(mockTask, makeRouting(0));
    const l1 = createContract(mockTask, makeRouting(1));
    expect(l0.capabilities.map((c) => c.type)).not.toContain('mcp_call');
    expect(l1.capabilities.map((c) => c.type)).not.toContain('mcp_call');
  });

  test('contract taskId matches input', () => {
    const contract = createContract(mockTask, makeRouting(2));
    expect(contract.taskId).toBe('test-task-1');
  });

  test('violation policy: L0-L1 = kill, L2+ = warn_then_kill', () => {
    expect(createContract(mockTask, makeRouting(0)).onViolation).toBe('kill');
    expect(createContract(mockTask, makeRouting(1)).onViolation).toBe('kill');
    expect(createContract(mockTask, makeRouting(2)).onViolation).toBe('warn_then_kill');
    expect(createContract(mockTask, makeRouting(3)).onViolation).toBe('warn_then_kill');
  });
});

describe('AgentBudgetTracker.fromContract', () => {
  test('produces same budget shape as fromRouting', () => {
    const routing = makeRouting(2);
    const contract = createContract(mockTask, routing);
    const contextWindow = 128_000;

    const budgetFromRouting = AgentBudgetTracker.fromRouting(routing, contextWindow);
    const budgetFromContract = AgentBudgetTracker.fromContract(contract, contextWindow);

    // Both should allow continuation and have same remaining tool calls
    expect(budgetFromRouting.canContinue()).toBe(budgetFromContract.canContinue());
    expect(budgetFromRouting.remainingToolCalls).toBe(budgetFromContract.remainingToolCalls);
  });
});
