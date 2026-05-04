/**
 * Behavior tests for the T3 abstain path in `LLMCriticImpl`.
 *
 * Abstain fires when the model returns schema-valid output but produces no
 * reviewable signal — empty aspects array OR every aspect with empty
 * explanation. Distinct from `failClosedResult` (which fires on parse
 * failure / network error and is rejection-equivalent).
 */
import { describe, expect, test } from 'bun:test';
import { LLMCriticImpl } from '../../../src/orchestrator/critic/llm-critic-impl.ts';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  PerceptualHierarchy,
  TaskInput,
} from '../../../src/orchestrator/types.ts';

function mockProvider(content: string): LLMProvider {
  return {
    id: 'mock-critic',
    tier: 'balanced',
    family: 'anthropic',
    generate: async (_req: LLMRequest): Promise<LLMResponse> => ({
      content,
      thinking: undefined,
      toolCalls: [],
      tokensUsed: { input: 100, output: 50 },
      model: 'mock-claude',
      stopReason: 'end_turn',
    }),
  };
}

const dummyTask: TaskInput = {
  id: 't-1',
  goal: 'do the thing',
  taskType: 'code',
  budget: { maxTokens: 50_000, maxDurationMs: 60_000, maxRetries: 3 },
  source: 'cli',
};

const dummyPerception: PerceptualHierarchy = {
  taskTarget: { file: 'a.ts', description: 'edit' },
  dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
  diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
  verifiedFacts: [],
  runtime: { nodeVersion: 'v22', os: 'linux', availableTools: [] },
};

const proposal = {
  approach: 'direct',
  mutations: [{ file: 'a.ts', content: 'export const x = 1;', explanation: 'init' }],
};

describe('LLMCriticImpl — abstain path (T3)', () => {
  test('empty aspects array → verdict abstain', async () => {
    const provider = mockProvider(JSON.stringify({ approved: true, aspects: [] }));
    const critic = new LLMCriticImpl(provider);
    const result = await critic.review(proposal, dummyTask, dummyPerception);
    expect(result.verdict).toBe('abstain');
  });

  test('aspects with all empty explanations → verdict abstain', async () => {
    const provider = mockProvider(
      JSON.stringify({
        approved: true,
        aspects: [
          { name: 'requirement_coverage', passed: true, explanation: '' },
          { name: 'logic_correctness', passed: true, explanation: '   ' },
          { name: 'side_effects', passed: true, explanation: '' },
        ],
      }),
    );
    const critic = new LLMCriticImpl(provider);
    const result = await critic.review(proposal, dummyTask, dummyPerception);
    expect(result.verdict).toBe('abstain');
  });

  test('aspects with non-empty explanations + approved=true → verdict approved', async () => {
    const provider = mockProvider(
      JSON.stringify({
        approved: true,
        aspects: [
          { name: 'requirement_coverage', passed: true, explanation: 'Goal addressed' },
          { name: 'logic_correctness', passed: true, explanation: 'No off-by-one' },
        ],
      }),
    );
    const critic = new LLMCriticImpl(provider);
    const result = await critic.review(proposal, dummyTask, dummyPerception);
    expect(result.verdict).toBe('approved');
    expect(result.approved).toBe(true);
  });

  test('aspects with non-empty explanations + approved=false → verdict rejected', async () => {
    const provider = mockProvider(
      JSON.stringify({
        approved: false,
        aspects: [{ name: 'logic_correctness', passed: false, explanation: 'Off by one in loop' }],
      }),
    );
    const critic = new LLMCriticImpl(provider);
    const result = await critic.review(proposal, dummyTask, dummyPerception);
    expect(result.verdict).toBe('rejected');
    expect(result.approved).toBe(false);
  });

  test('parse failure → verdict rejected (fail-closed, NOT abstain)', async () => {
    const provider = mockProvider('this is not json');
    const critic = new LLMCriticImpl(provider);
    const result = await critic.review(proposal, dummyTask, dummyPerception);
    expect(result.verdict).toBe('rejected');
    expect(result.approved).toBe(false);
  });
});
