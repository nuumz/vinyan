import { describe, expect, test } from 'bun:test';
import { assemblePrompt } from '../../../src/orchestrator/llm/prompt-assembler.ts';
import type { PerceptualHierarchy, TaskDAG, WorkingMemoryState } from '../../../src/orchestrator/types.ts';

function makePerception(): PerceptualHierarchy {
  return {
    taskTarget: { file: 'src/foo.ts', description: 'Fix bug' },
    dependencyCone: {
      directImporters: ['src/bar.ts'],
      directImportees: ['src/utils.ts'],
      transitiveBlastRadius: 3,
    },
    diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
    verifiedFacts: [],
    runtime: { nodeVersion: 'v18', os: 'darwin', availableTools: ['file_read', 'file_write'] },
  };
}

function makeMemory(overrides?: Partial<WorkingMemoryState>): WorkingMemoryState {
  return {
    failedApproaches: [],
    activeHypotheses: [],
    unresolvedUncertainties: [],
    scopedFacts: [],
    ...overrides,
  };
}

describe('PromptAssembler', () => {
  test('system prompt contains ROLE and OUTPUT FORMAT', () => {
    const { systemPrompt } = assemblePrompt('Fix bug', makePerception(), makeMemory());
    expect(systemPrompt).toContain('[ROLE]');
    expect(systemPrompt).toContain('[OUTPUT FORMAT]');
    expect(systemPrompt).toContain('[ACCOUNTABILITY CONTRACT]');
    expect(systemPrompt).toContain('proposedMutations');
  });

  test('user prompt contains TASK and PERCEPTION', () => {
    const { userPrompt } = assemblePrompt('Fix bug', makePerception(), makeMemory());
    expect(userPrompt).toContain('[TASK]');
    expect(userPrompt).toContain('Fix bug');
    expect(userPrompt).toContain('[PERCEPTION]');
    expect(userPrompt).toContain('src/foo.ts');
  });

  test('§17.5 criterion 2: prompt contains failed approach constraints', () => {
    const memory = makeMemory({
      failedApproaches: [
        { approach: 'inline function', oracleVerdict: 'type error', timestamp: Date.now() },
        { approach: 'extract class', oracleVerdict: 'dep violation', timestamp: Date.now() },
      ],
    });
    const { userPrompt } = assemblePrompt('Fix bug', makePerception(), memory);
    expect(userPrompt).toContain('[FAILED APPROACHES');
    expect(userPrompt).toContain('Do NOT try');
    expect(userPrompt).toContain('inline function');
    expect(userPrompt).toContain('extract class');
  });

  test('includes PLAN section when plan provided', () => {
    const plan: TaskDAG = {
      nodes: [
        {
          id: 'n1',
          description: 'Step 1: fix type',
          targetFiles: ['src/foo.ts'],
          dependencies: [],
          assignedOracles: ['type'],
        },
      ],
    };
    const { userPrompt } = assemblePrompt('Fix bug', makePerception(), makeMemory(), plan);
    expect(userPrompt).toContain('[PLAN]');
    expect(userPrompt).toContain('Step 1: fix type');
  });

  test('system prompt lists available tools', () => {
    const { systemPrompt } = assemblePrompt('Fix bug', makePerception(), makeMemory());
    expect(systemPrompt).toContain('file_read');
    expect(systemPrompt).toContain('file_write');
  });

  test('includes diagnostics when type errors present', () => {
    const perception = makePerception();
    perception.diagnostics.typeErrors = [{ file: 'src/foo.ts', line: 5, message: "Type 'string' is not assignable" }];
    const { userPrompt } = assemblePrompt('Fix bug', perception, makeMemory());
    expect(userPrompt).toContain('[DIAGNOSTICS]');
    expect(userPrompt).toContain('not assignable');
  });

  test('system prompt includes oracle verification capabilities section', () => {
    const { systemPrompt } = assemblePrompt('Fix bug', makePerception(), makeMemory());
    expect(systemPrompt).toContain('[ORACLE VERIFICATION CAPABILITIES]');
    expect(systemPrompt).toContain('Each subtask you propose should be verifiable');
  });

  test('oracle manifest lists all 5 oracle types', () => {
    const { systemPrompt } = assemblePrompt('Fix bug', makePerception(), makeMemory());
    expect(systemPrompt).toContain('ast: Validates symbol existence');
    expect(systemPrompt).toContain('type: Checks TypeScript type correctness');
    expect(systemPrompt).toContain('dep: Analyzes import graph');
    expect(systemPrompt).toContain('lint: Checks code style');
    expect(systemPrompt).toContain('test: Runs test suite');
  });

  test('oracle manifest mentions verificationHint', () => {
    const { systemPrompt } = assemblePrompt('Fix bug', makePerception(), makeMemory());
    expect(systemPrompt).toContain('verificationHint');
    expect(systemPrompt).toContain('skipTestWhen');
  });

  // Cache-boundary markers — anthropic-provider maps `type: 'static' | 'session'`
  // to `cache_control: { type: 'ephemeral' }` on the API call so the prefix is
  // cacheable. Without these flags, every turn writes new cache entries and
  // burns the 90% prefix-cache discount. These regressions lock the invariant
  // (debate doc P0 unanimous).
  describe('cache-boundary markers (A5 + cost discipline)', () => {
    // Post-B5: `systemCacheControl`, `instructionCacheControl`, and the
    // legacy `cacheControl` single-field have been removed. Caching is
    // now driven exclusively by `tiers` offsets (frozen / session / turn)
    // on the AssembledPrompt. The Anthropic provider splits the prompt
    // at those offsets and attaches `cache_control: { type: 'ephemeral' }`
    // at tier boundaries. See tests/orchestrator/llm/anthropic-provider-tiers
    // + volatility-ordering for the post-B5 behaviour.

    test('code task emits tiers with non-zero frozen boundary for cache marker placement', () => {
      const result = assemblePrompt('Fix bug', makePerception(), makeMemory());
      expect(result.tiers).toBeDefined();
      expect(result.tiers.system.frozenEnd).toBeGreaterThan(0);
    });

    test('reasoning task also emits tier offsets', () => {
      const result = assemblePrompt(
        'explain recursion',
        makePerception(),
        makeMemory(),
        undefined,
        'reasoning',
      );
      expect(result.tiers).toBeDefined();
      expect(result.tiers.system.frozenEnd).toBeGreaterThan(0);
    });

    test('estimatedTokens populated for cost instrumentation', () => {
      const { estimatedTokens } = assemblePrompt('Fix bug', makePerception(), makeMemory());
      expect(estimatedTokens).toBeDefined();
      expect(estimatedTokens!.system).toBeGreaterThan(0);
      expect(estimatedTokens!.user).toBeGreaterThan(0);
      expect(estimatedTokens!.total).toBe(estimatedTokens!.system + estimatedTokens!.user);
    });
  });
});
