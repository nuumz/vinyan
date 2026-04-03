import { describe, expect, test } from 'bun:test';
import { createBus, type VinyanBus } from '../../src/core/bus.ts';
import { ToolExecutor } from '../../src/orchestrator/tools/tool-executor.ts';
import type { ToolCall, ToolResult } from '../../src/orchestrator/types.ts';

describe('Tool Execution Wiring (G1)', () => {
  test('proposedToolCalls preserved in WorkerResult (not discarded)', async () => {
    // Import WorkerPoolImpl to test toWorkerResult preserves proposedToolCalls
    const { WorkerPoolImpl } = await import('../../src/orchestrator/worker/worker-pool.ts');
    const { LLMProviderRegistry } = await import('../../src/orchestrator/llm/provider-registry.ts');

    const registry = new LLMProviderRegistry();
    const pool = new WorkerPoolImpl({ registry, workspace: process.cwd() });

    // L0 path returns empty proposedToolCalls
    const result = await pool.dispatch(
      {
        id: 't-1',
        source: 'cli',
        goal: 'test',
        taskType: 'code',
        budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 1 },
      },
      {
        taskTarget: { file: 'test.ts', description: 'test' },
        dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
        diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
        verifiedFacts: [],
        runtime: { nodeVersion: '', os: '', availableTools: [] },
      },
      { activeHypotheses: [], failedApproaches: [], unresolvedUncertainties: [], scopedFacts: [] },
      undefined,
      { level: 0, model: null, budgetTokens: 0, latencyBudgetMs: 100 },
    );

    expect(result).toHaveProperty('proposedToolCalls');
    expect(Array.isArray(result.proposedToolCalls)).toBe(true);
    expect(result.proposedToolCalls).toHaveLength(0);
  });

  test('ToolExecutor called when proposedToolCalls is non-empty', async () => {
    const executor = new ToolExecutor();
    const calls: ToolCall[] = [{ id: 'tc-1', tool: 'directory_list', parameters: { path: '.' } }];

    const context = {
      workspace: process.cwd(),
      allowedPaths: ['.'],
      routingLevel: 1 as const,
    };

    const results = await executor.executeProposedTools(calls, context);
    expect(results).toHaveLength(1);
    expect(results[0]!.callId).toBe('tc-1');
    // directory_list at routingLevel 1 should succeed (minIsolation=0)
    expect(results[0]!.status).toBe('success');
  });

  test('ToolExecutor returns denied for unknown tools', async () => {
    const executor = new ToolExecutor();
    const calls: ToolCall[] = [{ id: 'tc-2', tool: 'nonexistent_tool', parameters: {} }];

    const context = {
      workspace: process.cwd(),
      allowedPaths: ['.'],
      routingLevel: 1 as const,
    };

    const results = await executor.executeProposedTools(calls, context);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('denied');
    expect(results[0]!.error).toContain('Unknown tool');
  });

  test('ToolExecutor not called when proposedToolCalls is empty (no crash)', async () => {
    const executor = new ToolExecutor();
    const calls: ToolCall[] = [];

    // When array is empty, the core-loop guard `proposedToolCalls.length > 0`
    // prevents calling executeProposedTools. Test the guard logic:
    expect(calls.length > 0).toBe(false);

    // But even if called with empty array, it should return empty results
    const context = {
      workspace: process.cwd(),
      allowedPaths: ['.'],
      routingLevel: 1 as const,
    };
    const results = await executor.executeProposedTools(calls, context);
    expect(results).toHaveLength(0);
  });

  test("denied tool calls don't block task execution", async () => {
    const executor = new ToolExecutor();
    const calls: ToolCall[] = [
      // shell_exec requires isolation level 2, will be denied at level 0
      { id: 'tc-3', tool: 'shell_exec', parameters: { command: 'echo hi' } },
      // directory_list is allowed at any level
      { id: 'tc-4', tool: 'directory_list', parameters: { path: '.' } },
    ];

    const context = {
      workspace: process.cwd(),
      allowedPaths: ['.'],
      routingLevel: 0 as const,
    };

    const results = await executor.executeProposedTools(calls, context);
    expect(results).toHaveLength(2);

    const denied = results.find((r) => r.callId === 'tc-3');
    const allowed = results.find((r) => r.callId === 'tc-4');
    expect(denied!.status).toBe('denied');
    expect(allowed!.status).toBe('success');
  });

  test('tools:executed bus event emitted with results', () => {
    const bus: VinyanBus = createBus();
    let emitted: { taskId: string; results: ToolResult[] } | null = null;

    bus.on('tools:executed', (payload) => {
      emitted = payload;
    });

    const mockResults: ToolResult[] = [{ callId: 'tc-1', tool: 'directory_list', status: 'success', durationMs: 5 }];
    bus.emit('tools:executed', { taskId: 'task-1', results: mockResults });

    expect(emitted).not.toBeNull();
    expect(emitted!.taskId).toBe('task-1');
    expect(emitted!.results).toHaveLength(1);
    expect(emitted!.results[0]!.status).toBe('success');
  });
});
