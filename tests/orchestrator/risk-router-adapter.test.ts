import { describe, expect, test } from 'bun:test';
import { RiskRouterImpl } from '../../src/orchestrator/risk-router-adapter.ts';
import type { TaskInput } from '../../src/orchestrator/types.ts';

function makeInput(overrides?: Partial<TaskInput>): TaskInput {
  return {
    id: 't-1',
    source: 'cli',
    goal: 'Fix bug',
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
  test('no target files → returns L0 default', async () => {
    const router = new RiskRouterImpl(mockDepVerify(0));
    const decision = await router.assessInitialLevel(makeInput());
    expect(decision.level).toBe(0);
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
    const decision = await router.assessInitialLevel(makeInput());
    // L0 decision has null model and 0 budget tokens
    expect(decision.model).toBeNull();
    expect(decision.budgetTokens).toBe(0);
  });

  test('returns valid RoutingDecision shape', async () => {
    const router = new RiskRouterImpl(mockDepVerify(5));
    const decision = await router.assessInitialLevel(makeInput({ targetFiles: ['src/foo.ts'] }));
    expect(decision).toHaveProperty('level');
    expect(decision).toHaveProperty('model');
    expect(decision).toHaveProperty('budgetTokens');
    expect(decision).toHaveProperty('latencyBudgetMs');
  });
});
