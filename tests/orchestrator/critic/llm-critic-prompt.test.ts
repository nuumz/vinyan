import { describe, expect, test } from 'bun:test';
import type { CriticContext } from '../../../src/orchestrator/critic/critic-engine.ts';
import { LLMCriticImpl } from '../../../src/orchestrator/critic/llm-critic-impl.ts';
import type { LLMProvider, LLMRequest, PerceptualHierarchy, TaskInput } from '../../../src/orchestrator/types.ts';

// ---------------------------------------------------------------------------
// Capture provider — records the LLMRequest passed to .generate()
// ---------------------------------------------------------------------------

function captureProvider(): { provider: LLMProvider; lastRequest: { value?: LLMRequest } } {
  const lastRequest: { value?: LLMRequest } = {};
  const provider: LLMProvider = {
    id: 'capture',
    tier: 'fast',
    generate: async (req: LLMRequest) => {
      lastRequest.value = req;
      return {
        content: JSON.stringify({
          approved: true,
          aspects: [{ name: 'requirement_coverage', passed: true, explanation: 'ok' }],
          reason: 'ok',
        }),
        tokensUsed: { input: 10, output: 10 },
        toolCalls: [],
        model: 'capture',
        stopReason: 'end_turn' as const,
      };
    },
  };
  return { provider, lastRequest };
}

const minimalTask: TaskInput = {
  id: 't1',
  source: 'cli',
  goal: 'add greet',
  taskType: 'code',
  targetFiles: ['src/hello.ts'],
  budget: { maxTokens: 1_000, maxDurationMs: 5_000, maxRetries: 1 },
};

const minimalPerception: PerceptualHierarchy = {
  taskTarget: { file: 'src/hello.ts', symbol: undefined, description: 'greet fn' },
  dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
  diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
  verifiedFacts: [],
  runtime: { nodeVersion: 'v20', os: 'darwin', availableTools: [] },
};

const minimalProposal = {
  mutations: [{ file: 'src/hello.ts', content: 'export function greet(){}', explanation: 'add' }],
  approach: 'add a function',
};

// ---------------------------------------------------------------------------
// System prompt — anti-sycophancy (always-on)
// ---------------------------------------------------------------------------

describe('critic system prompt', () => {
  test('always includes the anti-sycophancy rule, even without context', async () => {
    const { provider, lastRequest } = captureProvider();
    const critic = new LLMCriticImpl(provider);
    await critic.review(minimalProposal, minimalTask, minimalPerception);
    expect(lastRequest.value?.systemPrompt).toContain('Anti-sycophancy');
    expect(lastRequest.value?.systemPrompt).toContain('do NOT be agreeable');
  });

  test('anti-sycophancy rule references [HISTORICAL EVIDENCE] block', async () => {
    const { provider, lastRequest } = captureProvider();
    const critic = new LLMCriticImpl(provider);
    await critic.review(minimalProposal, minimalTask, minimalPerception);
    expect(lastRequest.value?.systemPrompt).toContain('[HISTORICAL EVIDENCE]');
  });
});

// ---------------------------------------------------------------------------
// User prompt — [HISTORICAL EVIDENCE] section is conditional on context
// ---------------------------------------------------------------------------

describe('critic user prompt — [HISTORICAL EVIDENCE]', () => {
  test('omitted when no context is provided (regression: existing callers unchanged)', async () => {
    const { provider, lastRequest } = captureProvider();
    const critic = new LLMCriticImpl(provider);
    await critic.review(minimalProposal, minimalTask, minimalPerception);
    expect(lastRequest.value?.userPrompt).not.toContain('[HISTORICAL EVIDENCE');
  });

  test('omitted when context has neither priorFailedApproaches nor priorTraceSummary', async () => {
    const { provider, lastRequest } = captureProvider();
    const critic = new LLMCriticImpl(provider);
    const ctx: CriticContext = { riskScore: 0.4, routingLevel: 2 };
    await critic.review(minimalProposal, minimalTask, minimalPerception, [], ctx);
    expect(lastRequest.value?.userPrompt).not.toContain('[HISTORICAL EVIDENCE');
  });

  test('rendered when priorFailedApproaches is populated — lists approaches sorted by occurrences', async () => {
    const { provider, lastRequest } = captureProvider();
    const critic = new LLMCriticImpl(provider);
    const ctx: CriticContext = {
      priorFailedApproaches: [
        { approach: 'foo-bar:baz', failureOracle: 'workflow-deadlock', occurrences: 3, lastSeenAt: 200 },
        { approach: 'qux:flip', failureOracle: 'test-fail', occurrences: 1, lastSeenAt: 100 },
      ],
    };
    await critic.review(minimalProposal, minimalTask, minimalPerception, [], ctx);
    const prompt = lastRequest.value?.userPrompt ?? '';
    expect(prompt).toContain('[HISTORICAL EVIDENCE');
    expect(prompt).toContain('"foo-bar:baz"');
    expect(prompt).toContain('"workflow-deadlock"');
    expect(prompt).toContain('(3 times)');
    expect(prompt).toContain('"qux:flip"');
    expect(prompt).toContain('(1 time)');
    // Highest occurrence comes first
    const fooIdx = prompt.indexOf('"foo-bar:baz"');
    const quxIdx = prompt.indexOf('"qux:flip"');
    expect(fooIdx).toBeGreaterThan(-1);
    expect(quxIdx).toBeGreaterThan(fooIdx);
  });

  test('rendered when only priorTraceSummary is populated — no approaches list, just base rate', async () => {
    const { provider, lastRequest } = captureProvider();
    const critic = new LLMCriticImpl(provider);
    const ctx: CriticContext = {
      priorTraceSummary: { totalAttempts: 12, successCount: 4, failureCount: 8, mostCommonEscalation: 2 },
    };
    await critic.review(minimalProposal, minimalTask, minimalPerception, [], ctx);
    const prompt = lastRequest.value?.userPrompt ?? '';
    expect(prompt).toContain('[HISTORICAL EVIDENCE');
    expect(prompt).toContain('Base rate: 4/12');
    expect(prompt).toContain('8 failed');
    expect(prompt).toContain('modal escalation L2');
  });

  test('caps approaches list at 5 and truncates long approach labels', async () => {
    const { provider, lastRequest } = captureProvider();
    const critic = new LLMCriticImpl(provider);
    const ctx: CriticContext = {
      priorFailedApproaches: Array.from({ length: 8 }, (_, i) => ({
        approach: `approach-${i}-${'x'.repeat(200)}`,
        failureOracle: 'lint',
        occurrences: 8 - i,
        lastSeenAt: 1000 - i,
      })),
    };
    await critic.review(minimalProposal, minimalTask, minimalPerception, [], ctx);
    const prompt = lastRequest.value?.userPrompt ?? '';
    // Top 5 (highest occurrences) included; 6th and 7th and 8th dropped
    expect(prompt).toContain('approach-0-');
    expect(prompt).toContain('approach-4-');
    expect(prompt).not.toContain('approach-5-');
    // Long labels truncated with ellipsis
    expect(prompt).toContain('…');
  });

  test('renders alongside [PRIOR ITERATION RESULT] when both contexts are present', async () => {
    const { provider, lastRequest } = captureProvider();
    const critic = new LLMCriticImpl(provider);
    const ctx: CriticContext = {
      priorAccountabilityGrade: 'C',
      priorBlockerCategories: ['logic_correctness'],
      priorFailedApproaches: [{ approach: 'foo', failureOracle: 'lint', occurrences: 1, lastSeenAt: 100 }],
    };
    await critic.review(minimalProposal, minimalTask, minimalPerception, [], ctx);
    const prompt = lastRequest.value?.userPrompt ?? '';
    expect(prompt).toContain('[PRIOR ITERATION RESULT]');
    expect(prompt).toContain('[HISTORICAL EVIDENCE');
    // Order: prior iteration appears before historical evidence (chronologically tighter signal first)
    const priorIdx = prompt.indexOf('[PRIOR ITERATION RESULT]');
    const histIdx = prompt.indexOf('[HISTORICAL EVIDENCE');
    expect(priorIdx).toBeLessThan(histIdx);
  });
});
