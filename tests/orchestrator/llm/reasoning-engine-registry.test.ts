/**
 * Tests for ReasoningEngineRegistry and LLMReasoningEngine adapter.
 *
 * Validates:
 * - Registry CRUD: register, get, listEngines
 * - Capability-first selection (primary path for non-LLM REs)
 * - Tier-based selection (backward-compat path)
 * - selectById prefix-match logic
 * - fromLLMRegistry() wraps all providers
 * - Non-LLM RE round-trip dispatch through ReasoningEngineRegistry
 *
 * Design ref: docs/architecture/decisions.md §D19
 */
import { describe, expect, test } from 'bun:test';
import {
  LLMReasoningEngine,
  ReasoningEngineRegistry,
} from '../../../src/orchestrator/llm/llm-reasoning-engine.ts';
import {
  createMockProvider,
  createMockReasoningEngine,
  createScriptedMockReasoningEngine,
} from '../../../src/orchestrator/llm/mock-provider.ts';
import { LLMProviderRegistry } from '../../../src/orchestrator/llm/provider-registry.ts';
import type { RERequest, ReasoningEngine } from '../../../src/orchestrator/types.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRERequest(overrides: Partial<RERequest> = {}): RERequest {
  return {
    systemPrompt: 'You are a test assistant.',
    userPrompt: 'Do a thing.',
    maxTokens: 100,
    ...overrides,
  };
}

/** A minimal non-LLM RE that returns a fixed response — simulates a future symbolic solver. */
function makeSymbolicRE(id: string, capabilities: string[] = ['reasoning']): ReasoningEngine {
  return {
    id,
    engineType: 'symbolic',
    capabilities,
    tier: 'fast',
    async execute(_req) {
      return {
        content: `symbolic:${id}`,
        toolCalls: [],
        tokensUsed: { input: 0, output: 0 },
        engineId: id,
        terminationReason: 'completed',
      };
    },
  };
}

// ── ReasoningEngineRegistry: CRUD ────────────────────────────────────────────

describe('ReasoningEngineRegistry: register / get / listEngines', () => {
  test('registers and retrieves engine by id', () => {
    const reg = new ReasoningEngineRegistry();
    const engine = createMockReasoningEngine({ id: 'mock/fast', tier: 'fast' });
    reg.register(engine);
    expect(reg.get('mock/fast')).toBe(engine);
  });

  test('listEngines returns all registered engines', () => {
    const reg = new ReasoningEngineRegistry();
    reg.register(createMockReasoningEngine({ id: 'e1', tier: 'fast' }));
    reg.register(createMockReasoningEngine({ id: 'e2', tier: 'balanced' }));
    reg.register(makeSymbolicRE('sym/solver'));
    expect(reg.listEngines()).toHaveLength(3);
  });

  test('get returns undefined for unknown id', () => {
    const reg = new ReasoningEngineRegistry();
    expect(reg.get('does-not-exist')).toBeUndefined();
  });
});

// ── selectByTier ─────────────────────────────────────────────────────────────

describe('ReasoningEngineRegistry: selectByTier', () => {
  test('selects engine with matching tier', () => {
    const reg = new ReasoningEngineRegistry();
    reg.register(createMockReasoningEngine({ id: 'fast', tier: 'fast' }));
    reg.register(createMockReasoningEngine({ id: 'powerful', tier: 'powerful' }));
    expect(reg.selectByTier('fast')!.id).toBe('fast');
    expect(reg.selectByTier('powerful')!.id).toBe('powerful');
    expect(reg.selectByTier('balanced')).toBeUndefined();
  });
});

// ── selectForRoutingLevel ─────────────────────────────────────────────────────

describe('ReasoningEngineRegistry: selectForRoutingLevel', () => {
  test('L0 returns undefined (no RE needed)', () => {
    const reg = new ReasoningEngineRegistry();
    reg.register(createMockReasoningEngine({ id: 'fast', tier: 'fast' }));
    expect(reg.selectForRoutingLevel(0)).toBeUndefined();
  });

  test('L1→fast, L2→balanced, L3→powerful', () => {
    const reg = new ReasoningEngineRegistry();
    reg.register(createMockReasoningEngine({ id: 'fast', tier: 'fast' }));
    reg.register(createMockReasoningEngine({ id: 'balanced', tier: 'balanced' }));
    reg.register(createMockReasoningEngine({ id: 'powerful', tier: 'powerful' }));
    expect(reg.selectForRoutingLevel(1)!.id).toBe('fast');
    expect(reg.selectForRoutingLevel(2)!.id).toBe('balanced');
    expect(reg.selectForRoutingLevel(3)!.id).toBe('powerful');
  });
});

// ── selectByCapability ────────────────────────────────────────────────────────

describe('ReasoningEngineRegistry: selectByCapability', () => {
  test('returns engine that has all required capabilities', () => {
    const reg = new ReasoningEngineRegistry();
    reg.register(createMockReasoningEngine({ id: 'llm/general', tier: 'fast', capabilities: ['code-generation', 'reasoning'] }));
    reg.register(makeSymbolicRE('sym/math', ['reasoning', 'symbolic-math']));

    const result = reg.selectByCapability(['symbolic-math']);
    expect(result!.id).toBe('sym/math');
  });

  test('returns undefined when no engine has required capability', () => {
    const reg = new ReasoningEngineRegistry();
    reg.register(createMockReasoningEngine({ id: 'llm/general', tier: 'fast' }));
    expect(reg.selectByCapability(['time-travel'])).toBeUndefined();
  });

  test('prefers matching tier when preferredTier is provided', () => {
    const reg = new ReasoningEngineRegistry();
    reg.register(createMockReasoningEngine({ id: 'fast-general', tier: 'fast', capabilities: ['reasoning'] }));
    reg.register(createMockReasoningEngine({ id: 'powerful-general', tier: 'powerful', capabilities: ['reasoning'] }));

    const preferred = reg.selectByCapability(['reasoning'], 'powerful');
    expect(preferred!.id).toBe('powerful-general');
  });

  test('falls back to first capable engine if preferred tier not found', () => {
    const reg = new ReasoningEngineRegistry();
    reg.register(createMockReasoningEngine({ id: 'fast-only', tier: 'fast', capabilities: ['code-generation'] }));

    const result = reg.selectByCapability(['code-generation'], 'balanced'); // balanced not registered
    expect(result!.id).toBe('fast-only');
  });

  test('requires ALL listed capabilities (conjunction, not disjunction)', () => {
    const reg = new ReasoningEngineRegistry();
    reg.register(createMockReasoningEngine({ id: 'code-only', tier: 'fast', capabilities: ['code-generation'] }));
    reg.register(createMockReasoningEngine({ id: 'both', tier: 'fast', capabilities: ['code-generation', 'reasoning'] }));

    expect(reg.selectByCapability(['code-generation', 'reasoning'])!.id).toBe('both');
    expect(reg.selectByCapability(['code-generation', 'time-travel'])).toBeUndefined();
  });
});

// ── selectById ────────────────────────────────────────────────────────────────

describe('ReasoningEngineRegistry: selectById', () => {
  test('exact match', () => {
    const reg = new ReasoningEngineRegistry();
    reg.register(createMockReasoningEngine({ id: 'anthropic/claude-3' }));
    expect(reg.selectById('anthropic/claude-3')!.id).toBe('anthropic/claude-3');
  });

  test('strips "worker-" prefix before lookup', () => {
    const reg = new ReasoningEngineRegistry();
    reg.register(createMockReasoningEngine({ id: 'mock/fast' }));
    expect(reg.selectById('worker-mock/fast')!.id).toBe('mock/fast');
  });

  test('prefix-match: engine.id starts with stripped id', () => {
    const reg = new ReasoningEngineRegistry();
    reg.register(createMockReasoningEngine({ id: 'claude-3-sonnet-20240229' }));
    // Worker registered with just "claude-3", should match the longer engine id
    expect(reg.selectById('worker-claude-3-sonnet-20240229')).toBeDefined();
  });

  test('returns undefined for no match', () => {
    const reg = new ReasoningEngineRegistry();
    expect(reg.selectById('no-such-engine')).toBeUndefined();
  });
});

// ── fromLLMRegistry ───────────────────────────────────────────────────────────

describe('ReasoningEngineRegistry.fromLLMRegistry', () => {
  test('wraps all LLM providers as LLMReasoningEngine adapters', () => {
    const llmReg = new LLMProviderRegistry();
    llmReg.register(createMockProvider({ id: 'mock/fast', tier: 'fast' }));
    llmReg.register(createMockProvider({ id: 'mock/powerful', tier: 'powerful' }));

    const reg = ReasoningEngineRegistry.fromLLMRegistry(llmReg);
    const engines = reg.listEngines();

    expect(engines).toHaveLength(2);
    expect(engines.every((e) => e.engineType === 'llm')).toBe(true);
    expect(reg.get('mock/fast')).toBeInstanceOf(LLMReasoningEngine);
  });

  test('adapted engines preserve tier', () => {
    const llmReg = new LLMProviderRegistry();
    llmReg.register(createMockProvider({ id: 'fast', tier: 'fast' }));
    llmReg.register(createMockProvider({ id: 'balanced', tier: 'balanced' }));

    const reg = ReasoningEngineRegistry.fromLLMRegistry(llmReg);
    expect(reg.selectForRoutingLevel(1)!.tier).toBe('fast');
    expect(reg.selectForRoutingLevel(2)!.tier).toBe('balanced');
  });
});

// ── LLMReasoningEngine adapter ────────────────────────────────────────────────

describe('LLMReasoningEngine adapter', () => {
  test('execute() returns REResponse with correct terminationReason', async () => {
    const engine = createMockReasoningEngine({ id: 'test', stopReason: 'end_turn' });
    const res = await engine.execute(makeRERequest());
    expect(res.terminationReason).toBe('completed');
    expect(res.engineId).toBe('test');
  });

  test('stopReason "tool_use" maps to terminationReason "tool_use"', async () => {
    const engine = createMockReasoningEngine({ id: 'test', stopReason: 'tool_use', responseToolCalls: [{ id: 't1', tool: 'read_file', parameters: {} }] });
    const res = await engine.execute(makeRERequest());
    expect(res.terminationReason).toBe('tool_use');
  });

  test('stopReason "max_tokens" maps to terminationReason "limit_reached"', async () => {
    const engine = createMockReasoningEngine({ id: 'test', stopReason: 'max_tokens' });
    const res = await engine.execute(makeRERequest());
    expect(res.terminationReason).toBe('limit_reached');
  });

  test('uses capabilitiesOverride over provider defaults', () => {
    const provider = createMockProvider({ id: 'llm' });
    const engine = new LLMReasoningEngine(provider, ['custom-cap']);
    expect(engine.capabilities).toEqual(['custom-cap']);
  });

  test('falls back to DEFAULT_LLM_CAPABILITIES when no override or provider capabilities', () => {
    const provider = createMockProvider({ id: 'bare' });
    const engine = new LLMReasoningEngine(provider);
    expect(engine.capabilities).toContain('code-generation');
    expect(engine.capabilities).toContain('reasoning');
  });

  test('passes thinking option through providerOptions', async () => {
    const scripted = createScriptedMockReasoningEngine([
      { content: 'result', stopReason: 'end_turn', thinking: 'I reasoned...' },
    ]);
    const res = await scripted.execute(makeRERequest({ providerOptions: { thinking: { type: 'enabled', budgetTokens: 500 } } }));
    expect(res.thinking).toBe('I reasoned...');
  });
});

// ── Non-LLM RE dispatch (RE-agnostic path) ────────────────────────────────────

describe('Non-LLM RE dispatch through ReasoningEngineRegistry', () => {
  test('symbolic RE returns content without calling LLM API', async () => {
    const reg = new ReasoningEngineRegistry();
    const sym = makeSymbolicRE('sym/verifier', ['symbolic-reasoning', 'verification']);
    reg.register(sym);

    const engine = reg.selectByCapability(['verification']);
    expect(engine).toBeDefined();
    expect(engine!.engineType).toBe('symbolic');

    const result = await engine!.execute(makeRERequest());
    expect(result.content).toBe('symbolic:sym/verifier');
    expect(result.engineId).toBe('sym/verifier');
    expect(result.terminationReason).toBe('completed');
  });

  test('registry selects non-LLM RE over LLM when it uniquely has required capability', async () => {
    const reg = new ReasoningEngineRegistry();
    reg.register(createMockReasoningEngine({ id: 'llm/general', tier: 'fast', capabilities: ['code-generation', 'reasoning'] }));
    reg.register(makeSymbolicRE('sym/oracle', ['oracle-verification']));

    const engine = reg.selectByCapability(['oracle-verification']);
    expect(engine!.id).toBe('sym/oracle');
    expect(engine!.engineType).toBe('symbolic');
  });

  test('mixed registry: LLM fallback when non-LLM lacks required cap', () => {
    const reg = new ReasoningEngineRegistry();
    reg.register(createMockReasoningEngine({ id: 'llm/full', tier: 'fast', capabilities: ['code-generation', 'reasoning', 'tool-use'] }));
    reg.register(makeSymbolicRE('sym/narrow', ['symbolic-math']));

    const engine = reg.selectByCapability(['code-generation']);
    expect(engine!.id).toBe('llm/full');
  });
});
