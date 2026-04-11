/**
 * Tests for applyPredictionEscalation — prediction-based routing escalation.
 * Phase C1: ForwardPredictor causal risk → routing level adjustment.
 */
import { describe, expect, it } from 'bun:test';
import { applyPredictionEscalation } from '@vinyan/gate/risk-router.ts';
import type { OutcomePrediction, CausalRiskEntry } from '@vinyan/orchestrator/forward-predictor-types.ts';
import type { RoutingDecision, RoutingLevel } from '@vinyan/orchestrator/types.ts';

// ── Factories ────────────────────────────────────────────────────

function makeRouting(level: RoutingLevel): RoutingDecision {
  return {
    level,
    model: level === 0 ? null : 'claude-sonnet',
    budgetTokens: level * 25_000,
    latencyBudgetMs: level * 15_000,
  };
}

function makePrediction(overrides: Partial<OutcomePrediction> = {}): OutcomePrediction {
  return {
    predictionId: 'pred-1',
    taskId: 'task-1',
    timestamp: Date.now(),
    testOutcome: { pPass: 0.8, pPartial: 0.1, pFail: 0.1 },
    blastRadius: { lo: 1, mid: 3, hi: 5 },
    qualityScore: { lo: 0.6, mid: 0.8, hi: 0.95 },
    expectedDuration: 1000,
    causalRiskFiles: [],
    basis: 'causal',
    causalChainDepth: 3,
    confidence: 0.7,
    ...overrides,
  };
}

function makeRiskEntry(breakProbability: number): CausalRiskEntry {
  return {
    filePath: `src/module-${Math.random().toString(36).slice(2, 6)}.ts`,
    breakProbability,
    causalChain: [{ fromFile: 'a.ts', toFile: 'b.ts', edgeType: 'imports' }],
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('applyPredictionEscalation', () => {
  it('no causal risk files → routing unchanged', () => {
    const routing = makeRouting(1);
    const prediction = makePrediction({ causalRiskFiles: [] });
    const result = applyPredictionEscalation(routing, prediction);
    expect(result).toBe(routing); // same reference — no copy
  });

  it('topRisk.breakProbability = 0.3 → no escalation', () => {
    const routing = makeRouting(1);
    const prediction = makePrediction({
      causalRiskFiles: [makeRiskEntry(0.3)],
    });
    const result = applyPredictionEscalation(routing, prediction);
    expect(result).toBe(routing);
  });

  it('topRisk.breakProbability = 0.6, level 0 → escalate to L2', () => {
    const routing = makeRouting(0);
    const prediction = makePrediction({
      causalRiskFiles: [makeRiskEntry(0.6)],
    });
    const result = applyPredictionEscalation(routing, prediction);
    expect(result.level).toBe(2);
  });

  it('topRisk.breakProbability = 0.6, level 2 → stays at L2', () => {
    const routing = makeRouting(2);
    const prediction = makePrediction({
      causalRiskFiles: [makeRiskEntry(0.6)],
    });
    const result = applyPredictionEscalation(routing, prediction);
    expect(result).toBe(routing); // no change → same reference
  });

  it('aggregate risk > 0.7 → escalate to L3', () => {
    const routing = makeRouting(1);
    // Two files each with 0.5 → aggregate = 1 - (0.5 * 0.5) = 0.75
    const prediction = makePrediction({
      causalRiskFiles: [makeRiskEntry(0.5), makeRiskEntry(0.5)],
    });
    const result = applyPredictionEscalation(routing, prediction);
    expect(result.level).toBe(3);
  });

  it('aggregate risk > 0.7, level already 3 → stays at L3', () => {
    const routing = makeRouting(3);
    const prediction = makePrediction({
      causalRiskFiles: [makeRiskEntry(0.5), makeRiskEntry(0.5)],
    });
    const result = applyPredictionEscalation(routing, prediction);
    expect(result).toBe(routing);
  });

  it('low aggregate risk (< 0.7) → no L3 escalation', () => {
    const routing = makeRouting(1);
    // Two files each with 0.3 → aggregate = 1 - (0.7 * 0.7) = 0.51
    const prediction = makePrediction({
      causalRiskFiles: [makeRiskEntry(0.3), makeRiskEntry(0.3)],
    });
    const result = applyPredictionEscalation(routing, prediction);
    expect(result.level).toBeLessThan(3);
  });

  it('both top risk and aggregate triggers → L3 wins (highest)', () => {
    const routing = makeRouting(0);
    // topRisk = 0.6 (>0.5 → L2), aggregate = 1 - (0.4 * 0.3) = 0.88 (>0.7 → L3)
    const prediction = makePrediction({
      causalRiskFiles: [makeRiskEntry(0.6), makeRiskEntry(0.7)],
    });
    const result = applyPredictionEscalation(routing, prediction);
    expect(result.level).toBe(3);
  });

  it('returns new object — does not mutate original', () => {
    const routing = makeRouting(0);
    const originalLevel = routing.level;
    const prediction = makePrediction({
      causalRiskFiles: [makeRiskEntry(0.6)],
    });
    const result = applyPredictionEscalation(routing, prediction);
    expect(result).not.toBe(routing);
    expect(routing.level).toBe(originalLevel); // original untouched
    expect(result.level).toBe(2);
    // Carries over other fields
    expect(result.model).toBe(routing.model);
    expect(result.budgetTokens).toBe(routing.budgetTokens);
  });
});
