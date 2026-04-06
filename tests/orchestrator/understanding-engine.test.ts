/**
 * Tests for STU Layer 2: UnderstandingEngine, parsing, canonicalization, constraint verification.
 */
import { describe, expect, test } from 'bun:test';
import {
  LAYER2_MIN_BUDGET_TOKENS,
  UnderstandingEngine,
  buildUnderstandingPrompt,
  canonicalizePrimaryAction,
  levenshtein,
  parseSemanticIntent,
  verifyImplicitConstraints,
} from '../../src/orchestrator/understanding-engine.ts';
import { enrichUnderstandingL2 } from '../../src/orchestrator/task-understanding.ts';
import type { LLMProvider, LLMRequest, LLMResponse, SemanticTaskUnderstanding } from '../../src/orchestrator/types.ts';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeMockProvider(response: Partial<LLMResponse> = {}): LLMProvider {
  return {
    id: 'test-provider',
    tier: 'fast',
    generate: async (_req: LLMRequest): Promise<LLMResponse> => ({
      content: response.content ?? '{}',
      toolCalls: response.toolCalls ?? [],
      tokensUsed: response.tokensUsed ?? { input: 100, output: 50 },
      model: response.model ?? 'test-model',
      stopReason: response.stopReason ?? 'end_turn',
    }),
  };
}

function makeUnderstanding(overrides: Partial<SemanticTaskUnderstanding> = {}): SemanticTaskUnderstanding {
  return {
    rawGoal: 'fix the auth service bug',
    actionVerb: 'fix',
    actionCategory: 'mutation',
    frameworkContext: [],
    constraints: [],
    acceptanceCriteria: [],
    expectsMutation: true,
    resolvedEntities: [],
    understandingDepth: 1,
    verifiedClaims: [],
    understandingFingerprint: 'abc123',
    ...overrides,
  };
}

const VALID_INTENT_JSON = JSON.stringify({
  primaryAction: 'bug-fix',
  secondaryActions: ['add-test'],
  scope: 'Authentication service timeout handling',
  implicitConstraints: [
    { text: 'preserve existing auth flow', polarity: 'must' },
    { text: 'break session management', polarity: 'must-not' },
  ],
  ambiguities: [
    { aspect: 'timeout strategy', interpretations: ['exponential backoff', 'fixed retry'], confidence: 0.7 },
  ],
});

// ── levenshtein ─────────────────────────────────────────────────────────

describe('levenshtein', () => {
  test('identical strings → 0', () => {
    expect(levenshtein('hello', 'hello')).toBe(0);
  });

  test('empty strings', () => {
    expect(levenshtein('', '')).toBe(0);
    expect(levenshtein('abc', '')).toBe(3);
    expect(levenshtein('', 'xyz')).toBe(3);
  });

  test('single character diff → 1', () => {
    expect(levenshtein('cat', 'bat')).toBe(1);
  });

  test('known pairs', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('bug-fix', 'bugg-fix')).toBe(1);
  });
});

// ── canonicalizePrimaryAction ──────────────────────────────────────────

describe('canonicalizePrimaryAction', () => {
  test('exact match from vocab', () => {
    expect(canonicalizePrimaryAction('bug-fix')).toBe('bug-fix');
    expect(canonicalizePrimaryAction('refactor')).toBe('refactor');
    expect(canonicalizePrimaryAction('other')).toBe('other');
  });

  test('normalization: spaces → hyphens', () => {
    expect(canonicalizePrimaryAction('performance optimization')).toBe('performance-optimization');
    expect(canonicalizePrimaryAction('bug fix')).toBe('bug-fix');
  });

  test('normalization: underscores → hyphens', () => {
    expect(canonicalizePrimaryAction('bug_fix')).toBe('bug-fix');
    expect(canonicalizePrimaryAction('api_migration')).toBe('api-migration');
  });

  test('normalization: uppercase → lowercase', () => {
    expect(canonicalizePrimaryAction('Bug-Fix')).toBe('bug-fix');
    expect(canonicalizePrimaryAction('REFACTOR')).toBe('refactor');
  });

  test('fuzzy match: Levenshtein ≤ 3', () => {
    expect(canonicalizePrimaryAction('bugg-fix')).toBe('bug-fix');
    expect(canonicalizePrimaryAction('refacto')).toBe('refactor');
  });

  test('no match → "other"', () => {
    expect(canonicalizePrimaryAction('xyz-completely-unknown')).toBe('other');
    expect(canonicalizePrimaryAction('something-random')).toBe('other');
  });
});

// ── parseSemanticIntent ─────────────────────────────────────────────────

describe('parseSemanticIntent', () => {
  test('valid JSON → returns SemanticIntent with hardcoded A3 fields', () => {
    const result = parseSemanticIntent(VALID_INTENT_JSON);
    expect(result).not.toBeNull();
    expect(result!.primaryAction).toBe('bug-fix');
    expect(result!.scope).toBe('Authentication service timeout handling');
    expect(result!.secondaryActions).toEqual(['add-test']);
    expect(result!.implicitConstraints).toHaveLength(2);
    expect(result!.implicitConstraints[0]!.polarity).toBe('must');
    expect(result!.implicitConstraints[1]!.polarity).toBe('must-not');
    expect(result!.ambiguities).toHaveLength(1);
    // A3 enforcement: hardcoded post-parse
    expect(result!.confidenceSource).toBe('llm-self-report');
    expect(result!.tierReliability).toBe(0.4);
  });

  test('JSON wrapped in markdown fences → strips and parses', () => {
    const wrapped = '```json\n' + VALID_INTENT_JSON + '\n```';
    const result = parseSemanticIntent(wrapped);
    expect(result).not.toBeNull();
    expect(result!.primaryAction).toBe('bug-fix');
  });

  test('truncated/invalid JSON → returns null', () => {
    expect(parseSemanticIntent('{"primaryAction": "bug-fix"')).toBeNull();
    expect(parseSemanticIntent('not json at all')).toBeNull();
    expect(parseSemanticIntent('')).toBeNull();
  });

  test('missing required fields → returns null', () => {
    expect(parseSemanticIntent('{"scope": "something"}')).toBeNull(); // no primaryAction
    expect(parseSemanticIntent('{"primaryAction": "bug-fix"}')).toBeNull(); // no scope
  });

  test('extra fields ignored, defaults applied for optional arrays', () => {
    const minimal = JSON.stringify({
      primaryAction: 'refactor',
      scope: 'payment module',
      extraField: 'ignored',
    });
    const result = parseSemanticIntent(minimal);
    expect(result).not.toBeNull();
    expect(result!.secondaryActions).toEqual([]);
    expect(result!.implicitConstraints).toEqual([]);
    expect(result!.ambiguities).toEqual([]);
  });

  test('canonicalizes primaryAction during parse', () => {
    const json = JSON.stringify({ primaryAction: 'performance optimization', scope: 'api layer' });
    const result = parseSemanticIntent(json);
    expect(result).not.toBeNull();
    expect(result!.primaryAction).toBe('performance-optimization');
  });
});

// ── verifyImplicitConstraints ──────────────────────────────────────────

describe('verifyImplicitConstraints', () => {
  // Use the actual project workspace which has a package.json with zod
  const projectWorkspace = import.meta.dir.replace('/tests/orchestrator', '');

  test('constraint "use zod" when zod IS in package.json → kept', () => {
    const constraints = [{ text: 'use zod for validation', polarity: 'must' as const }];
    const { verified, claims } = verifyImplicitConstraints(constraints, projectWorkspace);
    expect(verified).toHaveLength(1);
    expect(claims).toHaveLength(0);
  });

  test('constraint "use redis" when redis NOT in package.json → removed + claim', () => {
    const constraints = [{ text: 'use redis for caching', polarity: 'must' as const }];
    const { verified, claims } = verifyImplicitConstraints(constraints, projectWorkspace);
    expect(verified).toHaveLength(0);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.type).toBe('contradictory');
    expect(claims[0]!.verifiedBy).toBe('package.json');
  });

  test('non-"use X" constraints → kept unchanged', () => {
    const constraints = [
      { text: 'preserve backwards compatibility', polarity: 'must' as const },
      { text: 'break existing API', polarity: 'must-not' as const },
    ];
    const { verified, claims } = verifyImplicitConstraints(constraints, projectWorkspace);
    expect(verified).toHaveLength(2);
    expect(claims).toHaveLength(0);
  });

  test('empty constraints → no-op', () => {
    const { verified, claims } = verifyImplicitConstraints([], projectWorkspace);
    expect(verified).toHaveLength(0);
    expect(claims).toHaveLength(0);
  });

  test('non-existent workspace (no package.json) → keeps all constraints', () => {
    const constraints = [{ text: 'use nonexistent-lib', polarity: 'must' as const }];
    const { verified, claims } = verifyImplicitConstraints(constraints, '/tmp/no-such-dir');
    expect(verified).toHaveLength(1);
    expect(claims).toHaveLength(0);
  });
});

// ── UnderstandingEngine class ──────────────────────────────────────────

describe('UnderstandingEngine', () => {
  test('shouldSkip() returns false initially', () => {
    const engine = new UnderstandingEngine(makeMockProvider());
    expect(engine.shouldSkip()).toBe(false);
  });

  test('shouldSkip() returns true after 3 failures', () => {
    const engine = new UnderstandingEngine(makeMockProvider());
    engine.recordResult(false);
    engine.recordResult(false);
    engine.recordResult(false);
    expect(engine.shouldSkip()).toBe(true);
  });

  test('circuit resets after success', () => {
    const engine = new UnderstandingEngine(makeMockProvider());
    engine.recordResult(false);
    engine.recordResult(false);
    engine.recordResult(true); // reset
    engine.recordResult(false);
    engine.recordResult(false);
    expect(engine.shouldSkip()).toBe(false); // Only 2 consecutive failures
  });

  test('getCached/setCached round-trip', () => {
    const engine = new UnderstandingEngine(makeMockProvider());
    expect(engine.getCached('fp1')).toBeUndefined();

    const intent = parseSemanticIntent(VALID_INTENT_JSON)!;
    engine.setCached('fp1', intent);
    expect(engine.getCached('fp1')).toEqual(intent);
  });

  test('execute() delegates to provider.generate()', async () => {
    const provider = makeMockProvider({ content: 'test-content' });
    const engine = new UnderstandingEngine(provider);
    const result = await engine.execute({
      systemPrompt: 'sys',
      userPrompt: 'user',
      maxTokens: 500,
    });
    expect(result.content).toBe('test-content');
    expect(result.engineId).toBe('vinyan-understanding-engine');
    expect(result.terminationReason).toBe('completed');
  });

  test('implements ReasoningEngine interface fields', () => {
    const engine = new UnderstandingEngine(makeMockProvider());
    expect(engine.id).toBe('vinyan-understanding-engine');
    expect(engine.engineType).toBe('llm');
    expect(engine.capabilities).toContain('task-understanding');
    expect(engine.tier).toBe('fast');
    expect(engine.maxContextTokens).toBe(4_000);
  });
});

// ── buildUnderstandingPrompt ────────────────────────────────────────────

describe('buildUnderstandingPrompt', () => {
  test('returns system and user prompts', () => {
    const understanding = makeUnderstanding();
    const { systemPrompt, userPrompt } = buildUnderstandingPrompt(understanding);
    expect(systemPrompt).toContain('task understanding engine');
    expect(systemPrompt).toContain('primaryAction');
    expect(userPrompt).toContain('fix the auth service bug');
  });

  test('includes resolved entities in context', () => {
    const understanding = makeUnderstanding({
      resolvedEntities: [{
        reference: 'auth service',
        resolvedPaths: ['src/auth/service.ts'],
        resolution: 'fuzzy-path',
        confidence: 0.8,
        confidenceSource: 'evidence-derived',
      }],
    });
    const { userPrompt } = buildUnderstandingPrompt(understanding);
    expect(userPrompt).toContain('auth service');
    expect(userPrompt).toContain('src/auth/service.ts');
  });

  test('includes historical profile when present', () => {
    const understanding = makeUnderstanding({
      historicalProfile: {
        signature: 'fix::ts::small',
        observationCount: 10,
        failRate: 0.3,
        commonFailureOracles: ['type-oracle', 'test-oracle'],
        avgDurationPerFile: 5000,
        basis: 'hybrid',
        isRecurring: true,
        priorAttemptCount: 5,
      },
    });
    const { userPrompt } = buildUnderstandingPrompt(understanding);
    expect(userPrompt).toContain('observations=10');
    expect(userPrompt).toContain('failRate=30%');
    expect(userPrompt).toContain('recurring=true');
    expect(userPrompt).toContain('type-oracle, test-oracle');
  });
});

// ── enrichUnderstandingL2 ──────────────────────────────────────────────

describe('enrichUnderstandingL2', () => {
  test('budget below threshold → returns unchanged', async () => {
    const understanding = makeUnderstanding();
    const engine = new UnderstandingEngine(makeMockProvider());
    const result = await enrichUnderstandingL2(
      understanding,
      { understandingEngine: engine, workspace: '.' },
      { remainingTokens: LAYER2_MIN_BUDGET_TOKENS - 1 },
    );
    expect(result.understandingDepth).toBe(1);
    expect(result.semanticIntent).toBeUndefined();
  });

  test('understanding already depth 2 → returns unchanged', async () => {
    const understanding = makeUnderstanding({ understandingDepth: 2 });
    const engine = new UnderstandingEngine(makeMockProvider());
    const result = await enrichUnderstandingL2(
      understanding,
      { understandingEngine: engine, workspace: '.' },
      { remainingTokens: 10000 },
    );
    expect(result.understandingDepth).toBe(2);
  });

  test('circuit breaker open → returns unchanged', async () => {
    const engine = new UnderstandingEngine(makeMockProvider());
    engine.recordResult(false);
    engine.recordResult(false);
    engine.recordResult(false);
    const understanding = makeUnderstanding();
    const result = await enrichUnderstandingL2(
      understanding,
      { understandingEngine: engine, workspace: '.' },
      { remainingTokens: 10000 },
    );
    expect(result.understandingDepth).toBe(1);
  });

  test('cached result → returns from cache without LLM call', async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      id: 'test',
      tier: 'fast',
      generate: async () => { callCount++; return { content: VALID_INTENT_JSON, toolCalls: [], tokensUsed: { input: 0, output: 0 }, model: 'test', stopReason: 'end_turn' }; },
    };
    const engine = new UnderstandingEngine(provider);
    const intent = parseSemanticIntent(VALID_INTENT_JSON)!;
    engine.setCached('abc123', intent);

    const understanding = makeUnderstanding();
    const result = await enrichUnderstandingL2(
      understanding,
      { understandingEngine: engine, workspace: '.' },
      { remainingTokens: 10000 },
    );
    expect(result.understandingDepth).toBe(2);
    expect(result.semanticIntent).toBeDefined();
    expect(callCount).toBe(0); // No LLM call
  });

  test('successful LLM response → depth 2 + semanticIntent populated', async () => {
    const provider = makeMockProvider({ content: VALID_INTENT_JSON });
    const engine = new UnderstandingEngine(provider);
    const understanding = makeUnderstanding();
    const result = await enrichUnderstandingL2(
      understanding,
      { understandingEngine: engine, workspace: '.' },
      { remainingTokens: 10000 },
    );
    expect(result.understandingDepth).toBe(2);
    expect(result.semanticIntent).toBeDefined();
    expect(result.semanticIntent!.primaryAction).toBe('bug-fix');
    expect(result.semanticIntent!.confidenceSource).toBe('llm-self-report');
    expect(result.semanticIntent!.tierReliability).toBe(0.4);
  });

  test('parse failure → graceful degradation, depth stays at 1', async () => {
    const provider = makeMockProvider({ content: 'not valid json at all' });
    const engine = new UnderstandingEngine(provider);
    const understanding = makeUnderstanding();
    const result = await enrichUnderstandingL2(
      understanding,
      { understandingEngine: engine, workspace: '.' },
      { remainingTokens: 10000 },
    );
    expect(result.understandingDepth).toBe(1);
    expect(result.semanticIntent).toBeUndefined();
  });

  test('timeout → graceful degradation', async () => {
    const provider: LLMProvider = {
      id: 'slow',
      tier: 'fast',
      generate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return { content: VALID_INTENT_JSON, toolCalls: [], tokensUsed: { input: 0, output: 0 }, model: 'test', stopReason: 'end_turn' };
      },
    };
    const engine = new UnderstandingEngine(provider);
    const understanding = makeUnderstanding();
    const result = await enrichUnderstandingL2(
      understanding,
      { understandingEngine: engine, workspace: '.' },
      { remainingTokens: 10000, timeoutMs: 50 }, // Very short timeout
    );
    expect(result.understandingDepth).toBe(1);
    expect(result.semanticIntent).toBeUndefined();
  });
});
