import { describe, expect, test } from 'bun:test';
import type { CriticEngine, CriticResult, WorkerProposal } from '../../../src/orchestrator/critic/critic-engine.ts';
import { LLMCriticImpl } from '../../../src/orchestrator/critic/llm-critic-impl.ts';
import type { LLMProvider, LLMRequest, PerceptualHierarchy, TaskInput } from '../../../src/orchestrator/types.ts';

/** Minimal mock implementation to verify the interface contract */
function createMockCritic(result: Partial<CriticResult> = {}): CriticEngine {
  return {
    review: async () => ({
      approved: true,
      verdicts: {},
      confidence: 0.8,
      aspects: [],
      tokensUsed: { input: 100, output: 50 },
      ...result,
    }),
  };
}

function makeProposal(): WorkerProposal {
  return {
    mutations: [{ file: 'src/foo.ts', content: 'export const x = 2;', explanation: 'fix' }],
    approach: 'direct-edit',
  };
}

function makeTask(): TaskInput {
  return {
    id: 't-1',
    source: 'cli',
    goal: 'Fix bug',
    taskType: 'code',
    budget: { maxTokens: 50_000, maxDurationMs: 60_000, maxRetries: 3 },
  };
}

function makePerception(): PerceptualHierarchy {
  return {
    taskTarget: { file: 'src/foo.ts', description: 'Fix bug' },
    dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
    diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
    verifiedFacts: [],
    runtime: { nodeVersion: 'v18', os: 'darwin', availableTools: [] },
  };
}

describe('CriticEngine interface contract', () => {
  test('approved review returns approved=true', async () => {
    const critic = createMockCritic({ approved: true });
    const result = await critic.review(makeProposal(), makeTask(), makePerception());
    expect(result.approved).toBe(true);
    expect(result.confidence).toBeGreaterThan(0);
  });

  test('rejected review returns reason', async () => {
    const critic = createMockCritic({
      approved: false,
      reason: 'Logic error in conditional',
      aspects: [{ name: 'logic-correctness', passed: false, explanation: 'Off-by-one' }],
    });
    const result = await critic.review(makeProposal(), makeTask(), makePerception());
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('Logic error in conditional');
    expect(result.aspects).toHaveLength(1);
    expect(result.aspects[0]!.passed).toBe(false);
  });

  test('verdicts are keyed by aspect name', async () => {
    const critic = createMockCritic({
      verdicts: {
        'critic-logic': {
          verified: true,
          type: 'uncertain',
          confidence: 0.85,
          evidence: [],
          fileHashes: {},
          durationMs: 100,
        },
      },
    });
    const result = await critic.review(makeProposal(), makeTask(), makePerception());
    expect(result.verdicts['critic-logic']).toBeDefined();
    expect(result.verdicts['critic-logic']!.type).toBe('uncertain');
  });

  test('tokens are tracked', async () => {
    const critic = createMockCritic();
    const result = await critic.review(makeProposal(), makeTask(), makePerception());
    expect(result.tokensUsed.input).toBeGreaterThan(0);
    expect(result.tokensUsed.output).toBeGreaterThan(0);
  });

  test('accepts acceptance criteria parameter', async () => {
    const critic = createMockCritic();
    const result = await critic.review(makeProposal(), makeTask(), makePerception(), [
      'all tests pass',
      'no new lint warnings',
    ]);
    expect(result.approved).toBe(true);
  });
});

describe('LLMCriticImpl accountability prompt', () => {
  test('threads Definition of Done rubric into the critic request', async () => {
    let captured: LLMRequest | undefined;
    const provider: LLMProvider = {
      generate: async (request: LLMRequest) => {
        captured = request;
        return {
          content: JSON.stringify({
            approved: true,
            aspects: [
              { name: 'requirement_coverage', passed: true, explanation: 'ok' },
              { name: 'logic_correctness', passed: true, explanation: 'ok' },
              { name: 'side_effects', passed: true, explanation: 'ok' },
              { name: 'completeness', passed: true, explanation: 'ok' },
              { name: 'consistency', passed: true, explanation: 'ok' },
            ],
            reason: 'safe',
          }),
          tokensUsed: { input: 10, output: 5 },
        };
      },
    } as unknown as LLMProvider;

    const critic = new LLMCriticImpl(provider);
    await critic.review(makeProposal(), makeTask(), makePerception(), ['all tests pass']);

    expect(captured?.systemPrompt).toContain('[ACCOUNTABILITY RUBRIC]');
    expect(captured?.systemPrompt).toContain('Reject Grade C proposals');
    expect(captured?.userPrompt).toContain('[ACCEPTANCE CRITERIA]');
    expect(captured?.userPrompt).toContain('all tests pass');
  });

  test('renders [PRIOR ITERATION RESULT] when context.priorAccountabilityGrade is provided', async () => {
    let captured: LLMRequest | undefined;
    const provider: LLMProvider = {
      generate: async (request: LLMRequest) => {
        captured = request;
        return {
          content: JSON.stringify({
            approved: false,
            aspects: [
              { name: 'requirement_coverage', passed: false, explanation: 'still missing' },
              { name: 'logic_correctness', passed: true, explanation: 'ok' },
              { name: 'side_effects', passed: true, explanation: 'ok' },
              { name: 'completeness', passed: true, explanation: 'ok' },
              { name: 'consistency', passed: true, explanation: 'ok' },
            ],
            reason: 'unaddressed',
          }),
          tokensUsed: { input: 10, output: 5 },
        };
      },
    } as unknown as LLMProvider;

    const critic = new LLMCriticImpl(provider);
    await critic.review(makeProposal(), makeTask(), makePerception(), ['all tests pass'], {
      priorAccountabilityGrade: 'C',
      priorBlockerCategories: ['oracle-contradiction', 'acceptance-criteria'],
    });

    expect(captured?.userPrompt).toContain('[PRIOR ITERATION RESULT]');
    expect(captured?.userPrompt).toContain('Deterministic accountability grade: C');
    expect(captured?.userPrompt).toContain('oracle-contradiction');
    expect(captured?.userPrompt).toContain('acceptance-criteria');
    expect(captured?.userPrompt).toMatch(/Reject if the same failure pattern is repeated/i);
  });

  test('omits [PRIOR ITERATION RESULT] on first iteration (no prior grade)', async () => {
    let captured: LLMRequest | undefined;
    const provider: LLMProvider = {
      generate: async (request: LLMRequest) => {
        captured = request;
        return {
          content: JSON.stringify({
            approved: true,
            aspects: [
              { name: 'requirement_coverage', passed: true, explanation: 'ok' },
              { name: 'logic_correctness', passed: true, explanation: 'ok' },
              { name: 'side_effects', passed: true, explanation: 'ok' },
              { name: 'completeness', passed: true, explanation: 'ok' },
              { name: 'consistency', passed: true, explanation: 'ok' },
            ],
            reason: 'fresh',
          }),
          tokensUsed: { input: 10, output: 5 },
        };
      },
    } as unknown as LLMProvider;

    const critic = new LLMCriticImpl(provider);
    await critic.review(makeProposal(), makeTask(), makePerception(), ['c1'], {
      riskScore: 0.3,
      routingLevel: 2,
    });

    expect(captured?.userPrompt).not.toContain('[PRIOR ITERATION RESULT]');
  });
});

// ---------------------------------------------------------------------------
// Slice 4 follow-up: [CALIBRATION WARNING] block in critic prompt
// ---------------------------------------------------------------------------

describe('LLMCriticImpl — calibration warning (slice 4 follow-up)', () => {
  test('renders [CALIBRATION WARNING] when prior prediction error was overconfident', async () => {
    let captured: LLMRequest | undefined;
    const provider: LLMProvider = {
      generate: async (request: LLMRequest) => {
        captured = request;
        return {
          content: JSON.stringify({
            approved: false,
            aspects: [
              { name: 'requirement_coverage', passed: false, explanation: 'still missing' },
              { name: 'logic_correctness', passed: true, explanation: 'ok' },
              { name: 'side_effects', passed: true, explanation: 'ok' },
              { name: 'completeness', passed: true, explanation: 'ok' },
              { name: 'consistency', passed: true, explanation: 'ok' },
            ],
            reason: 'overclaim',
          }),
          tokensUsed: { input: 10, output: 5 },
        };
      },
    } as unknown as LLMProvider;

    const critic = new LLMCriticImpl(provider);
    await critic.review(makeProposal(), makeTask(), makePerception(), ['c1'], {
      priorPredictionError: {
        selfGrade: 'A',
        deterministicGrade: 'C',
        magnitude: 'severe',
        direction: 'overconfident',
      },
    });

    expect(captured?.userPrompt).toContain('[CALIBRATION WARNING]');
    expect(captured?.userPrompt).toContain('self-graded A');
    expect(captured?.userPrompt).toContain('deterministic evaluator awarded C');
    expect(captured?.userPrompt).toMatch(/severe overconfidence/i);
  });

  test('omits [CALIBRATION WARNING] when prior was aligned', async () => {
    let captured: LLMRequest | undefined;
    const provider: LLMProvider = {
      generate: async (request: LLMRequest) => {
        captured = request;
        return {
          content: JSON.stringify({
            approved: true,
            aspects: [
              { name: 'requirement_coverage', passed: true, explanation: 'ok' },
              { name: 'logic_correctness', passed: true, explanation: 'ok' },
              { name: 'side_effects', passed: true, explanation: 'ok' },
              { name: 'completeness', passed: true, explanation: 'ok' },
              { name: 'consistency', passed: true, explanation: 'ok' },
            ],
            reason: 'ok',
          }),
          tokensUsed: { input: 10, output: 5 },
        };
      },
    } as unknown as LLMProvider;

    const critic = new LLMCriticImpl(provider);
    await critic.review(makeProposal(), makeTask(), makePerception(), ['c1'], {
      priorPredictionError: {
        selfGrade: 'B',
        deterministicGrade: 'B',
        magnitude: 'aligned',
        direction: 'aligned',
      },
    });

    expect(captured?.userPrompt).not.toContain('[CALIBRATION WARNING]');
  });

  test('omits [CALIBRATION WARNING] when prior was underconfident (does not relax bar)', async () => {
    let captured: LLMRequest | undefined;
    const provider: LLMProvider = {
      generate: async (request: LLMRequest) => {
        captured = request;
        return {
          content: JSON.stringify({
            approved: true,
            aspects: [
              { name: 'requirement_coverage', passed: true, explanation: 'ok' },
              { name: 'logic_correctness', passed: true, explanation: 'ok' },
              { name: 'side_effects', passed: true, explanation: 'ok' },
              { name: 'completeness', passed: true, explanation: 'ok' },
              { name: 'consistency', passed: true, explanation: 'ok' },
            ],
            reason: 'ok',
          }),
          tokensUsed: { input: 10, output: 5 },
        };
      },
    } as unknown as LLMProvider;

    const critic = new LLMCriticImpl(provider);
    await critic.review(makeProposal(), makeTask(), makePerception(), ['c1'], {
      priorPredictionError: {
        selfGrade: 'C',
        deterministicGrade: 'A',
        magnitude: 'severe',
        direction: 'underconfident',
      },
    });

    expect(captured?.userPrompt).not.toContain('[CALIBRATION WARNING]');
  });
});

// ---------------------------------------------------------------------------
// LLMCriticImpl fail-closed behavior (A2 compliance)
// ---------------------------------------------------------------------------

function makeThrowingProvider(): LLMProvider {
  return {
    generate: async () => {
      throw new Error('provider unavailable');
    },
  } as unknown as LLMProvider;
}

function makeUnparseableProvider(): LLMProvider {
  return {
    generate: async () => ({
      content: 'this is not valid JSON at all',
      tokensUsed: { input: 50, output: 20 },
    }),
  } as unknown as LLMProvider;
}

describe('LLMCriticImpl fail-closed behavior', () => {
  test('returns approved=false when LLM provider throws', async () => {
    const critic = new LLMCriticImpl(makeThrowingProvider());
    const result = await critic.review(makeProposal(), makeTask(), makePerception());
    expect(result.approved).toBe(false);
    expect(result.confidence).toBe(0.3);
    expect(result.reason).toContain('fail-closed');
  });

  test('returns approved=false when LLM response is unparseable', async () => {
    const critic = new LLMCriticImpl(makeUnparseableProvider());
    const result = await critic.review(makeProposal(), makeTask(), makePerception());
    expect(result.approved).toBe(false);
    expect(result.confidence).toBe(0.3);
    expect(result.reason).toContain('fail-closed');
  });

  test('all aspects are passed=false on failure', async () => {
    const critic = new LLMCriticImpl(makeThrowingProvider());
    const result = await critic.review(makeProposal(), makeTask(), makePerception());
    expect(result.aspects.length).toBe(5);
    for (const aspect of result.aspects) {
      expect(aspect.passed).toBe(false);
      expect(aspect.explanation).toContain('fail-closed');
    }
  });

  test('tokens are tracked even on parse failure', async () => {
    const critic = new LLMCriticImpl(makeUnparseableProvider());
    const result = await critic.review(makeProposal(), makeTask(), makePerception());
    expect(result.tokensUsed.input).toBe(50);
    expect(result.tokensUsed.output).toBe(20);
  });
});
