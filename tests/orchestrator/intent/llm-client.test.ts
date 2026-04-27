/**
 * LLM client tests (plan commit D8).
 *
 * Pure — stubs LLMProvider + LLMProviderRegistry. No real LLM calls.
 */
import { describe, expect, it } from 'bun:test';
import {
  classifyOnce,
  classifyWithFallback,
  INTENT_SYSTEM_PROMPT,
  INTENT_TIMEOUT_MS,
  pickAlternateProvider,
  pickPrimaryProvider,
  TIER_PREFERENCE,
} from '../../../src/orchestrator/intent/llm-client.ts';
import type { LLMProviderRegistry } from '../../../src/orchestrator/llm/provider-registry.ts';
import type { LLMProvider } from '../../../src/orchestrator/types.ts';

function stubProvider(id: string, tier: LLMProvider['tier']): LLMProvider {
  return {
    id,
    tier,
    generate: async () => {
      throw new Error('unmocked');
    },
  } as unknown as LLMProvider;
}

function stubRegistry(providers: Map<LLMProvider['tier'], LLMProvider>): LLMProviderRegistry {
  return {
    selectByTier: (tier: LLMProvider['tier']) => providers.get(tier) ?? null,
  } as unknown as LLMProviderRegistry;
}

describe('TIER_PREFERENCE', () => {
  it('prefers balanced → tool-uses → fast in order', () => {
    expect(TIER_PREFERENCE).toEqual(['balanced', 'tool-uses', 'fast']);
  });
});

describe('INTENT_TIMEOUT_MS', () => {
  it('is 8 seconds', () => {
    expect(INTENT_TIMEOUT_MS).toBe(8000);
  });
});

describe('INTENT_SYSTEM_PROMPT', () => {
  it('defines the four strategies', () => {
    for (const s of ['full-pipeline', 'direct-tool', 'conversational', 'agentic-workflow']) {
      expect(INTENT_SYSTEM_PROMPT).toContain(s);
    }
  });

  it('documents CRITICAL discrimination rules in order', () => {
    const conversational = INTENT_SYSTEM_PROMPT.indexOf('1. CONVERSATIONAL test');
    const directTool = INTENT_SYSTEM_PROMPT.indexOf('2. DIRECT-TOOL test');
    const fullPipeline = INTENT_SYSTEM_PROMPT.indexOf('3. FULL-PIPELINE test');
    const agentic = INTENT_SYSTEM_PROMPT.indexOf('4. AGENTIC-WORKFLOW');
    expect(conversational).toBeGreaterThan(-1);
    expect(directTool).toBeGreaterThan(conversational);
    expect(fullPipeline).toBeGreaterThan(directTool);
    expect(agentic).toBeGreaterThan(fullPipeline);
  });

  it('documents the tool allowlist', () => {
    for (const t of ['shell_exec', 'file_read', 'file_write', 'file_edit']) {
      expect(INTENT_SYSTEM_PROMPT).toContain(t);
    }
  });

  it('includes canonical few-shot examples', () => {
    expect(INTENT_SYSTEM_PROMPT).toContain('Canonical Examples');
    expect(INTENT_SYSTEM_PROMPT).toContain('เว็บตูน'); // keyword-collision guard
    expect(INTENT_SYSTEM_PROMPT).toContain('fix type error');
  });

  it('keeps internal roles out of user-facing workflow prompts', () => {
    expect(INTENT_SYSTEM_PROMPT).toContain('Internal role names are routing hints only');
    expect(INTENT_SYSTEM_PROMPT).toContain('Do NOT write workflow prompts that tell the downstream agent to tell the user');
    expect(INTENT_SYSTEM_PROMPT).toContain('do not expose internal role names as the answer');
  });
});

describe('pickPrimaryProvider', () => {
  it('returns balanced when available', () => {
    const balanced = stubProvider('b', 'balanced');
    const fast = stubProvider('f', 'fast');
    const registry = stubRegistry(new Map([
      ['balanced', balanced],
      ['fast', fast],
    ]));
    expect(pickPrimaryProvider(registry)).toBe(balanced);
  });

  it('falls back to tool-uses when balanced absent', () => {
    const toolUses = stubProvider('t', 'tool-uses');
    const registry = stubRegistry(new Map([['tool-uses', toolUses]]));
    expect(pickPrimaryProvider(registry)).toBe(toolUses);
  });

  it('falls back to fast when balanced + tool-uses absent', () => {
    const fast = stubProvider('f', 'fast');
    const registry = stubRegistry(new Map([['fast', fast]]));
    expect(pickPrimaryProvider(registry)).toBe(fast);
  });

  it('returns null when registry is empty', () => {
    expect(pickPrimaryProvider(stubRegistry(new Map()))).toBeNull();
  });
});

describe('pickAlternateProvider', () => {
  it('returns a provider with a different id from excludeId', () => {
    const balanced = stubProvider('b', 'balanced');
    const fast = stubProvider('f', 'fast');
    const registry = stubRegistry(new Map([
      ['balanced', balanced],
      ['fast', fast],
    ]));
    const alt = pickAlternateProvider(registry, 'b');
    expect(alt).not.toBeNull();
    expect(alt?.id).toBe('f');
  });

  it('returns null when only the excluded provider exists', () => {
    const only = stubProvider('b', 'balanced');
    const registry = stubRegistry(new Map([['balanced', only]]));
    expect(pickAlternateProvider(registry, 'b')).toBeNull();
  });

  it('returns null when registry is empty', () => {
    expect(pickAlternateProvider(stubRegistry(new Map()), 'x')).toBeNull();
  });
});

describe('classifyOnce', () => {
  it('returns the parsed IntentResponse on success', async () => {
    const provider: LLMProvider = {
      id: 'p',
      tier: 'balanced',
      generate: async () => ({
        content: JSON.stringify({
          strategy: 'conversational',
          refinedGoal: 'hi',
          reasoning: 'greeting',
        }),
      }),
    } as unknown as LLMProvider;
    const result = await classifyOnce(provider, 'hello');
    expect(result.strategy).toBe('conversational');
    expect(result.refinedGoal).toBe('hi');
  });

  it('normalizes direct-tool unknown tool name to shell_exec', async () => {
    const provider: LLMProvider = {
      id: 'p',
      tier: 'balanced',
      generate: async () => ({
        content: JSON.stringify({
          strategy: 'direct-tool',
          refinedGoal: 'ls',
          reasoning: 'x',
          directToolCall: { tool: 'list_directory', parameters: { command: 'ls' } },
        }),
      }),
    } as unknown as LLMProvider;
    const result = await classifyOnce(provider, 'list');
    expect(result.directToolCall?.tool).toBe('shell_exec');
  });

  it('throws on timeout', async () => {
    const provider: LLMProvider = {
      id: 'p',
      tier: 'balanced',
      generate: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ content: '{}' }), INTENT_TIMEOUT_MS + 1000),
        ) as any,
    } as unknown as LLMProvider;
    await expect(classifyOnce(provider, 'x')).rejects.toThrow(/timeout/i);
  }, 15_000);
});

describe('classifyWithFallback', () => {
  it('returns primary result on success', async () => {
    const primary: LLMProvider = {
      id: 'primary',
      tier: 'balanced',
      generate: async () => ({
        content: JSON.stringify({
          strategy: 'conversational',
          refinedGoal: 'x',
          reasoning: 'y',
        }),
      }),
    } as unknown as LLMProvider;
    const registry = stubRegistry(new Map());
    const result = await classifyWithFallback(registry, primary, 'hi');
    expect(result.strategy).toBe('conversational');
  });

  it('retries with alternate on primary failure', async () => {
    const primary: LLMProvider = {
      id: 'primary',
      tier: 'balanced',
      generate: async () => {
        throw new Error('primary boom');
      },
    } as unknown as LLMProvider;
    const alternate: LLMProvider = {
      id: 'alternate',
      tier: 'fast',
      generate: async () => ({
        content: JSON.stringify({
          strategy: 'full-pipeline',
          refinedGoal: 'x',
          reasoning: 'y',
        }),
      }),
    } as unknown as LLMProvider;
    const registry = stubRegistry(new Map([['fast', alternate]]));
    const result = await classifyWithFallback(registry, primary, 'fix bug');
    expect(result.strategy).toBe('full-pipeline');
  });

  it('re-throws primary error when no alternate exists', async () => {
    const primary: LLMProvider = {
      id: 'primary',
      tier: 'balanced',
      generate: async () => {
        throw new Error('primary boom');
      },
    } as unknown as LLMProvider;
    const registry = stubRegistry(new Map());
    await expect(classifyWithFallback(registry, primary, 'x')).rejects.toThrow(/primary boom/);
  });

  it('skips the excluded primary from alternate search', async () => {
    const primary: LLMProvider = {
      id: 'p',
      tier: 'balanced',
      generate: async () => {
        throw new Error('fail');
      },
    } as unknown as LLMProvider;
    // Only the primary is registered — alternate picker must exclude it and return null.
    const registry = stubRegistry(new Map([['balanced', primary]]));
    await expect(classifyWithFallback(registry, primary, 'x')).rejects.toThrow(/fail/);
  });
});
