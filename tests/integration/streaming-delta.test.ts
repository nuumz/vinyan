/**
 * Phase 2 Streaming — Mock Provider Delta Emission Test
 *
 * Verifies the streaming contract end-to-end in the simplest useful way:
 * mock provider's `generateStream` emits incremental text chunks whose
 * concatenation equals the final `response.content`.
 *
 * A3 compliance: streaming is observational only. Final LLMResponse is
 * returned by generateStream() the same way as generate(), so downstream
 * verification is unaffected.
 */
import { describe, expect, test } from 'bun:test';
import { createMockProvider } from '../../src/orchestrator/llm/mock-provider.ts';
import type { LLMRequest } from '../../src/orchestrator/types.ts';

function makeReq(): LLMRequest {
  return {
    systemPrompt: 'You are a test.',
    userPrompt: 'hello',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 256,
  };
}

describe('Phase 2 Streaming — mock provider', () => {
  test('generateStream emits deltas whose concatenation equals full content', async () => {
    const full = 'The quick brown fox jumps over the lazy dog. 1234567890.';
    const provider = createMockProvider({ id: 'mock/fast', tier: 'fast', responseContent: full });
    expect(provider.generateStream).toBeDefined();

    const deltas: string[] = [];
    const response = await provider.generateStream!(makeReq(), ({ text }) => {
      deltas.push(text);
    });

    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe(full);
    expect(response.content).toBe(full);
  });

  test('generateStream preserves LLMResponse semantics', async () => {
    const provider = createMockProvider({ id: 'mock/fast', tier: 'fast', responseContent: 'hi' });
    const response = await provider.generateStream!(makeReq(), () => {});
    expect(response.content).toBe('hi');
    expect(typeof response.model).toBe('string');
  });

  test('generateStream respects shouldFail flag (fail-closed)', async () => {
    const provider = createMockProvider({ id: 'mock/fast', tier: 'fast', shouldFail: true });
    let threw = false;
    try {
      await provider.generateStream!(makeReq(), () => {});
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
