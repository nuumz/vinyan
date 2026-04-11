import { describe, expect, test } from 'bun:test';
import type { WorkerProposal } from '../../../src/orchestrator/critic/critic-engine.ts';
import { LLMTestGeneratorImpl } from '../../../src/orchestrator/test-gen/llm-test-generator.ts';
import type { TestGenerator, TestGenResult } from '../../../src/orchestrator/test-gen/test-generator.ts';
import type { LLMProvider, LLMRequest, LLMResponse, PerceptualHierarchy } from '../../../src/orchestrator/types.ts';

/** Minimal mock implementation to verify the interface contract */
function createMockTestGenerator(result: Partial<TestGenResult> = {}): TestGenerator {
  return {
    generateAndRun: async () => ({
      generatedTests: [],
      results: [],
      failures: [],
      tokensUsed: { input: 200, output: 100 },
      ...result,
    }),
  };
}

function makeProposal(): WorkerProposal {
  return {
    mutations: [
      {
        file: 'src/foo.ts',
        content: 'export function add(a: number, b: number) { return a + b; }',
        explanation: 'add function',
      },
    ],
    approach: 'implement-function',
  };
}

function makePerception(): PerceptualHierarchy {
  return {
    taskTarget: { file: 'src/foo.ts', description: 'Add function' },
    dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
    diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
    verifiedFacts: [],
    runtime: { nodeVersion: 'v18', os: 'darwin', availableTools: [] },
  };
}

describe('TestGenerator interface contract', () => {
  test('empty result when no tests generated', async () => {
    const gen = createMockTestGenerator();
    const result = await gen.generateAndRun(makeProposal(), makePerception());
    expect(result.generatedTests).toHaveLength(0);
    expect(result.results).toHaveLength(0);
    expect(result.failures).toHaveLength(0);
  });

  test('generated tests have correct structure', async () => {
    const gen = createMockTestGenerator({
      generatedTests: [
        { name: 'add returns sum', code: 'expect(add(1,2)).toBe(3)', targetFunction: 'add', category: 'happy-path' },
        { name: 'add handles zero', code: 'expect(add(0,0)).toBe(0)', targetFunction: 'add', category: 'edge-case' },
      ],
      results: [
        { name: 'add returns sum', passed: true, durationMs: 5 },
        { name: 'add handles zero', passed: true, durationMs: 3 },
      ],
    });
    const result = await gen.generateAndRun(makeProposal(), makePerception());
    expect(result.generatedTests).toHaveLength(2);
    expect(result.generatedTests[0]!.category).toBe('happy-path');
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.passed)).toBe(true);
  });

  test('failures include evidence for A4 compliance', async () => {
    const gen = createMockTestGenerator({
      failures: [
        {
          name: 'add handles negative',
          error: 'Expected -1 but got 1',
          evidence: {
            file: 'src/foo.ts',
            line: 1,
            snippet: 'return a + b',
            contentHash: 'abc123',
          },
        },
      ],
    });
    const result = await gen.generateAndRun(makeProposal(), makePerception());
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.evidence).toBeDefined();
    expect(result.failures[0]!.evidence.contentHash).toBe('abc123');
  });

  test('tokens are tracked', async () => {
    const gen = createMockTestGenerator();
    const result = await gen.generateAndRun(makeProposal(), makePerception());
    expect(result.tokensUsed.input).toBe(200);
    expect(result.tokensUsed.output).toBe(100);
  });

  test('all test categories are valid', async () => {
    const categories = ['happy-path', 'edge-case', 'regression', 'acceptance'] as const;
    const gen = createMockTestGenerator({
      generatedTests: categories.map((cat) => ({
        name: `test-${cat}`,
        code: 'expect(true).toBe(true)',
        targetFunction: 'fn',
        category: cat,
      })),
    });
    const result = await gen.generateAndRun(makeProposal(), makePerception());
    expect(result.generatedTests).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// LLMTestGeneratorImpl tests
// ---------------------------------------------------------------------------

function createTestProvider(responseContent: string, shouldFail = false): LLMProvider {
  return {
    id: 'mock/test-gen',
    tier: 'balanced',
    generate: async (_request: LLMRequest): Promise<LLMResponse> => {
      if (shouldFail) throw new Error('provider unavailable');
      return {
        content: responseContent,
        toolCalls: [],
        tokensUsed: { input: 150, output: 200 },
        model: 'mock',
        stopReason: 'end_turn',
      };
    },
  };
}

describe('LLMTestGeneratorImpl', () => {
  test('returns empty result when LLM provider fails', async () => {
    const gen = new LLMTestGeneratorImpl(createTestProvider('', true));
    const result = await gen.generateAndRun(makeProposal(), makePerception());
    expect(result.generatedTests).toHaveLength(0);
    expect(result.failures).toHaveLength(0);
    expect(result.tokensUsed.input).toBe(0);
  });

  test('returns empty result when LLM returns unparseable response', async () => {
    const gen = new LLMTestGeneratorImpl(createTestProvider('not json at all'));
    const result = await gen.generateAndRun(makeProposal(), makePerception());
    expect(result.generatedTests).toHaveLength(0);
    expect(result.tokensUsed.input).toBe(150);
  });

  test('parses valid test generation response', async () => {
    const response = JSON.stringify([
      {
        name: 'add returns sum',
        code: 'expect(1 + 2).toBe(3)',
        targetFunction: 'add',
        category: 'happy-path',
      },
    ]);
    const gen = new LLMTestGeneratorImpl(createTestProvider(response));
    const result = await gen.generateAndRun(makeProposal(), makePerception());
    expect(result.generatedTests).toHaveLength(1);
    expect(result.generatedTests[0]!.name).toBe('add returns sum');
    expect(result.generatedTests[0]!.category).toBe('happy-path');
  });

  test('filters tests with invalid categories', async () => {
    const response = JSON.stringify([
      { name: 'valid', code: 'expect(true).toBe(true)', targetFunction: 'fn', category: 'happy-path' },
      { name: 'invalid', code: 'expect(true).toBe(true)', targetFunction: 'fn', category: 'unknown-category' },
    ]);
    const gen = new LLMTestGeneratorImpl(createTestProvider(response));
    const result = await gen.generateAndRun(makeProposal(), makePerception());
    expect(result.generatedTests).toHaveLength(1);
    expect(result.generatedTests[0]!.name).toBe('valid');
  });

  test('handles markdown-fenced JSON response', async () => {
    const response =
      '```json\n[{"name":"test1","code":"expect(1).toBe(1)","targetFunction":"fn","category":"edge-case"}]\n```';
    const gen = new LLMTestGeneratorImpl(createTestProvider(response));
    const result = await gen.generateAndRun(makeProposal(), makePerception());
    expect(result.generatedTests).toHaveLength(1);
  });
});
