/**
 * Tests for K1.3 Tool Authorization — capability-based tool access control.
 */
import { describe, expect, test } from 'bun:test';
import { createContract } from '../../src/core/agent-contract.ts';
import type { RoutingDecision, TaskInput } from '../../src/orchestrator/types.ts';
import { authorizeToolCall, classifyTool } from '../../src/security/tool-authorization.ts';

const mockTask: TaskInput = {
  id: 'auth-test-1',
  source: 'cli',
  goal: 'test authorization',
  taskType: 'code',
  budget: { maxTokens: 50_000, maxRetries: 3, maxDurationMs: 60_000 },
};

function contractAt(level: 0 | 1 | 2 | 3) {
  const routing: RoutingDecision = {
    level,
    model: level === 0 ? null : 'test-model',
    budgetTokens: level * 25_000,
    latencyBudgetMs: level * 15_000,
  };
  return createContract(mockTask, routing);
}

describe('classifyTool', () => {
  test('read_file → file_read', () => {
    const result = classifyTool('read_file', { path: '/src/foo.ts' });
    expect(result.type).toBe('file_read');
  });

  test('write_file → file_write', () => {
    const result = classifyTool('write_file', { path: '/src/foo.ts' });
    expect(result.type).toBe('file_write');
  });

  test('shell read-only command → shell_read', () => {
    const result = classifyTool('run_command', { command: 'cat src/foo.ts' });
    expect(result.type).toBe('shell_read');
  });

  test('shell mutating command → shell_exec', () => {
    const result = classifyTool('run_command', { command: 'rm -rf /tmp/test' });
    expect(result.type).toBe('shell_exec');
  });

  test('llm_call → llm_call', () => {
    const result = classifyTool('llm_call', { provider: 'anthropic' });
    expect(result.type).toBe('llm_call');
  });

  test('unknown tool → shell_exec (deny path)', () => {
    const result = classifyTool('exotic_tool', {});
    expect(result.type).toBe('shell_exec');
    expect(result.scope).toContain('UNKNOWN_TOOL');
  });

  test('Phase 7e: mcp__server__tool → mcp_call with server scope', () => {
    const result = classifyTool('mcp__github__create_issue', { title: 'bug' });
    expect(result.type).toBe('mcp_call');
    expect(result.scope).toEqual(['github']);
  });

  test('Phase 7e: multi-segment mcp tool name splits only on first separator', () => {
    const result = classifyTool('mcp__fs__read__dir', {});
    expect(result.type).toBe('mcp_call');
    expect(result.scope).toEqual(['fs']);
  });
});

describe('authorizeToolCall', () => {
  test('L0 denies everything (no capabilities)', () => {
    const contract = contractAt(0);
    const result = authorizeToolCall(contract, 'read_file', { path: 'src/foo.ts' });
    expect(result.authorized).toBe(false);
    expect(result.violation).toContain('L0');
  });

  test('L1 allows file_read', () => {
    const contract = contractAt(1);
    const result = authorizeToolCall(contract, 'read_file', { path: 'src/foo.ts' });
    expect(result.authorized).toBe(true);
  });

  test('L1 denies file_write', () => {
    const contract = contractAt(1);
    const result = authorizeToolCall(contract, 'write_file', { path: 'src/foo.ts' });
    expect(result.authorized).toBe(false);
  });

  test('L2 allows file_write in workspace scope', () => {
    const contract = contractAt(2);
    const result = authorizeToolCall(contract, 'write_file', { path: 'src/foo.ts' });
    expect(result.authorized).toBe(true);
  });

  test('L2 allows shell_exec', () => {
    const contract = contractAt(2);
    const result = authorizeToolCall(contract, 'run_command', { command: 'bun test' });
    expect(result.authorized).toBe(true);
  });

  test('unknown tool denied at any level (A6 zero-trust)', () => {
    const contract = contractAt(2);
    const result = authorizeToolCall(contract, 'exotic_tool', {});
    expect(result.authorized).toBe(false);
    expect(result.violation).toContain('exotic_tool');
  });

  test('L3 allows llm_call', () => {
    const contract = contractAt(3);
    const result = authorizeToolCall(contract, 'llm_call', { provider: 'anthropic' });
    expect(result.authorized).toBe(true);
  });

  test('Phase 7e: L2 allows mcp_call via wildcard server scope', () => {
    const contract = contractAt(2);
    const result = authorizeToolCall(contract, 'mcp__github__create_issue', { title: 'bug' });
    expect(result.authorized).toBe(true);
  });

  test('Phase 7e: L1 denies mcp_call (no capability granted)', () => {
    const contract = contractAt(1);
    const result = authorizeToolCall(contract, 'mcp__github__create_issue', {});
    expect(result.authorized).toBe(false);
  });

  test('Phase 7e: L3 allows mcp_call on any server', () => {
    const contract = contractAt(3);
    const result = authorizeToolCall(contract, 'mcp__slack__post_message', { text: 'hi' });
    expect(result.authorized).toBe(true);
  });
});
