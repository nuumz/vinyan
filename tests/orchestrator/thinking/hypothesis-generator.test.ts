import { describe, expect, test } from 'bun:test';
import { ReasoningEngineRegistry } from '../../../src/orchestrator/llm/llm-reasoning-engine.ts';
import type { MultiHypothesisPolicy } from '../../../src/orchestrator/thinking/hypothesis.ts';
import {
  DefaultHypothesisGenerator,
  fingerprintOf,
  jaccardOverlap,
} from '../../../src/orchestrator/thinking/hypothesis-generator.ts';
import type { RERequest, REResponse, ReasoningEngine } from '../../../src/orchestrator/types.ts';

class StubEngine implements ReasoningEngine {
  readonly engineType = 'llm' as const;
  readonly capabilities = ['reasoning'];
  readonly tier = 'balanced' as const;
  calls: RERequest[] = [];

  constructor(
    readonly id: string,
    private readonly responder: (req: RERequest) => string,
    private readonly tokens = { input: 100, output: 50 },
  ) {}

  async execute(req: RERequest): Promise<REResponse> {
    this.calls.push(req);
    return {
      content: this.responder(req),
      toolCalls: [],
      tokensUsed: this.tokens,
      engineId: this.id,
      terminationReason: 'completed',
    };
  }
}

function buildRegistry(...engines: ReasoningEngine[]): ReasoningEngineRegistry {
  const reg = new ReasoningEngineRegistry();
  for (const e of engines) reg.register(e);
  return reg;
}

describe('DefaultHypothesisGenerator', () => {
  test('produces N branches with distinct approach overlays in the system prompt', async () => {
    const eng = new StubEngine('eng-1', (req) => `answer reflecting: ${req.systemPrompt.slice(-40)}`);
    const reg = buildRegistry(eng);
    const gen = new DefaultHypothesisGenerator(reg);
    const policy: MultiHypothesisPolicy = { branches: 3, diversityConstraint: 'different-patterns' };

    const outcome = await gen.generate(
      { systemPrompt: 'You are a coder.', userPrompt: 'Refactor function foo.', perBranchTokens: 400 },
      policy,
    );

    // Behavior: 3 branch overlays were sent to the engine, each with a distinct approach line.
    expect(eng.calls.length).toBe(3);
    const overlays = eng.calls.map((c) => c.systemPrompt.split('\n').pop());
    const uniqueOverlays = new Set(overlays);
    expect(uniqueOverlays.size).toBe(3);
    // Each accepted hypothesis is tagged with the engine + an approach label.
    expect(outcome.hypotheses.length).toBe(3);
    for (const h of outcome.hypotheses) {
      expect(h.engineId).toBe('eng-1');
      expect(['direct', 'defensive', 'minimal', 'refactor-first', 'exploratory']).toContain(h.approachLabel);
    }
  });

  test('different-resources requires distinct engines and caps branches at engine count', async () => {
    const e1 = new StubEngine('eng-A', () => 'first answer');
    const e2 = new StubEngine('eng-B', () => 'second answer');
    const reg = buildRegistry(e1, e2);
    const gen = new DefaultHypothesisGenerator(reg);
    const outcome = await gen.generate(
      { systemPrompt: 'sys', userPrompt: 'usr', perBranchTokens: 200 },
      { branches: 4, diversityConstraint: 'different-resources' },
    );
    // 4 branches requested but only 2 distinct engines → 2 branches generated.
    expect(outcome.hypotheses.length).toBe(2);
    const engineIds = outcome.hypotheses.map((h) => h.engineId).sort();
    expect(engineIds).toEqual(['eng-A', 'eng-B']);
  });

  test('rejects near-duplicate branches via Jaccard overlap', async () => {
    // Two engines but they return effectively identical content. The generator
    // should accept the first and reject the second as a duplicate, surfacing
    // the collision in `rejected[]`.
    const sameAnswer = 'The function should iterate the list and accumulate results into an array';
    const e1 = new StubEngine('eng-A', () => sameAnswer);
    const e2 = new StubEngine('eng-B', () => sameAnswer);
    const reg = buildRegistry(e1, e2);
    const gen = new DefaultHypothesisGenerator(reg);
    const outcome = await gen.generate(
      { systemPrompt: 'sys', userPrompt: 'usr', perBranchTokens: 200 },
      { branches: 2, diversityConstraint: 'different-resources', maxFingerprintOverlap: 0.85 },
    );
    expect(outcome.hypotheses.length).toBe(1);
    expect(outcome.rejected.length).toBe(1);
    expect(outcome.rejected[0]?.rejection.reason).toBe('duplicate');
  });

  test('aggregates token totals across attempted branches (rejected included)', async () => {
    const tokens = { input: 100, output: 50 };
    const e1 = new StubEngine('eng-A', () => 'unique answer one', tokens);
    const e2 = new StubEngine('eng-B', () => 'unique answer one', tokens); // duplicate -> rejected
    const reg = buildRegistry(e1, e2);
    const gen = new DefaultHypothesisGenerator(reg);
    const outcome = await gen.generate(
      { systemPrompt: 's', userPrompt: 'u', perBranchTokens: 200 },
      { branches: 2, diversityConstraint: 'different-resources' },
    );
    expect(outcome.totalTokens.input).toBe(200);
    expect(outcome.totalTokens.output).toBe(100);
  });

  test('records empty-content rejection without inventing a hypothesis', async () => {
    // diversity-constraint=different-resources caps branches at engine count,
    // so a single registered engine produces exactly one branch even when
    // policy.branches asks for more — the perfect setup for this test.
    const e1 = new StubEngine('eng-A', () => '   '); // whitespace only
    const reg = buildRegistry(e1);
    const gen = new DefaultHypothesisGenerator(reg);
    const outcome = await gen.generate(
      { systemPrompt: 's', userPrompt: 'u', perBranchTokens: 200 },
      { branches: 2, diversityConstraint: 'different-resources' },
    );
    expect(outcome.hypotheses.length).toBe(0);
    expect(outcome.rejected.length).toBe(1);
    expect(outcome.rejected[0]?.rejection.reason).toBe('empty-content');
  });

  test('returns engine-error rejection when execute() throws', async () => {
    class ExplodingEngine implements ReasoningEngine {
      readonly id = 'boom';
      readonly engineType = 'llm' as const;
      readonly capabilities = ['reasoning'];
      readonly tier = 'fast' as const;
      async execute(): Promise<REResponse> {
        throw new Error('upstream-503');
      }
    }
    const reg = buildRegistry(new ExplodingEngine());
    const gen = new DefaultHypothesisGenerator(reg);
    const outcome = await gen.generate(
      { systemPrompt: 's', userPrompt: 'u', perBranchTokens: 200 },
      { branches: 2, diversityConstraint: 'different-resources' },
    );
    expect(outcome.hypotheses.length).toBe(0);
    const first = outcome.rejected[0];
    expect(first?.rejection.reason).toBe('engine-error');
    if (first?.rejection.reason === 'engine-error') {
      expect(first.rejection.message).toContain('upstream-503');
    }
  });
});

describe('fingerprint helpers', () => {
  test('fingerprintOf is stable across cosmetic whitespace changes', () => {
    const a = fingerprintOf('direct', 'use a   for-loop\n');
    const b = fingerprintOf('direct', '  use a for-loop');
    expect(a).toBe(b);
  });

  test('jaccardOverlap returns 1 for identical content', () => {
    const text = 'iterate the list and sum the elements one by one';
    expect(jaccardOverlap(text, text)).toBe(1);
  });

  test('jaccardOverlap returns 0 for fully disjoint content', () => {
    expect(jaccardOverlap('alpha beta gamma', 'omega delta epsilon')).toBe(0);
  });

  test('jaccardOverlap is between 0 and 1 for partial overlap', () => {
    const overlap = jaccardOverlap(
      'use a recursive descent parser for json input handling',
      'use a recursive descent walker for csv input handling',
    );
    expect(overlap).toBeGreaterThan(0);
    expect(overlap).toBeLessThan(1);
  });
});
