/**
 * Tests for provider-format.ts — multi-turn message normalization.
 * Phase 6.0: Agentic Worker Protocol.
 */
import { describe, expect, test } from 'bun:test';
import type { HistoryMessage, Message, ToolResultMessage } from '@vinyan/orchestrator/types.ts';
import {
  type AnthropicMessage,
  type OpenAIMessage,
  normalizeMessages,
} from '@vinyan/orchestrator/llm/provider-format.ts';

// ── Helpers ──────────────────────────────────────────────────────────

function msg(role: Message['role'], content: string, extra?: Partial<Message>): Message {
  return { role, content, ...extra };
}

function toolResult(toolCallId: string, content: string, isError?: boolean): ToolResultMessage {
  return { role: 'tool_result', toolCallId, content, ...(isError != null ? { isError } : {}) };
}

// ── Anthropic ────────────────────────────────────────────────────────

describe('normalizeMessages — Anthropic', () => {
  test('simple user + assistant', () => {
    const messages: HistoryMessage[] = [
      msg('user', 'hello'),
      msg('assistant', 'hi there'),
    ];
    const result = normalizeMessages(messages, 'anthropic') as AnthropicMessage[];
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: 'user', content: 'hello' });
    expect(result[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'hi there' }] });
  });

  test('system messages are skipped', () => {
    const messages: HistoryMessage[] = [
      msg('system', 'you are helpful'),
      msg('user', 'hello'),
    ];
    const result = normalizeMessages(messages, 'anthropic') as AnthropicMessage[];
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe('user');
  });

  test('assistant with tool_calls → tool_use content blocks', () => {
    const messages: HistoryMessage[] = [
      msg('assistant', 'let me read that', {
        toolCalls: [
          { id: 'tc1', tool: 'file_read', parameters: { path: 'foo.ts' } },
          { id: 'tc2', tool: 'search_grep', parameters: { pattern: 'bar' } },
        ],
      }),
    ];
    const result = normalizeMessages(messages, 'anthropic') as AnthropicMessage[];
    expect(result).toHaveLength(1);
    const content = result[0]!.content as any[];
    expect(content).toHaveLength(3); // text + 2 tool_use
    expect(content[0]).toEqual({ type: 'text', text: 'let me read that' });
    expect(content[1]).toEqual({ type: 'tool_use', id: 'tc1', name: 'file_read', input: { path: 'foo.ts' } });
    expect(content[2]).toEqual({
      type: 'tool_use',
      id: 'tc2',
      name: 'search_grep',
      input: { pattern: 'bar' },
    });
  });

  test('consecutive tool_results → single user message with multiple blocks', () => {
    const messages: HistoryMessage[] = [
      toolResult('tc1', 'file content here'),
      toolResult('tc2', 'grep results here'),
    ];
    const result = normalizeMessages(messages, 'anthropic') as AnthropicMessage[];
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe('user');
    const content = result[0]!.content as any[];
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'tool_result', tool_use_id: 'tc1', content: 'file content here' });
    expect(content[1]).toEqual({ type: 'tool_result', tool_use_id: 'tc2', content: 'grep results here' });
  });

  test('tool_result with isError includes is_error flag', () => {
    const messages: HistoryMessage[] = [toolResult('tc1', 'ENOENT', true)];
    const result = normalizeMessages(messages, 'anthropic') as AnthropicMessage[];
    const content = (result[0]!.content as any[])[0];
    expect(content.is_error).toBe(true);
  });

  test('tool_call_id in result matches assistant call id', () => {
    const messages: HistoryMessage[] = [
      msg('assistant', '', {
        toolCalls: [{ id: 'call-abc', tool: 'file_read', parameters: {} }],
      }),
      toolResult('call-abc', 'content'),
    ];
    const result = normalizeMessages(messages, 'anthropic') as AnthropicMessage[];
    // Assistant turn has tool_use with id 'call-abc'
    const assistantContent = result[0]!.content as any[];
    expect(assistantContent.find((b: any) => b.type === 'tool_use')?.id).toBe('call-abc');
    // Tool result references same id
    const userContent = result[1]!.content as any[];
    expect(userContent[0].tool_use_id).toBe('call-abc');
  });

  test('thinking block prepended before text', () => {
    const messages: HistoryMessage[] = [
      msg('assistant', 'answer', { thinking: 'let me think...' }),
    ];
    const result = normalizeMessages(messages, 'anthropic') as AnthropicMessage[];
    const content = result[0]!.content as any[];
    expect(content[0]).toEqual({ type: 'thinking', thinking: 'let me think...' });
    expect(content[1]).toEqual({ type: 'text', text: 'answer' });
  });

  test('full multi-turn conversation', () => {
    const messages: HistoryMessage[] = [
      msg('user', 'fix the bug in foo.ts'),
      msg('assistant', 'reading file', {
        toolCalls: [{ id: 'tc1', tool: 'file_read', parameters: { path: 'foo.ts' } }],
      }),
      toolResult('tc1', 'const x = 1;'),
      msg('assistant', 'I see the issue, fixing now', {
        toolCalls: [{ id: 'tc2', tool: 'file_write', parameters: { path: 'foo.ts', content: 'const x = 2;' } }],
      }),
      toolResult('tc2', 'Wrote 13 bytes'),
      msg('assistant', 'Done!'),
    ];
    const result = normalizeMessages(messages, 'anthropic') as AnthropicMessage[];
    expect(result).toHaveLength(6);
    expect(result[0]!.role).toBe('user');
    expect(result[1]!.role).toBe('assistant');
    expect(result[2]!.role).toBe('user'); // tool_result
    expect(result[3]!.role).toBe('assistant');
    expect(result[4]!.role).toBe('user'); // tool_result
    expect(result[5]!.role).toBe('assistant');
  });
});

// ── OpenAI ───────────────────────────────────────────────────────────

describe('normalizeMessages — OpenAI', () => {
  test('system/user/assistant pass through', () => {
    const messages: HistoryMessage[] = [
      msg('system', 'you are helpful'),
      msg('user', 'hello'),
      msg('assistant', 'hi'),
    ];
    const result = normalizeMessages(messages, 'openai-compat') as OpenAIMessage[];
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ role: 'system', content: 'you are helpful' });
    expect(result[1]).toEqual({ role: 'user', content: 'hello' });
    expect(result[2]).toEqual({ role: 'assistant', content: 'hi' });
  });

  test('assistant with toolCalls → tool_calls array', () => {
    const messages: HistoryMessage[] = [
      msg('assistant', 'reading', {
        toolCalls: [{ id: 'tc1', tool: 'file_read', parameters: { path: 'a.ts' } }],
      }),
    ];
    const result = normalizeMessages(messages, 'openai-compat') as OpenAIMessage[];
    expect(result).toHaveLength(1);
    expect(result[0]!.tool_calls).toHaveLength(1);
    expect(result[0]!.tool_calls![0]).toEqual({
      id: 'tc1',
      type: 'function',
      function: { name: 'file_read', arguments: '{"path":"a.ts"}' },
    });
  });

  test('tool_result → separate tool messages', () => {
    const messages: HistoryMessage[] = [
      toolResult('tc1', 'content1'),
      toolResult('tc2', 'content2'),
    ];
    const result = normalizeMessages(messages, 'openai-compat') as OpenAIMessage[];
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: 'tool', content: 'content1', tool_call_id: 'tc1' });
    expect(result[1]).toEqual({ role: 'tool', content: 'content2', tool_call_id: 'tc2' });
  });

  test('thinking is discarded for OpenAI', () => {
    const messages: HistoryMessage[] = [
      msg('assistant', 'answer', { thinking: 'reasoning' }),
    ];
    const result = normalizeMessages(messages, 'openai-compat') as OpenAIMessage[];
    expect(result[0]!.content).toBe('answer');
    // No thinking field in OpenAI format
    expect((result[0] as any).thinking).toBeUndefined();
  });
});

// ── Schema validation ────────────────────────────────────────────────

describe('Phase 6.0 Zod schemas', () => {
  const { WorkerTurnSchema, OrchestratorTurnSchema, AgentBudgetSchema, DelegationRequestSchema } = require(
    '@vinyan/orchestrator/protocol.ts',
  );

  test('WorkerTurn tool_calls with tokensConsumed', () => {
    const result = WorkerTurnSchema.parse({
      type: 'tool_calls',
      turnId: 't0',
      calls: [],
      rationale: 'reading',
      tokensConsumed: 100,
    });
    expect(result.type).toBe('tool_calls');
    expect(result.tokensConsumed).toBe(100);
  });

  test('WorkerTurn done', () => {
    const result = WorkerTurnSchema.parse({
      type: 'done',
      turnId: 't1',
      proposedContent: 'fixed the bug',
    });
    expect(result.type).toBe('done');
  });

  test('WorkerTurn uncertain', () => {
    const result = WorkerTurnSchema.parse({
      type: 'uncertain',
      turnId: 't2',
      reason: 'cannot determine fix',
      uncertainties: ['unclear requirement'],
    });
    expect(result.type).toBe('uncertain');
  });

  test('OrchestratorTurn init', () => {
    const result = OrchestratorTurnSchema.parse({
      type: 'init',
      taskId: 'task-1',
      goal: 'fix bug',
      routingLevel: 1,
      perception: {
        taskTarget: { file: 'a.ts', description: 'fix' },
        dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
        diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
        verifiedFacts: [],
        runtime: { nodeVersion: '22', os: 'darwin', availableTools: [] },
      },
      workingMemory: {
        failedApproaches: [],
        activeHypotheses: [],
        unresolvedUncertainties: [],
        scopedFacts: [],
      },
      budget: {
        maxTokens: 10000,
        maxTurns: 20,
        maxDurationMs: 60000,
        contextWindow: 128000,
        base: 6000,
        negotiable: 2500,
        delegation: 1500,
      },
      allowedPaths: ['src/'],
      toolManifest: [{ name: 'file_read', description: 'Read file', inputSchema: {} }],
    });
    expect(result.type).toBe('init');
    expect(result.budget.maxExtensionRequests).toBe(3); // default
  });

  test('OrchestratorTurn terminate', () => {
    const result = OrchestratorTurnSchema.parse({
      type: 'terminate',
      reason: 'budget_exceeded',
    });
    expect(result.type).toBe('terminate');
  });

  test('AgentBudget defaults', () => {
    const result = AgentBudgetSchema.parse({
      maxTokens: 10000,
      maxTurns: 20,
      maxDurationMs: 60000,
      contextWindow: 128000,
      base: 6000,
      negotiable: 2500,
      delegation: 1500,
    });
    expect(result.maxExtensionRequests).toBe(3);
    expect(result.maxToolCallsPerTurn).toBe(10);
    expect(result.delegationDepth).toBe(0);
    expect(result.maxDelegationDepth).toBe(3);
  });

  test('DelegationRequest', () => {
    const result = DelegationRequestSchema.parse({
      goal: 'fix tests',
      targetFiles: ['src/foo.test.ts'],
      requiredTools: ['file_read', 'file_write'],
    });
    expect(result.goal).toBe('fix tests');
  });
});
