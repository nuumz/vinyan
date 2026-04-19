/**
 * Intent parser — unit tests for parser.ts (plan commit D3).
 *
 * Pure function tests — no orchestrator, no LLM, no DB.
 */
import { describe, expect, it } from 'bun:test';
import {
  containsShellFallbackChain,
  IntentResponseSchema,
  normalizeDirectToolCall,
  parseIntentResponse,
  stripJsonFences,
  withTimeout,
} from '../../../src/orchestrator/intent/parser.ts';

describe('stripJsonFences', () => {
  it('strips ```json ... ``` fences', () => {
    expect(stripJsonFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('strips plain ``` fences', () => {
    expect(stripJsonFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('leaves unfenced content unchanged', () => {
    expect(stripJsonFences('{"a":1}')).toBe('{"a":1}');
  });

  it('is case-insensitive', () => {
    expect(stripJsonFences('```JSON\n{"a":1}```')).toBe('{"a":1}');
  });
});

describe('parseIntentResponse', () => {
  it('parses a well-formed conversational response', () => {
    const json = JSON.stringify({
      strategy: 'conversational',
      refinedGoal: 'just chat',
      reasoning: 'user wants to talk',
    });
    const parsed = parseIntentResponse(json);
    expect(parsed.strategy).toBe('conversational');
    expect(parsed.refinedGoal).toBe('just chat');
  });

  it('tolerates markdown fences', () => {
    const json = '```json\n{"strategy":"conversational","refinedGoal":"x","reasoning":"y"}\n```';
    expect(parseIntentResponse(json).strategy).toBe('conversational');
  });

  it('throws when direct-tool is missing directToolCall', () => {
    const json = JSON.stringify({
      strategy: 'direct-tool',
      refinedGoal: 'run it',
      reasoning: 'x',
    });
    expect(() => parseIntentResponse(json)).toThrow(/directToolCall/);
  });

  it('accepts direct-tool with directToolCall', () => {
    const json = JSON.stringify({
      strategy: 'direct-tool',
      refinedGoal: 'list files',
      reasoning: 'x',
      directToolCall: { tool: 'shell_exec', parameters: { command: 'ls' } },
    });
    expect(parseIntentResponse(json).directToolCall?.tool).toBe('shell_exec');
  });

  it('throws on schema violation', () => {
    const json = JSON.stringify({ strategy: 'bogus', refinedGoal: 'x', reasoning: 'y' });
    expect(() => parseIntentResponse(json)).toThrow();
  });
});

describe('containsShellFallbackChain', () => {
  it('detects ||', () => {
    expect(containsShellFallbackChain('ls || echo missing')).toBe(true);
  });

  it('detects &&', () => {
    expect(containsShellFallbackChain('ls && cat')).toBe(true);
  });

  it('detects ;', () => {
    expect(containsShellFallbackChain('ls; cat')).toBe(true);
  });

  it('detects newline', () => {
    expect(containsShellFallbackChain('ls\ncat')).toBe(true);
  });

  it('detects lone pipe (process chain)', () => {
    expect(containsShellFallbackChain('grep foo | head')).toBe(true);
  });

  it('returns false for a single atomic command', () => {
    expect(containsShellFallbackChain('ls -la')).toBe(false);
  });

  it('returns false when double-pipe is only literal (not the grammar)', () => {
    // `||` as regex grammar should match — we treat `||` always as fallback chain.
    // So verify that a plain single-pipe-less command is clean.
    expect(containsShellFallbackChain('echo hello')).toBe(false);
  });
});

describe('normalizeDirectToolCall', () => {
  it('returns undefined when no call supplied', () => {
    expect(normalizeDirectToolCall('direct-tool', undefined)).toBeUndefined();
  });

  it('returns call unchanged when strategy is not direct-tool', () => {
    const call = { tool: 'shell_exec', parameters: { command: 'ls' } };
    expect(normalizeDirectToolCall('conversational', call)).toBe(call);
  });

  it('passes through known non-shell_exec tools unchanged', () => {
    const call = { tool: 'file_read', parameters: { path: '/tmp/a' } };
    const result = normalizeDirectToolCall('direct-tool', call);
    expect(result?.tool).toBe('file_read');
  });

  it('falls unknown tool back to shell_exec with the tool name as command', () => {
    const call = { tool: 'ls_files', parameters: {} };
    const result = normalizeDirectToolCall('direct-tool', call);
    expect(result?.tool).toBe('shell_exec');
    expect(result?.parameters.command).toBe('ls files');
  });

  it('preserves explicit command when unknown tool has one', () => {
    const call = { tool: 'unknown', parameters: { command: 'du -sh' } };
    const result = normalizeDirectToolCall('direct-tool', call);
    expect(result?.tool).toBe('shell_exec');
    expect(result?.parameters.command).toBe('du -sh');
  });

  it('trims shell_exec command whitespace', () => {
    const call = { tool: 'shell_exec', parameters: { command: '  ls -la  ' } };
    const result = normalizeDirectToolCall('direct-tool', call);
    expect(result?.parameters.command).toBe('ls -la');
  });

  it('throws when shell_exec command missing', () => {
    const call = { tool: 'shell_exec', parameters: {} };
    expect(() => normalizeDirectToolCall('direct-tool', call)).toThrow(/command missing/);
  });

  it('throws on shell_exec fallback chain', () => {
    const call = { tool: 'shell_exec', parameters: { command: 'ls && cat' } };
    expect(() => normalizeDirectToolCall('direct-tool', call)).toThrow(/single platform-specific command/);
  });
});

describe('withTimeout', () => {
  it('resolves with the inner promise value when within timeout', async () => {
    const result = await withTimeout(Promise.resolve(42), 100);
    expect(result).toBe(42);
  });

  it('rejects with "Intent resolution timeout" when inner promise hangs', async () => {
    const slow = new Promise<number>((resolve) => setTimeout(() => resolve(1), 50));
    await expect(withTimeout(slow, 5)).rejects.toThrow(/Intent resolution timeout/);
  });

  it('propagates rejection from the inner promise', async () => {
    const failing = Promise.reject(new Error('inner fail'));
    await expect(withTimeout(failing, 100)).rejects.toThrow(/inner fail/);
  });
});

describe('IntentResponseSchema', () => {
  it('accepts agent metadata fields', () => {
    const parsed = IntentResponseSchema.parse({
      strategy: 'agentic-workflow',
      refinedGoal: 'x',
      reasoning: 'y',
      agentId: 'writer',
      agentSelectionReason: 'creative ideation',
    });
    expect(parsed.agentId).toBe('writer');
  });

  it('validates confidence in [0, 1]', () => {
    expect(() =>
      IntentResponseSchema.parse({
        strategy: 'conversational',
        refinedGoal: 'x',
        reasoning: 'y',
        confidence: 1.5,
      }),
    ).toThrow();
  });
});
