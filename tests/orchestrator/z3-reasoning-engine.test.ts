/**
 * Z3ReasoningEngine Tests
 *
 * Tests interface compliance and error handling.
 * Z3 is unlikely to be installed in CI, so we verify graceful degradation.
 */
import { describe, expect, test } from 'bun:test';
import { Z3ReasoningEngine } from '../../src/orchestrator/engines/z3-reasoning-engine.ts';
import type { RERequest, REResponse, ReasoningEngine } from '../../src/orchestrator/types.ts';

function makeRequest(overrides?: Partial<RERequest>): RERequest {
  return {
    systemPrompt: '',
    userPrompt: '(declare-const x Int)\n(assert (> x 0))\n(check-sat)',
    maxTokens: 1000,
    ...overrides,
  };
}

describe('Z3ReasoningEngine — interface compliance', () => {
  test('implements ReasoningEngine interface', () => {
    const engine: ReasoningEngine = new Z3ReasoningEngine();

    expect(engine.id).toBe('z3-solver');
    expect(engine.engineType).toBe('symbolic');
    expect(engine.capabilities).toContain('constraint-solving');
    expect(engine.capabilities).toContain('satisfiability');
    expect(engine.capabilities).toContain('optimization');
    expect(typeof engine.execute).toBe('function');
  });

  test('tier is undefined (non-LLM engine)', () => {
    const engine = new Z3ReasoningEngine();
    expect(engine.tier).toBeUndefined();
  });

  test('maxContextTokens is undefined (non-LLM engine)', () => {
    const engine = new Z3ReasoningEngine();
    expect(engine.maxContextTokens).toBeUndefined();
  });
});

describe('Z3ReasoningEngine — configuration', () => {
  test('defaults: z3 binary from PATH, 30s timeout', () => {
    const engine = new Z3ReasoningEngine();
    // Access private fields via cast
    expect((engine as any).z3Path).toBe('z3');
    expect((engine as any).timeoutMs).toBe(30_000);
  });

  test('custom config overrides defaults', () => {
    const engine = new Z3ReasoningEngine({
      z3Path: '/usr/local/bin/z3',
      timeoutMs: 10_000,
    });
    expect((engine as any).z3Path).toBe('/usr/local/bin/z3');
    expect((engine as any).timeoutMs).toBe(10_000);
  });
});

describe('Z3ReasoningEngine — execute() error handling', () => {
  test('returns graceful error when z3 binary is not found', async () => {
    const engine = new Z3ReasoningEngine({
      z3Path: '/nonexistent/z3-binary-that-does-not-exist',
      timeoutMs: 5_000,
    });

    const response = await engine.execute(makeRequest());

    // Should not throw — returns error content instead
    expect(response.engineId).toBe('z3-solver');
    expect(response.content).toContain('Z3 unavailable');
    expect(response.content).toContain('/nonexistent/z3-binary-that-does-not-exist');
    expect(response.toolCalls).toEqual([]);
    expect(response.terminationReason).toBe('completed');
    expect(response.tokensUsed.input).toBeGreaterThan(0);
    expect(response.tokensUsed.output).toBe(0);
  });

  test('providerMeta contains error information on failure', async () => {
    const engine = new Z3ReasoningEngine({
      z3Path: '/nonexistent/z3-binary',
      timeoutMs: 5_000,
    });

    const response = await engine.execute(makeRequest());

    expect(response.providerMeta).toBeDefined();
    expect(response.providerMeta!.error).toBeDefined();
    expect(typeof response.providerMeta!.durationMs).toBe('number');
  });

  test('tokensUsed.input reflects input length even on error', async () => {
    const input = '(check-sat)';
    const engine = new Z3ReasoningEngine({ z3Path: '/nonexistent/z3' });

    const response = await engine.execute(makeRequest({ userPrompt: input }));

    expect(response.tokensUsed.input).toBe(input.length);
  });
});

describe('Z3ReasoningEngine — response shape', () => {
  test('error response conforms to REResponse', async () => {
    const engine = new Z3ReasoningEngine({ z3Path: '/nonexistent/z3' });
    const response = await engine.execute(makeRequest());

    // Verify all required REResponse fields are present
    expect(typeof response.content).toBe('string');
    expect(Array.isArray(response.toolCalls)).toBe(true);
    expect(typeof response.tokensUsed.input).toBe('number');
    expect(typeof response.tokensUsed.output).toBe('number');
    expect(typeof response.engineId).toBe('string');
    expect(response.terminationReason).toBe('completed');
  });
});
