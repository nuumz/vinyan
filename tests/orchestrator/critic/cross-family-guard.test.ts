/**
 * Behavior tests for the T3 cross-family guard.
 *
 * Pin the inference + check function contracts so a regression where the
 * factory or provider implementations stop declaring `family` does not
 * silently revert A1 enforcement.
 */
import { describe, expect, test } from 'bun:test';
import { checkCrossFamily, inferProviderFamily } from '../../../src/orchestrator/critic/cross-family-guard.ts';
import type { LLMProvider } from '../../../src/orchestrator/types.ts';

function mkProvider(overrides: Partial<LLMProvider> & { id: string }): LLMProvider {
  return {
    id: overrides.id,
    tier: overrides.tier ?? 'balanced',
    family: overrides.family,
    generate: async () => {
      throw new Error('not used in these tests');
    },
  };
}

describe('inferProviderFamily', () => {
  test('explicit family overrides id-based inference', () => {
    const provider = mkProvider({ id: 'claude-haiku', family: 'openai-compat' });
    expect(inferProviderFamily(provider)).toBe('openai-compat');
  });

  test('id starting with "anthropic" infers anthropic', () => {
    expect(inferProviderFamily(mkProvider({ id: 'anthropic/claude-sonnet-4-6' }))).toBe('anthropic');
  });

  test('id containing "claude" infers anthropic even without prefix', () => {
    expect(inferProviderFamily(mkProvider({ id: 'openrouter/anthropic/claude-haiku' }))).toBe('anthropic');
    expect(inferProviderFamily(mkProvider({ id: 'claude-opus' }))).toBe('anthropic');
  });

  test('non-anthropic ids fall back to openai-compat', () => {
    expect(inferProviderFamily(mkProvider({ id: 'openrouter/google/gemma-3' }))).toBe('openai-compat');
    expect(inferProviderFamily(mkProvider({ id: 'openrouter/meta/llama-4' }))).toBe('openai-compat');
    expect(inferProviderFamily(mkProvider({ id: 'mock/balanced' }))).toBe('openai-compat');
  });
});

describe('checkCrossFamily', () => {
  test('different families → ok outcome', () => {
    const generator = mkProvider({ id: 'openrouter/google/gemma' });
    const critic = mkProvider({ id: 'anthropic/claude-sonnet' });
    const out = checkCrossFamily(generator, critic);
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.generatorFamily).toBe('openai-compat');
      expect(out.criticFamily).toBe('anthropic');
    }
  });

  test('same family → warn outcome with both family + ids in message', () => {
    const generator = mkProvider({ id: 'anthropic/claude-haiku' });
    const critic = mkProvider({ id: 'anthropic/claude-sonnet' });
    const out = checkCrossFamily(generator, critic);
    expect(out.kind).toBe('warn');
    if (out.kind === 'warn') {
      expect(out.generatorFamily).toBe('anthropic');
      expect(out.criticFamily).toBe('anthropic');
      expect(out.message).toContain('anthropic');
      expect(out.message).toContain('claude-sonnet');
      expect(out.message).toContain('claude-haiku');
    }
  });

  test('explicit family declarations beat id-based inference', () => {
    // Both ids pattern-match anthropic, but one provider explicitly
    // declares it's actually openai-compat (e.g., a routing proxy).
    const generator = mkProvider({ id: 'anthropic/claude-A', family: 'openai-compat' });
    const critic = mkProvider({ id: 'anthropic/claude-B' });
    const out = checkCrossFamily(generator, critic);
    expect(out.kind).toBe('ok');
  });
});
