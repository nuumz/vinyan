/**
 * Tests for agent-worker-entry.ts — the agentic worker subprocess core loop.
 *
 * Strategy: test runAgentWorkerLoop() with explicit I/O and ScriptedMockProvider
 * instead of spawning a real subprocess.
 */
import { describe, expect, test } from 'bun:test';
import type { WorkerTurn } from '../../../src/orchestrator/protocol.ts';
import type { HistoryMessage, Message } from '../../../src/orchestrator/types.ts';
import {
  buildInitUserMessage,
  buildSystemPrompt,
  compressHistory,
  estimateHistoryTokens,
  runAgentWorkerLoop,
  type WorkerIO,
} from '../../../src/orchestrator/worker/agent-worker-entry.ts';
import {
  createScriptedMockProvider,
  type ScriptedMockResponse,
} from '../../../src/orchestrator/llm/mock-provider.ts';

// ── Test helpers ─────────────────────────────────────────────────────

function makeInitTurn(overrides?: Record<string, unknown>): string {
  const init = {
    type: 'init',
    taskId: 'task-1',
    goal: 'Write a hello world function',
    routingLevel: 1,
    perception: {
      taskTarget: { file: 'hello.ts', description: 'hello function' },
      dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
      diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
      verifiedFacts: [],
      runtime: { nodeVersion: '22', os: 'linux', availableTools: ['file_read', 'file_write'] },
    },
    workingMemory: {
      failedApproaches: [],
      activeHypotheses: [],
      unresolvedUncertainties: [],
      scopedFacts: [],
    },
    budget: {
      maxTokens: 10000, maxTurns: 10, maxDurationMs: 60000, contextWindow: 128000,
      base: 5000, negotiable: 3000, delegation: 2000,
      maxExtensionRequests: 3, maxToolCallsPerTurn: 10, delegationDepth: 0, maxDelegationDepth: 3,
    },
    allowedPaths: ['/tmp'],
    toolManifest: [
      { name: 'file_read', description: 'Read a file', inputSchema: { path: { type: 'string' } } },
      { name: 'file_write', description: 'Write a file', inputSchema: { path: { type: 'string' }, content: { type: 'string' } } },
      { name: 'attempt_completion', description: 'Signal task completion', inputSchema: { status: { type: 'string' } } },
    ],
    ...overrides,
  };
  return JSON.stringify(init);
}

function makeToolResults(turnId: string, results: Array<{ callId: string; tool: string; output: string }>): string {
  return JSON.stringify({
    type: 'tool_results', turnId,
    results: results.map(r => ({ ...r, status: 'success', durationMs: 10 })),
  });
}

function makeTerminateTurn(): string {
  return JSON.stringify({ type: 'terminate', reason: 'orchestrator_abort' });
}

function createTestIO(inputLines: string[]): { io: WorkerIO; outputs: string[] } {
  const queue = [...inputLines];
  const outputs: string[] = [];
  return {
    io: {
      async readLine(): Promise<string | null> { return queue.shift() ?? null; },
      writeLine(line: string): void { outputs.push(line); },
    },
    outputs,
  };
}

function parseOutputs(outputs: string[]): WorkerTurn[] {
  return outputs.map(line => JSON.parse(line.trim()));
}

/** Type-narrowing helper to avoid verbose discriminated union checks in every test. */
function expectTurn<T extends WorkerTurn['type']>(
  turns: WorkerTurn[], index: number, type: T,
): Extract<WorkerTurn, { type: T }> {
  const turn = turns[index];
  expect(turn).toBeDefined();
  expect(turn!.type).toBe(type);
  return turn as Extract<WorkerTurn, { type: T }>;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('agent-worker-entry', () => {
  describe('runAgentWorkerLoop', () => {
    test('single tool call + attempt_completion produces tool_calls then done', async () => {
      const provider = createScriptedMockProvider([
        {
          stopReason: 'tool_use',
          content: 'Let me read the file first',
          toolCalls: [{ id: 'tc1', tool: 'file_read', parameters: { path: 'hello.ts' } }],
        },
        {
          stopReason: 'tool_use',
          content: 'Done',
          toolCalls: [{ id: 'tc2', tool: 'attempt_completion', parameters: { status: 'done', proposedContent: 'Created hello function' } }],
        },
      ]);

      const { io, outputs } = createTestIO([
        makeInitTurn(),
        makeToolResults('t1', [{ callId: 'tc1', tool: 'file_read', output: 'export function hello() {}' }]),
      ]);

      await runAgentWorkerLoop(provider, io);
      const turns = parseOutputs(outputs);
      expect(turns).toHaveLength(2);

      const t0 = expectTurn(turns, 0, 'tool_calls');
      expect(t0.calls).toHaveLength(1);
      expect(t0.calls[0]!.tool).toBe('file_read');
      expect(t0.tokensConsumed).toBeGreaterThan(0);

      const t1 = expectTurn(turns, 1, 'done');
      expect(t1.proposedContent).toBe('Created hello function');
      expect(t1.tokensConsumed).toBeGreaterThan(0);
    });

    test('end_turn with no tool calls produces implicit done', async () => {
      const provider = createScriptedMockProvider([
        { stopReason: 'end_turn', content: 'The answer is 42', toolCalls: [] },
      ]);
      const { io, outputs } = createTestIO([makeInitTurn()]);

      await runAgentWorkerLoop(provider, io);
      const turns = parseOutputs(outputs);
      expect(turns).toHaveLength(1);
      const t0 = expectTurn(turns, 0, 'done');
      expect(t0.proposedContent).toBe('The answer is 42');
    });

    test('max_tokens triggers compression then continues to done', async () => {
      const provider = createScriptedMockProvider([
        { stopReason: 'max_tokens', content: 'Partial response...', toolCalls: [] },
        { stopReason: 'end_turn', content: 'Finished after compression', toolCalls: [] },
      ]);
      const { io, outputs } = createTestIO([makeInitTurn()]);

      await runAgentWorkerLoop(provider, io);
      const turns = parseOutputs(outputs);
      expect(turns).toHaveLength(1);
      const t0 = expectTurn(turns, 0, 'done');
      expect(t0.proposedContent).toBe('Finished after compression');
    });

    test('max_tokens exhausted after max compression attempts emits uncertain', async () => {
      const provider = createScriptedMockProvider([
        { stopReason: 'max_tokens', content: 'partial 1', toolCalls: [] },
        { stopReason: 'max_tokens', content: 'partial 2', toolCalls: [] },
        { stopReason: 'max_tokens', content: 'partial 3', toolCalls: [] },
      ]);
      const { io, outputs } = createTestIO([makeInitTurn()]);

      await runAgentWorkerLoop(provider, io);
      const turns = parseOutputs(outputs);
      expect(turns).toHaveLength(1);
      const t0 = expectTurn(turns, 0, 'uncertain');
      expect(t0.reason).toContain('max_tokens');
      expect(t0.uncertainties).toContain('Context window exhausted');
    });

    test('uncertain via attempt_completion', async () => {
      const provider = createScriptedMockProvider([
        {
          stopReason: 'tool_use',
          content: 'I am blocked',
          toolCalls: [{
            id: 'tc1', tool: 'attempt_completion',
            parameters: { status: 'uncertain', summary: 'Cannot find the required module', uncertainties: ['Missing dependency', 'Unclear API shape'] },
          }],
        },
      ]);
      const { io, outputs } = createTestIO([makeInitTurn()]);

      await runAgentWorkerLoop(provider, io);
      const turns = parseOutputs(outputs);
      expect(turns).toHaveLength(1);
      const t0 = expectTurn(turns, 0, 'uncertain');
      expect(t0.reason).toBe('Cannot find the required module');
      expect(t0.uncertainties).toEqual(['Missing dependency', 'Unclear API shape']);
    });

    test('attempt_completion mixed with regular tools: regular tools first, then done', async () => {
      const provider = createScriptedMockProvider([
        {
          stopReason: 'tool_use',
          content: 'Writing and completing',
          toolCalls: [
            { id: 'tc1', tool: 'file_write', parameters: { path: 'out.ts', content: 'hello' } },
            { id: 'tc2', tool: 'attempt_completion', parameters: { status: 'done', proposedContent: 'Task complete' } },
          ],
        },
      ]);
      const { io, outputs } = createTestIO([
        makeInitTurn(),
        makeToolResults('t1', [{ callId: 'tc1', tool: 'file_write', output: 'Written' }]),
      ]);

      await runAgentWorkerLoop(provider, io);
      const turns = parseOutputs(outputs);
      expect(turns).toHaveLength(2);

      const t0 = expectTurn(turns, 0, 'tool_calls');
      expect(t0.calls).toHaveLength(1);
      expect(t0.calls[0]!.tool).toBe('file_write');

      const t1 = expectTurn(turns, 1, 'done');
      expect(t1.proposedContent).toBe('Task complete');
    });

    test('terminate from orchestrator exits gracefully', async () => {
      const provider = createScriptedMockProvider([
        { stopReason: 'tool_use', content: 'Reading file', toolCalls: [{ id: 'tc1', tool: 'file_read', parameters: { path: 'x.ts' } }] },
        { stopReason: 'end_turn', content: 'Should not reach here', toolCalls: [] },
      ]);
      const { io, outputs } = createTestIO([makeInitTurn(), makeTerminateTurn()]);

      await runAgentWorkerLoop(provider, io);
      const turns = parseOutputs(outputs);
      expect(turns).toHaveLength(1);
      expectTurn(turns, 0, 'tool_calls');
    });

    test('max turns exhausted emits uncertain', async () => {
      const responses: ScriptedMockResponse[] = Array.from({ length: 3 }, (_, i) => ({
        stopReason: 'tool_use' as const, content: 'call ' + i,
        toolCalls: [{ id: 'tc' + i, tool: 'file_read', parameters: { path: 'f' + i + '.ts' } }],
      }));
      responses.push({ stopReason: 'end_turn', content: 'unreachable', toolCalls: [] });

      const provider = createScriptedMockProvider(responses);
      const toolResults = Array.from({ length: 3 }, (_, i) =>
        makeToolResults('t' + (i + 1), [{ callId: 'tc' + i, tool: 'file_read', output: 'c' + i }])
      );

      const { io, outputs } = createTestIO([
        makeInitTurn({
          budget: {
            maxTokens: 10000, maxTurns: 3, maxDurationMs: 60000, contextWindow: 128000,
            base: 5000, negotiable: 3000, delegation: 2000,
            maxExtensionRequests: 3, maxToolCallsPerTurn: 10, delegationDepth: 0, maxDelegationDepth: 3,
          },
        }),
        ...toolResults,
      ]);

      await runAgentWorkerLoop(provider, io);
      const turns = parseOutputs(outputs);
      const lastTurn = expectTurn(turns, turns.length - 1, 'uncertain');
      expect(lastTurn.reason).toContain('Max turns');
    });

    test('no init turn on stdin exits with no output', async () => {
      const provider = createScriptedMockProvider([]);
      const { io, outputs } = createTestIO([]);
      await runAgentWorkerLoop(provider, io);
      expect(outputs).toHaveLength(0);
    });

    test('invalid init turn exits with no output', async () => {
      const provider = createScriptedMockProvider([]);
      const { io, outputs } = createTestIO(['{"type":"tool_results"}']);
      await runAgentWorkerLoop(provider, io);
      expect(outputs).toHaveLength(0);
    });

    test('tokens are accumulated across turns', async () => {
      const provider = createScriptedMockProvider([
        { stopReason: 'tool_use', content: 'Step 1', toolCalls: [{ id: 'tc1', tool: 'file_read', parameters: { path: 'a.ts' } }], tokensUsed: { input: 200, output: 100 } },
        { stopReason: 'end_turn', content: 'Done', toolCalls: [], tokensUsed: { input: 300, output: 150 } },
      ]);
      const { io, outputs } = createTestIO([
        makeInitTurn(),
        makeToolResults('t1', [{ callId: 'tc1', tool: 'file_read', output: 'content' }]),
      ]);

      await runAgentWorkerLoop(provider, io);
      const turns = parseOutputs(outputs);
      expect(turns).toHaveLength(2);
      expect(turns[0]!.tokensConsumed).toBe(300);
      expect(turns[1]!.tokensConsumed).toBe(750);
    });
  });

  describe('helper functions', () => {
    test('buildSystemPrompt includes routing level', () => {
      const prompt = buildSystemPrompt(2);
      expect(prompt).toContain('L2');
      expect(prompt).toContain('attempt_completion');
    });

    test('buildInitUserMessage formats task and perception', () => {
      const msg = buildInitUserMessage('Write tests', { files: ['a.ts'] });
      expect(msg).toContain('## Goal');
      expect(msg).toContain('Write tests');
      expect(msg).toContain('a.ts');
    });

    test('buildInitUserMessage includes prior attempts when present', () => {
      const msg = buildInitUserMessage('Fix bug', {}, [{ attempt: 1, outcome: 'failed' }]);
      expect(msg).toContain('Prior Attempts');
      expect(msg).toContain('failed');
    });

    test('buildInitUserMessage omits prior attempts when empty', () => {
      const msg = buildInitUserMessage('Fix bug', {}, []);
      expect(msg).not.toContain('Prior Attempts');
    });

    test('estimateHistoryTokens returns positive number', () => {
      const history: HistoryMessage[] = [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Hello' },
      ];
      expect(estimateHistoryTokens(history)).toBeGreaterThan(0);
    });

    test('compressHistory preserves short history unchanged', () => {
      const history: HistoryMessage[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'init' },
        { role: 'assistant', content: 'response' },
      ];
      expect(compressHistory(history)).toEqual(history);
    });

    test('compressHistory compresses middle turns into user message', () => {
      const history: HistoryMessage[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'init task' },
        { role: 'assistant', content: 'thinking...', toolCalls: [{ id: 'tc1', tool: 'file_read', parameters: {} }] },
        { role: 'tool_result', toolCallId: 'tc1', content: 'file content here' },
        { role: 'assistant', content: 'analyzing...' },
        { role: 'user', content: 'more context' },
        { role: 'assistant', content: 'almost done', toolCalls: [{ id: 'tc2', tool: 'file_write', parameters: {} }] },
        { role: 'tool_result', toolCallId: 'tc2', content: 'written' },
        { role: 'assistant', content: 'done!' },
      ];

      const result = compressHistory(history);
      expect(result).toHaveLength(6);
      expect((result[0] as Message).role).toBe('system');
      expect((result[1] as Message).role).toBe('user');

      const compressed = result[2] as Message;
      expect(compressed.role).toBe('user');
      expect(compressed.content).toContain('[COMPRESSED CONTEXT:');
      expect(compressed.content).toContain('file_read');
      expect(compressed.content).toContain('Continue the task');
      expect((result[3] as Message).content).toBe('almost done');
    });

    test('compressHistory marks error tool results distinctly', () => {
      const history: HistoryMessage[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'init' },
        { role: 'assistant', content: 'try' },
        { role: 'tool_result', toolCallId: 'tc1', content: 'ENOENT: file not found', isError: true },
        { role: 'assistant', content: 'retry' },
        { role: 'tool_result', toolCallId: 'tc2', content: 'success output' },
        { role: 'assistant', content: 'k1' },
        { role: 'user', content: 'k2' },
        { role: 'assistant', content: 'k3' },
      ];

      const result = compressHistory(history);
      const compressed = result[2] as Message;
      expect(compressed.content).toContain('[tool_result ERROR]');
      expect(compressed.content).toContain('ENOENT');
    });
  });
});