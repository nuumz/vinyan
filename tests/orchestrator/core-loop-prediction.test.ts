import { describe, expect, test } from 'bun:test';
import { mergeForwardAndSelfModel, scorePlanByPrediction } from '../../src/orchestrator/core-loop.ts';
import type { CausalRiskEntry, OutcomePrediction } from '../../src/orchestrator/forward-predictor-types.ts';
import type { SelfModelPrediction, TaskDAG } from '../../src/orchestrator/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSelfModelPrediction(overrides?: Partial<SelfModelPrediction>): SelfModelPrediction {
  return {
    taskId: 'task-1',
    timestamp: Date.now(),
    expectedTestResults: 'pass',
    expectedBlastRadius: 3,
    expectedDuration: 5000,
    expectedQualityScore: 0.8,
    uncertainAreas: [],
    confidence: 0.6,
    metaConfidence: 0.5,
    basis: 'trace-calibrated',
    calibrationDataPoints: 50,
    ...overrides,
  };
}

function makeOutcomePrediction(overrides?: Partial<OutcomePrediction>): OutcomePrediction {
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

function makePlanNode(id: string, targetFiles: string[], deps: string[] = []): TaskDAG['nodes'][number] {
  return {
    id,
    description: `Node ${id}`,
    targetFiles,
    dependencies: deps,
    assignedOracles: ['type', 'lint'],
  };
}

// ---------------------------------------------------------------------------
// mergeForwardAndSelfModel
// ---------------------------------------------------------------------------

describe('mergeForwardAndSelfModel', () => {
  test('FP confidence = 0 → all weight to SelfModel', () => {
    const sm = makeSelfModelPrediction({ pPass: 0.9 });
    const fp = makeOutcomePrediction({ confidence: 0 });
    const merged = mergeForwardAndSelfModel(sm, fp);
    expect(merged).toBeCloseTo(0.9, 5);
  });

  test('FP confidence = 1 → all weight to ForwardPredictor', () => {
    const sm = makeSelfModelPrediction({ pPass: 0.1 });
    const fp = makeOutcomePrediction({
      confidence: 1,
      testOutcome: { pPass: 0.95, pPartial: 0.03, pFail: 0.02 },
    });
    const merged = mergeForwardAndSelfModel(sm, fp);
    expect(merged).toBeCloseTo(0.95, 5);
  });

  test('FP confidence = 0.5 → equal blend', () => {
    const sm = makeSelfModelPrediction({ pPass: 0.6 });
    const fp = makeOutcomePrediction({
      confidence: 0.5,
      testOutcome: { pPass: 0.8, pPartial: 0.1, pFail: 0.1 },
    });
    const merged = mergeForwardAndSelfModel(sm, fp);
    // 0.5*0.8 + 0.5*0.6 = 0.4 + 0.3 = 0.7
    expect(merged).toBeCloseTo(0.7, 5);
  });

  test('SelfModel pPass undefined → defaults to 0.5', () => {
    const sm = makeSelfModelPrediction(); // no pPass
    const fp = makeOutcomePrediction({
      confidence: 0.5,
      testOutcome: { pPass: 0.8, pPartial: 0.1, pFail: 0.1 },
    });
    const merged = mergeForwardAndSelfModel(sm, fp);
    // 0.5*0.8 + 0.5*0.5 = 0.4 + 0.25 = 0.65
    expect(merged).toBeCloseTo(0.65, 5);
  });

  test('result is always between 0 and 1', () => {
    // Test boundary: sm=0, fp=0
    const sm0 = makeSelfModelPrediction({ pPass: 0 });
    const fp0 = makeOutcomePrediction({
      confidence: 0.5,
      testOutcome: { pPass: 0, pPartial: 0.5, pFail: 0.5 },
    });
    expect(mergeForwardAndSelfModel(sm0, fp0)).toBe(0);

    // Test boundary: sm=1, fp=1
    const sm1 = makeSelfModelPrediction({ pPass: 1 });
    const fp1 = makeOutcomePrediction({
      confidence: 0.5,
      testOutcome: { pPass: 1, pPartial: 0, pFail: 0 },
    });
    expect(mergeForwardAndSelfModel(sm1, fp1)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// scorePlanByPrediction
// ---------------------------------------------------------------------------

describe('scorePlanByPrediction', () => {
  test('no causal risk files → nodes unchanged', () => {
    const plan: TaskDAG = {
      nodes: [makePlanNode('a', ['src/a.ts']), makePlanNode('b', ['src/b.ts'])],
    };
    const fp = makeOutcomePrediction({ causalRiskFiles: [] });
    const originalOrder = plan.nodes.map((n) => n.id);
    scorePlanByPrediction(plan, fp);
    expect(plan.nodes.map((n) => n.id)).toEqual(originalOrder);
  });

  test('nodes with matching files get risk scores', () => {
    const risks: CausalRiskEntry[] = [
      { filePath: 'src/a.ts', breakProbability: 0.8, causalChain: [] },
      { filePath: 'src/b.ts', breakProbability: 0.3, causalChain: [] },
    ];
    const plan: TaskDAG = {
      nodes: [makePlanNode('a', ['src/a.ts']), makePlanNode('b', ['src/b.ts'])],
    };
    const fp = makeOutcomePrediction({ causalRiskFiles: risks });
    scorePlanByPrediction(plan, fp);
    expect(plan.nodes[0]!.riskScore).toBeCloseTo(0.8, 5);
    expect(plan.nodes[1]!.riskScore).toBeCloseTo(0.3, 5);
  });

  test('nodes sorted highest-risk-first', () => {
    const risks: CausalRiskEntry[] = [
      { filePath: 'src/a.ts', breakProbability: 0.2, causalChain: [] },
      { filePath: 'src/b.ts', breakProbability: 0.9, causalChain: [] },
      { filePath: 'src/c.ts', breakProbability: 0.5, causalChain: [] },
    ];
    const plan: TaskDAG = {
      nodes: [makePlanNode('a', ['src/a.ts']), makePlanNode('b', ['src/b.ts']), makePlanNode('c', ['src/c.ts'])],
    };
    const fp = makeOutcomePrediction({ causalRiskFiles: risks });
    scorePlanByPrediction(plan, fp);
    expect(plan.nodes.map((n) => n.id)).toEqual(['b', 'c', 'a']);
  });

  test('non-matching files \u2192 riskScore = 0', () => {
    const risks: CausalRiskEntry[] = [{ filePath: 'src/x.ts', breakProbability: 0.9, causalChain: [] }];
    const plan: TaskDAG = {
      nodes: [makePlanNode('a', ['src/a.ts']), makePlanNode('b', ['src/b.ts'])],
    };
    const fp = makeOutcomePrediction({ causalRiskFiles: risks });
    scorePlanByPrediction(plan, fp);
    expect(plan.nodes[0]!.riskScore).toBe(0);
    expect(plan.nodes[1]!.riskScore).toBe(0);
  });

  test('multiple risk files matching same node accumulate', () => {
    const risks: CausalRiskEntry[] = [
      { filePath: 'src/a.ts', breakProbability: 0.3, causalChain: [] },
      { filePath: 'src/b.ts', breakProbability: 0.4, causalChain: [] },
    ];
    const plan: TaskDAG = {
      nodes: [makePlanNode('x', ['src/a.ts', 'src/b.ts']), makePlanNode('y', ['src/c.ts'])],
    };
    const fp = makeOutcomePrediction({ causalRiskFiles: risks });
    scorePlanByPrediction(plan, fp);
    // Node x targets both a.ts and b.ts \u2192 0.3 + 0.4 = 0.7
    expect(plan.nodes[0]!.riskScore).toBeCloseTo(0.7, 5);
    expect(plan.nodes[0]!.id).toBe('x');
  });
});
