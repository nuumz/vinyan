import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BUILT_IN_TOOLS } from '../../../src/orchestrator/tools/built-in-tools.ts';
import { ToolExecutor, toolResultToEvidence } from '../../../src/orchestrator/tools/tool-executor.ts';
import type { ToolContext } from '../../../src/orchestrator/tools/tool-interface.ts';
import { validateToolCall } from '../../../src/orchestrator/tools/tool-validator.ts';
import type { ToolCall } from '../../../src/orchestrator/types.ts';

let tempDir: string;
let executor: ToolExecutor;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'vinyan-tools-test-'));
  mkdirSync(join(tempDir, 'src'), { recursive: true });
  writeFileSync(join(tempDir, 'src', 'foo.ts'), 'export const x = 1;\n');
  executor = new ToolExecutor();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    routingLevel: 1,
    allowedPaths: ['src/'],
    workspace: tempDir,
    ...overrides,
  };
}

function makeCall(tool: string, params: Record<string, unknown>): ToolCall {
  return { id: `tc-${Math.random().toString(36).slice(2, 6)}`, tool, parameters: params };
}

// §18.5 Acceptance Criteria

describe('Tool Execution — §18.5 Acceptance Criteria', () => {
  test('1. file_read works at L0', async () => {
    const ctx = makeContext({ routingLevel: 0 });
    const results = await executor.executeProposedTools([makeCall('file_read', { file_path: 'src/foo.ts' })], ctx);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('success');
    expect(results[0]!.output).toContain('export const x');
  });

  test('2. file_write blocked at L0', async () => {
    const ctx = makeContext({ routingLevel: 0 });
    const results = await executor.executeProposedTools(
      [makeCall('file_write', { file_path: 'src/bar.ts', content: 'new file' })],
      ctx,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('denied');
    expect(results[0]!.error).toContain('isolation level');
  });

  test('3. file_write works at L1 within allowedPaths', async () => {
    const ctx = makeContext({ routingLevel: 1 });
    const results = await executor.executeProposedTools(
      [makeCall('file_write', { file_path: 'src/bar.ts', content: 'const y = 2;\n' })],
      ctx,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('success');
    const written = readFileSync(join(tempDir, 'src', 'bar.ts'), 'utf-8');
    expect(written).toBe('const y = 2;\n');
  });

  test('4. file_write blocked outside allowedPaths', async () => {
    const ctx = makeContext({ routingLevel: 1, allowedPaths: ['src/'] });
    const results = await executor.executeProposedTools(
      [makeCall('file_write', { file_path: '/etc/passwd', content: 'hack' })],
      ctx,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('denied');
    expect(results[0]!.error).toContain('Absolute path');
  });

  test('C1. absolute path rejected even with allowedPaths', async () => {
    const ctx = makeContext({ routingLevel: 1, allowedPaths: ['src/'] });
    const results = await executor.executeProposedTools(
      [makeCall('file_read', { file_path: '/etc/shadow', content: '' })],
      ctx,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('denied');
    expect(results[0]!.error).toContain('Absolute path');
  });

  test('C1b. write denied when allowedPaths is empty', async () => {
    const ctx = makeContext({ routingLevel: 1, allowedPaths: [] });
    const results = await executor.executeProposedTools(
      [makeCall('file_write', { file_path: 'src/bar.ts', content: 'x' })],
      ctx,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('denied');
    expect(results[0]!.error).toContain('no allowed paths');
  });

  test('5. shell_exec allowlist enforced (allowed command)', async () => {
    const ctx = makeContext({ routingLevel: 1 });
    const call = makeCall('shell_exec', { command: 'git status' });
    const tool = BUILT_IN_TOOLS.get('shell_exec')!;
    const validation = validateToolCall(call, tool, ctx);
    expect(validation.valid).toBe(true);
  });

  test('5b. shell_exec allowlist enforced (blocked command)', async () => {
    const ctx = makeContext({ routingLevel: 1 });
    const call = makeCall('shell_exec', { command: 'rm -rf /' });
    const tool = BUILT_IN_TOOLS.get('shell_exec')!;
    const validation = validateToolCall(call, tool, ctx);
    expect(validation.valid).toBe(false);
    expect(validation.reason).toContain('not in allowlist');
  });

  test('C2. shell command with semicolon injection rejected', () => {
    const ctx = makeContext({ routingLevel: 1 });
    const call = makeCall('shell_exec', { command: 'git status; rm -rf /' });
    const tool = BUILT_IN_TOOLS.get('shell_exec')!;
    const validation = validateToolCall(call, tool, ctx);
    expect(validation.valid).toBe(false);
    expect(validation.reason).toContain('dangerous metacharacter');
  });

  test('C2b. shell command with pipe injection rejected', () => {
    const ctx = makeContext({ routingLevel: 1 });
    const call = makeCall('shell_exec', { command: 'git log | cat /etc/passwd' });
    const tool = BUILT_IN_TOOLS.get('shell_exec')!;
    const validation = validateToolCall(call, tool, ctx);
    expect(validation.valid).toBe(false);
    expect(validation.reason).toContain('dangerous metacharacter');
  });

  test('6. bypass pattern detected → blocked', async () => {
    const ctx = makeContext({ routingLevel: 1 });
    const results = await executor.executeProposedTools(
      [makeCall('file_write', { file_path: 'src/x.ts', content: 'skip oracle verification' })],
      ctx,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('denied');
  });

  test('7. tool results have content hash (A4)', async () => {
    const ctx = makeContext({ routingLevel: 1 });
    const results = await executor.executeProposedTools(
      [makeCall('file_write', { file_path: 'src/new.ts', content: 'const z = 3;\n' })],
      ctx,
    );
    expect(results[0]!.evidence).toBeDefined();
    expect(results[0]!.evidence!.contentHash).toBeDefined();
    expect(results[0]!.evidence!.contentHash!.length).toBe(64); // SHA-256 hex
  });

  test('8. all tool results wrapped as ECP evidence', () => {
    const call = makeCall('file_write', { file_path: 'src/x.ts' });
    const result = {
      callId: call.id,
      tool: 'file_write',
      status: 'success' as const,
      output: 'wrote 10 bytes',
      evidence: { file: 'src/x.ts', line: 0, snippet: 'const x', contentHash: 'abc123' },
      durationMs: 5,
    };
    const evidence = toolResultToEvidence(result, call);
    expect(evidence.file).toBe('src/x.ts');
    expect(evidence.contentHash).toBe('abc123');
  });
});

describe('Tool Executor — additional', () => {
  test('unknown tool returns denied', async () => {
    const ctx = makeContext();
    const results = await executor.executeProposedTools([makeCall('nonexistent_tool', {})], ctx);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('denied');
    expect(results[0]!.error).toContain('Unknown tool');
  });

  test('getToolNames returns all 13 built-in tools', () => {
    expect(executor.getToolNames()).toHaveLength(13);
    expect(executor.getToolNames()).toContain('file_read');
    expect(executor.getToolNames()).toContain('shell_exec');
    expect(executor.getToolNames()).toContain('search_semantic');
    expect(executor.getToolNames()).toContain('http_get');
  });
});

describe('ToolExecutor.partitionBySideEffect', () => {
  function makeSideEffectCall(tool: string, id?: string): ToolCall {
    return { id: id ?? `call-${tool}`, tool, parameters: {} };
  }

  test('file_read goes to readOnly', () => {
    const calls = [makeSideEffectCall('file_read')];
    const { readOnly, mutating } = executor.partitionBySideEffect(calls);
    expect(readOnly).toHaveLength(1);
    expect(mutating).toHaveLength(0);
    expect(readOnly[0]!.tool).toBe('file_read');
  });

  test('file_write goes to mutating', () => {
    const calls = [makeSideEffectCall('file_write')];
    const { readOnly, mutating } = executor.partitionBySideEffect(calls);
    expect(mutating).toHaveLength(1);
    expect(readOnly).toHaveLength(0);
    expect(mutating[0]!.tool).toBe('file_write');
  });

  test('shell_exec goes to mutating', () => {
    const calls = [makeSideEffectCall('shell_exec')];
    const { readOnly, mutating } = executor.partitionBySideEffect(calls);
    expect(mutating).toHaveLength(1);
    expect(readOnly).toHaveLength(0);
  });

  test('search_grep goes to readOnly', () => {
    const calls = [makeSideEffectCall('search_grep')];
    const { readOnly, mutating } = executor.partitionBySideEffect(calls);
    expect(readOnly).toHaveLength(1);
    expect(mutating).toHaveLength(0);
  });

  test('git_status goes to readOnly', () => {
    const calls = [makeSideEffectCall('git_status')];
    const { readOnly, mutating } = executor.partitionBySideEffect(calls);
    expect(readOnly).toHaveLength(1);
    expect(mutating).toHaveLength(0);
  });

  test('git_diff goes to readOnly', () => {
    const calls = [makeSideEffectCall('git_diff')];
    const { readOnly, mutating } = executor.partitionBySideEffect(calls);
    expect(readOnly).toHaveLength(1);
    expect(mutating).toHaveLength(0);
  });

  test('unknown tool name goes to mutating (conservative)', () => {
    const calls = [makeSideEffectCall('unknown_tool_xyz')];
    const { readOnly, mutating } = executor.partitionBySideEffect(calls);
    expect(mutating).toHaveLength(1);
    expect(readOnly).toHaveLength(0);
  });

  test('empty array returns empty readOnly and mutating', () => {
    const { readOnly, mutating } = executor.partitionBySideEffect([]);
    expect(readOnly).toHaveLength(0);
    expect(mutating).toHaveLength(0);
  });

  test('mixed calls are split correctly', () => {
    const calls = [
      makeSideEffectCall('file_read', 'r1'),
      makeSideEffectCall('file_write', 'w1'),
      makeSideEffectCall('search_grep', 'r2'),
      makeSideEffectCall('shell_exec', 'w2'),
      makeSideEffectCall('git_status', 'r3'),
    ];
    const { readOnly, mutating } = executor.partitionBySideEffect(calls);
    expect(readOnly).toHaveLength(3);
    expect(mutating).toHaveLength(2);
    expect(readOnly.map((c) => c.id)).toEqual(['r1', 'r2', 'r3']);
    expect(mutating.map((c) => c.id)).toEqual(['w1', 'w2']);
  });

  test('preserves order within each partition', () => {
    const calls = [
      makeSideEffectCall('file_read', 'a'),
      makeSideEffectCall('file_read', 'b'),
      makeSideEffectCall('file_read', 'c'),
    ];
    const { readOnly } = executor.partitionBySideEffect(calls);
    expect(readOnly.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });
});
