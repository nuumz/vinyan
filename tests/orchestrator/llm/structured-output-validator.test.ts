/**
 * Structured-output validator tests — G4 interior LLM control.
 */
import { describe, expect, test } from 'bun:test';
import {
  appendFeedbackTurn,
  extractToolUseInput,
  runWithStructuredOutput,
} from '../../../src/orchestrator/llm/structured-output-validator.ts';
import type { LLMResponse } from '../../../src/orchestrator/types.ts';

function fakeResponse(content: string, toolCalls: LLMResponse['toolCalls'] = []): LLMResponse {
  return {
    content,
    toolCalls,
    tokensUsed: { input: 0, output: 0 },
    model: 'test',
    stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
  };
}

describe('runWithStructuredOutput', () => {
  test('happy path: parse succeeds on first attempt', async () => {
    let calls = 0;
    const result = await runWithStructuredOutput<{ x: number }>({
      attempt: async () => {
        calls++;
        return fakeResponse('{"x":1}');
      },
      parse: () => ({ ok: true, value: { x: 1 } }),
    });
    expect(result.value).toEqual({ x: 1 });
    expect(result.attempts).toBe(1);
    expect(calls).toBe(1);
  });

  test('retries once on parse failure with feedback fed back', async () => {
    const feedbackSeen: Array<string | null> = [];
    const result = await runWithStructuredOutput<{ x: number }>({
      attempt: async (feedback) => {
        feedbackSeen.push(feedback);
        return fakeResponse('whatever');
      },
      parse: (resp) => {
        if (resp.content === 'whatever' && feedbackSeen.length === 1) {
          return { ok: false, error: 'expected JSON' };
        }
        return { ok: true, value: { x: 42 } };
      },
    });
    expect(result.value).toEqual({ x: 42 });
    expect(result.attempts).toBe(2);
    expect(feedbackSeen[0]).toBeNull();
    expect(feedbackSeen[1]).toContain('expected JSON');
  });

  test('returns null with lastError after exhausting retries', async () => {
    const result = await runWithStructuredOutput<{ x: number }>({
      attempt: async () => fakeResponse('garbage'),
      parse: () => ({ ok: false, error: 'still garbage' }),
      maxAttempts: 2,
    });
    expect(result.value).toBeNull();
    expect(result.attempts).toBe(2);
    expect(result.lastError).toBe('still garbage');
    expect(result.responses).toHaveLength(2);
  });

  test('treats parser exception as parse failure', async () => {
    let parseCalls = 0;
    const result = await runWithStructuredOutput<unknown>({
      attempt: async () => fakeResponse('boom'),
      parse: () => {
        parseCalls++;
        throw new Error('zod blew up');
      },
      maxAttempts: 2,
    });
    expect(result.value).toBeNull();
    expect(result.lastError).toBe('zod blew up');
    expect(parseCalls).toBe(2);
  });

  test('attempt() throwing is recorded but does not crash the validator', async () => {
    let calls = 0;
    const result = await runWithStructuredOutput<unknown>({
      attempt: async () => {
        calls++;
        if (calls === 1) throw new Error('network down');
        return fakeResponse('{"ok":true}');
      },
      parse: () => ({ ok: true, value: 'ok' }),
      maxAttempts: 2,
    });
    expect(result.value).toBe('ok');
    // attempts = iteration count (we did 2 loops; one threw, one succeeded).
    // responses.length = only the successful response is appended.
    expect(result.attempts).toBe(2);
    expect(result.responses).toHaveLength(1);
    expect(calls).toBe(2);
  });

  test('respects custom buildRetryPrompt', async () => {
    const feedbackHistory: Array<string | null> = [];
    let attemptCount = 0;
    const result = await runWithStructuredOutput<unknown>({
      attempt: async (feedback) => {
        attemptCount++;
        feedbackHistory.push(feedback);
        return fakeResponse('x');
      },
      parse: () => (attemptCount === 1 ? { ok: false, error: 'bad' } : { ok: true, value: 'good' }),
      buildRetryPrompt: (err) => `CUSTOM PROMPT: ${err}`,
    });
    expect(result.value).toBe('good');
    expect(feedbackHistory).toHaveLength(2);
    expect(feedbackHistory[1]).toBe('CUSTOM PROMPT: bad');
  });

  test('maxAttempts < 1 is clamped to 1', async () => {
    const result = await runWithStructuredOutput<unknown>({
      attempt: async () => fakeResponse('x'),
      parse: () => ({ ok: false, error: 'no' }),
      maxAttempts: 0,
    });
    expect(result.attempts).toBe(1);
  });
});

describe('extractToolUseInput', () => {
  test('returns the matching tool call parameters', () => {
    const resp = fakeResponse('', [{ id: 't1', tool: 'emit_output', parameters: { value: 42 } }]);
    expect(extractToolUseInput(resp, 'emit_output')).toEqual({ value: 42 });
  });

  test('returns null when no matching tool call', () => {
    const resp = fakeResponse('', [{ id: 't1', tool: 'something_else', parameters: { value: 42 } }]);
    expect(extractToolUseInput(resp, 'emit_output')).toBeNull();
  });
});

describe('appendFeedbackTurn', () => {
  test('passes through the request when feedback is null', () => {
    const req = { systemPrompt: 's', userPrompt: 'u', maxTokens: 100 };
    expect(appendFeedbackTurn(req, null)).toBe(req);
  });

  test('seeds the original userPrompt when messages is empty (no silent prompt loss)', () => {
    // Anthropic + OpenRouter ignore userPrompt when messages is non-empty,
    // so a naive append would drop the original prompt on retry.
    const req = { systemPrompt: 's', userPrompt: 'original goal', maxTokens: 100, messages: [] };
    const result = appendFeedbackTurn(req, 'try again');
    expect(result.messages).toHaveLength(3);
    expect(result.messages?.[0]).toEqual({ role: 'user', content: 'original goal' });
    expect(result.messages?.[1]).toEqual({ role: 'assistant', content: 'Acknowledged.' });
    expect(result.messages?.[2]).toEqual({ role: 'user', content: 'try again' });
  });

  test('also seeds when messages is undefined (typical first call)', () => {
    const req = { systemPrompt: 's', userPrompt: 'goal', maxTokens: 100 };
    const result = appendFeedbackTurn(req, 'feedback');
    expect(result.messages).toHaveLength(3);
    expect(result.messages?.[0]).toEqual({ role: 'user', content: 'goal' });
  });

  test('does not seed when userPrompt is empty (nothing to preserve)', () => {
    const req = { systemPrompt: 's', userPrompt: '', maxTokens: 100 };
    const result = appendFeedbackTurn(req, 'feedback');
    expect(result.messages).toHaveLength(2);
    expect(result.messages?.[0]).toEqual({ role: 'assistant', content: 'Acknowledged.' });
  });

  test('preserves existing messages on append (does NOT re-seed userPrompt)', () => {
    const existing = { role: 'user' as const, content: 'first' };
    const req = { systemPrompt: 's', userPrompt: 'u', maxTokens: 100, messages: [existing] };
    const result = appendFeedbackTurn(req, 'feedback');
    expect(result.messages).toHaveLength(3);
    expect(result.messages?.[0]).toEqual(existing);
    expect(result.messages?.[2]).toEqual({ role: 'user', content: 'feedback' });
  });
});

describe('runWithStructuredOutput — failure-kind disambiguation', () => {
  test('records errors[] entries with kind for each failed attempt', async () => {
    let calls = 0;
    const result = await runWithStructuredOutput<unknown>({
      attempt: async () => {
        calls++;
        if (calls === 1) throw new Error('network');
        return fakeResponse('garbage');
      },
      parse: () => ({ ok: false, error: 'bad shape' }),
      maxAttempts: 3,
    });
    expect(result.value).toBeNull();
    expect(result.errors).toHaveLength(3);
    expect(result.errors[0]).toEqual({ kind: 'transport', message: 'network' });
    expect(result.errors[1]).toEqual({ kind: 'parse', message: 'bad shape' });
    expect(result.errors[2]).toEqual({ kind: 'parse', message: 'bad shape' });
    expect(result.lastError).toBe('bad shape');
    expect(result.lastErrorKind).toBe('parse');
  });

  test('after a transport error, next attempt sends feedback=null (no spurious "malformed" prompt)', async () => {
    const feedbackSeen: Array<string | null> = [];
    let calls = 0;
    await runWithStructuredOutput<unknown>({
      attempt: async (feedback) => {
        feedbackSeen.push(feedback);
        calls++;
        if (calls === 1) throw new Error('connection reset');
        return fakeResponse('{"ok":1}');
      },
      parse: () => ({ ok: true, value: 'ok' }),
      maxAttempts: 3,
    });
    expect(feedbackSeen[0]).toBeNull(); // first call
    expect(feedbackSeen[1]).toBeNull(); // after transport failure — DO NOT lie about a malformed response
  });

  test('after parse error, next attempt sends parse-feedback (correct retry semantics)', async () => {
    const feedbackSeen: Array<string | null> = [];
    let parseCalls = 0;
    await runWithStructuredOutput<unknown>({
      attempt: async (feedback) => {
        feedbackSeen.push(feedback);
        return fakeResponse('garbage');
      },
      parse: () => {
        parseCalls++;
        return parseCalls === 1 ? { ok: false, error: 'expected JSON' } : { ok: true, value: 'good' };
      },
      maxAttempts: 2,
    });
    expect(feedbackSeen[0]).toBeNull();
    expect(feedbackSeen[1]).toContain('expected JSON');
  });

  test('lastErrorKind reflects the most recent failure type', async () => {
    let calls = 0;
    const result = await runWithStructuredOutput<unknown>({
      attempt: async () => {
        calls++;
        if (calls === 1) {
          // First call: parse failure path
          return fakeResponse('garbage');
        }
        // Second call: transport failure
        throw new Error('rate limited');
      },
      parse: () => ({ ok: false, error: 'bad shape' }),
      maxAttempts: 2,
    });
    expect(result.value).toBeNull();
    expect(result.lastErrorKind).toBe('transport');
    expect(result.lastError).toBe('rate limited');
  });
});
