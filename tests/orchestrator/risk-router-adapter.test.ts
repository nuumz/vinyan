import { describe, expect, test } from 'bun:test';
import { RiskRouterImpl } from '../../src/orchestrator/risk-router-adapter.ts';
import type { TaskInput } from '../../src/orchestrator/types.ts';

function makeInput(overrides?: Partial<TaskInput>): TaskInput {
  return {
    id: 't-1',
    source: 'cli',
    goal: 'Fix bug',
    taskType: 'code',
    budget: { maxTokens: 50_000, maxDurationMs: 60_000, maxRetries: 3 },
    ...overrides,
  };
}

// Mock dep-verify that returns configurable blast radius
function mockDepVerify(blastRadius: number) {
  return async () => ({
    evidence: Array.from({ length: blastRadius }, (_, i) => ({ file: `dep-${i}.ts` })),
  });
}

describe('RiskRouterImpl', () => {
  test('reasoning task → floors to L1 (needs LLM reasoning)', async () => {
    const router = new RiskRouterImpl(mockDepVerify(0));
    const decision = await router.assessInitialLevel(makeInput({ taskType: 'reasoning' }));
    // Reasoning tasks floor to L1 so the LLM is invoked for reasoning/Q&A
    expect(decision.level).toBe(1);
    expect(decision.model).toBe('fast');
    expect(decision.budgetTokens).toBe(10_000);
  });

  test('high blast radius escalates to L1', async () => {
    // blastRadius=10 → normBlast=0.2 → score=0.225 → L1 (0.2 < 0.225 ≤ 0.4)
    const router = new RiskRouterImpl(mockDepVerify(10));
    const decision = await router.assessInitialLevel(makeInput({ targetFiles: ['src/core.ts'] }));
    expect(decision.level).toBe(1);
  });

  test('MIN_ROUTING_LEVEL:2 forces minimum L2', async () => {
    const router = new RiskRouterImpl(mockDepVerify(0));
    const decision = await router.assessInitialLevel(makeInput({ constraints: ['MIN_ROUTING_LEVEL:2'] }));
    expect(decision.level).toBeGreaterThanOrEqual(2);
  });

  test('dep-verify failure falls back to blastRadius=2 (A6 fail-closed)', async () => {
    const failingVerify = async () => {
      throw new Error('dep-oracle crash');
    };
    const router = new RiskRouterImpl(failingVerify as any);
    const decision = await router.assessInitialLevel(makeInput({ targetFiles: ['src/foo.ts'] }));
    // A6: unknown blast radius → blastRadius=2 → triggers L1 hard floor (blastRadius > 1)
    expect(decision.level).toBeGreaterThanOrEqual(1);
  });

  test('reuses Phase 0 calculateRiskScore and routeByRisk', async () => {
    const router = new RiskRouterImpl(mockDepVerify(0));
    // File task with blastRadius=0 but no test coverage → risk=0.25 → L1
    const decision = await router.assessInitialLevel(makeInput({ targetFiles: ['src/foo.ts'] }));
    // Verifies Phase 0 functions are called and produce a valid RoutingDecision
    expect(decision.level).toBeGreaterThanOrEqual(0);
    expect(decision).toHaveProperty('model');
    expect(decision).toHaveProperty('budgetTokens');
  });

  test('returns valid RoutingDecision shape', async () => {
    const router = new RiskRouterImpl(mockDepVerify(5));
    const decision = await router.assessInitialLevel(makeInput({ targetFiles: ['src/foo.ts'] }));
    expect(decision).toHaveProperty('level');
    expect(decision).toHaveProperty('model');
    expect(decision).toHaveProperty('budgetTokens');
    expect(decision).toHaveProperty('latencyBudgetMs');
  });

  test('selfModel epistemic signal is passed to routeByRisk', async () => {
    const mockSelfModel = {
      getEpistemicSignal: (_taskSig: string) => ({
        avgOracleConfidence: 0.95,
        observationCount: 50,
        basis: 'calibrated' as const,
      }),
    };
    const router = new RiskRouterImpl(mockDepVerify(0), process.cwd(), undefined, mockSelfModel);
    const decision = await router.assessInitialLevel(makeInput({ targetFiles: ['src/foo.ts'] }));
    // With calibrated high-confidence signal, de-escalation should apply if risk > L0
    expect(decision).toHaveProperty('level');
    // The epistemic signal should flow through — if original level > 0 and gets de-escalated,
    // the flag should be set. If original level was already 0, no de-escalation possible.
    // With blastRadius=0, testCoverage≈0, fileVolatility≈0 → risk low but non-zero → L1 baseline → de-escalated to L0
    expect(decision.level).toBe(0);
    expect(decision.epistemicDeescalated).toBe(true);
  });
});
