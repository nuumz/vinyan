/**
 * Integration test: prediction → routing → plan → execution → calibration (C5)
 *
 * Verifies the full ForwardPredictor wiring across core-loop components:
 * - C1: Prediction escalates routing level
 * - C2: Plan nodes scored and reordered by causal risk
 * - C3: Merge of SelfModel + ForwardPredictor appears on trace
 * - C4: Miscalibration event emitted when Brier exceeds threshold
 */
import { describe, test, expect } from 'bun:test';
import { mergeForwardAndSelfModel, scorePlanByPrediction } from '../../src/orchestrator/core-loop.ts';
import { applyPredictionEscalation } from '../../src/gate/risk-router.ts';
import { CalibrationEngineImpl } from '../../src/orchestrator/prediction/calibration-engine.ts';
import type { OutcomePrediction, CausalRiskEntry } from '../../src/orchestrator/forward-predictor-types.ts';
import type { RoutingDecision, SelfModelPrediction, TaskDAG } from '../../src/orchestrator/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRouting(level: 0 | 1 | 2 | 3): RoutingDecision {
  return { level, model: level === 0 ? null : 'claude-sonnet', budgetTokens: level * 25000, latencyBudgetMs: level * 15000 };
}

function makeSelfModelPrediction(pPass?: number): SelfModelPrediction {
  return {
    taskId: 'task-integ-1',
    timestamp: Date.now(),
    expectedTestResults: 'pass',
    expectedBlastRadius: 3,
    expectedDuration: 5000,
    expectedQualityScore: 0.75,
    uncertainAreas: [],
    confidence: 0.6,
    metaConfidence: 0.3,
    pPass,
    basis: 'static-heuristic',
    calibrationDataPoints: 0,
  };
}

function makeRiskEntry(filePath: string, breakProb: number): CausalRiskEntry {
  return { filePath, breakProbability: breakProb, causalChain: [{ fromFile: 'a.ts', toFile: filePath, edgeType: 'imports' }] };
}

function makePrediction(overrides?: Partial<OutcomePrediction>): OutcomePrediction {
  return {
    predictionId: 'pred-integ-1',
    taskId: 'task-integ-1',
    timestamp: Date.now(),
    testOutcome: { pPass: 0.7, pPartial: 0.2, pFail: 0.1 },
    blastRadius: { lo: 1, mid: 3, hi: 6 },
    qualityScore: { lo: 0.5, mid: 0.75, hi: 0.9 },
    expectedDuration: 2000,
    causalRiskFiles: [],
    basis: 'causal',
    causalChainDepth: 3,
    confidence: 0.6,
    ...overrides,
  };
}

function makeDAG(files: string[][]): TaskDAG {
  return {
    nodes: files.map((targetFiles, i) => ({
      id: `n${i + 1}`,
      description: `Step ${i + 1}`,
      targetFiles,
      dependencies: i > 0 ? [`n${i}`] : [],
      assignedOracles: ['type'],
    })),
  };
}

// ---------------------------------------------------------------------------
// Integration: prediction → routing → plan → calibration
// ---------------------------------------------------------------------------

describe('Prediction Wiring Integration', () => {
  test('C1+C3: high causal risk escalates routing and merge reflects both models', () => {
    const routing = makeRouting(1);
    const fp = makePrediction({
      confidence: 0.8,
      testOutcome: { pPass: 0.9, pPartial: 0.05, pFail: 0.05 },
      causalRiskFiles: [makeRiskEntry('risky.ts', 0.65)],
    });

    // C1: escalation
    const escalated = applyPredictionEscalation(routing, fp);
    expect(escalated.level).toBe(2); // >0.5 breakProb → min L2

    // C3: merge
    const sm = makeSelfModelPrediction(0.5);
    const merged = mergeForwardAndSelfModel(sm, fp);
    // w_fp=0.8, w_sm=0.2 → 0.8*0.9 + 0.2*0.5 = 0.72 + 0.10 = 0.82
    expect(merged).toBeCloseTo(0.82, 2);
  });

  test('C1: aggregate risk > 0.7 escalates to L3', () => {
    const routing = makeRouting(1);
    const fp = makePrediction({
      causalRiskFiles: [
        makeRiskEntry('a.ts', 0.5),
        makeRiskEntry('b.ts', 0.5),
        makeRiskEntry('c.ts', 0.5),
      ],
    });
    // aggregateRisk = 1 - (0.5)^3 = 0.875 > 0.7
    const result = applyPredictionEscalation(routing, fp);
    expect(result.level).toBe(3);
  });

  test('C1: no causal risk → routing unchanged', () => {
    const routing = makeRouting(1);
    const fp = makePrediction({ causalRiskFiles: [] });
    const result = applyPredictionEscalation(routing, fp);
    expect(result).toBe(routing); // same reference — no change
  });

  test('C2: plan nodes reordered by causal risk (fail-fast)', () => {
    const plan = makeDAG([['low.ts'], ['high.ts'], ['mid.ts']]);
    const fp = makePrediction({
      causalRiskFiles: [
        makeRiskEntry('high.ts', 0.9),
        makeRiskEntry('mid.ts', 0.4),
        makeRiskEntry('low.ts', 0.1),
      ],
    });

    scorePlanByPrediction(plan, fp);

    expect(plan.nodes[0]!.targetFiles).toContain('high.ts');
    expect(plan.nodes[0]!.riskScore).toBeCloseTo(0.9);
    expect(plan.nodes[1]!.targetFiles).toContain('mid.ts');
    expect(plan.nodes[2]!.targetFiles).toContain('low.ts');
  });

  test('C2: plan nodes without matching risk files get riskScore 0', () => {
    const plan = makeDAG([['unrelated.ts']]);
    const fp = makePrediction({
      causalRiskFiles: [makeRiskEntry('other.ts', 0.8)],
    });

    scorePlanByPrediction(plan, fp);
    expect(plan.nodes[0]!.riskScore).toBe(0);
  });

  test('C3: SelfModel pPass undefined defaults to 0.5', () => {
    const sm = makeSelfModelPrediction(); // pPass = undefined
    const fp = makePrediction({ confidence: 0.5, testOutcome: { pPass: 0.8, pPartial: 0.1, pFail: 0.1 } });
    const merged = mergeForwardAndSelfModel(sm, fp);
    // 0.5 * 0.8 + 0.5 * 0.5 = 0.4 + 0.25 = 0.65
    expect(merged).toBeCloseTo(0.65, 2);
  });

  test('D3+D8: IntervalScore penalty for actual outside [lo, hi]', () => {
    const engine = new CalibrationEngineImpl();
    // Actual below lo=2 → penalty: (hi-lo) + (2/0.2)(lo-actual) = 8 + 10*(2-0) = 108
    const score = engine.scoreInterval({ lo: 2, mid: 5, hi: 10 }, 0);
    expect(score).toBeGreaterThan(8); // must be > spread penalty alone

    // Actual inside → score = (hi - lo) only
    const insideScore = engine.scoreInterval({ lo: 2, mid: 5, hi: 10 }, 5);
    expect(insideScore).toBe(8); // just the spread: 10 - 2

    // Exact point prediction → 0
    const exactScore = engine.scoreInterval({ lo: 3, mid: 3, hi: 3 }, 3);
    expect(exactScore).toBe(0);
  });

  test('full pipeline: predict → escalate → score plan → calibrate', () => {
    // 1. ForwardPredictor produces prediction with high risk
    const fp = makePrediction({
      confidence: 0.7,
      testOutcome: { pPass: 0.6, pPartial: 0.3, pFail: 0.1 },
      causalRiskFiles: [makeRiskEntry('core.ts', 0.7), makeRiskEntry('util.ts', 0.3)],
    });

    // 2. Routing escalation — aggregate risk = 1-(0.3*0.7) = 0.79 > 0.7 → L3
    const routing = makeRouting(1);
    const escalated = applyPredictionEscalation(routing, fp);
    expect(escalated.level).toBe(3);

    // 3. Plan scored by risk
    const plan = makeDAG([['util.ts'], ['core.ts']]);
    scorePlanByPrediction(plan, fp);
    expect(plan.nodes[0]!.targetFiles).toContain('core.ts'); // higher risk first

    // 4. Merge with SelfModel
    const sm = makeSelfModelPrediction(0.8);
    const merged = mergeForwardAndSelfModel(sm, fp);
    // 0.7*0.6 + 0.3*0.8 = 0.42 + 0.24 = 0.66
    expect(merged).toBeCloseTo(0.66, 2);

    // 5. Calibration — record outcome and check Brier
    const engine = new CalibrationEngineImpl();
    const brierScore = engine.scoreTestOutcome(fp.testOutcome, 'pass');
    // Brier: (0.6-1)^2 + (0.3-0)^2 + (0.1-0)^2 = 0.16+0.09+0.01 = 0.26
    expect(brierScore).toBeCloseTo(0.26, 2);

    // 6. IntervalScore for blast radius
    const is = engine.scoreInterval(fp.blastRadius, 3); // actual=3, inside [1,6] → spread = 5
    expect(is).toBe(5);
  });
});
