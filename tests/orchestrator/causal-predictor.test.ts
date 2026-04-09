import { describe, expect, test } from 'bun:test';
import { CausalPredictorImpl } from '../../src/orchestrator/prediction/causal-predictor.ts';
import type { CausalEdge, FileOutcomeStat, CausalEdgeType } from '../../src/orchestrator/forward-predictor-types.ts';
import { CAUSAL_EDGE_WEIGHTS } from '../../src/orchestrator/forward-predictor-types.ts';

function makeEdge(
  fromFile: string,
  toFile: string,
  edgeType: CausalEdgeType = 'imports',
  confidence = 1.0,
): CausalEdge {
  return {
    fromFile,
    toFile,
    edgeType,
    confidence,
    source: 'static',
  };
}

function makeFileStat(filePath: string, successCount: number, failCount: number): FileOutcomeStat {
  return {
    filePath,
    successCount,
    failCount,
    partialCount: 0,
    samples: successCount + failCount,
    avgQuality: 70,
  };
}

describe('CausalPredictor', () => {
  const predictor = new CausalPredictorImpl();

  // =========================================================================
  // Empty / trivial inputs
  // =========================================================================

  test('empty edges → zero risk, unchanged pPass', () => {
    const result = predictor.computeRisks(['src/a.ts'], [], [], 0.8);
    expect(result.adjustedPPass).toBe(0.8);
    expect(result.aggregateRisk).toBe(0);
    expect(result.riskFiles).toHaveLength(0);
  });

  test('no dependents of target → zero risk', () => {
    // Edges exist but not from target files
    const edges = [makeEdge('src/x.ts', 'src/y.ts')];
    const result = predictor.computeRisks(['src/a.ts'], edges, [], 0.8);
    expect(result.adjustedPPass).toBe(0.8);
    expect(result.aggregateRisk).toBe(0);
  });

  // =========================================================================
  // BFS correctness: single chain A → B → C
  // =========================================================================

  test('BFS: A→B→C chain with known weights', () => {
    const edges = [
      makeEdge('src/a.ts', 'src/b.ts', 'calls-method'),
      makeEdge('src/b.ts', 'src/c.ts', 'uses-type'),
    ];
    const fileStats = [
      makeFileStat('src/b.ts', 5, 5), // 50% fail rate
      makeFileStat('src/c.ts', 8, 2), // 20% fail rate
    ];

    const result = predictor.computeRisks(['src/a.ts'], edges, fileStats, 0.8);

    // B: pathWeight = calls-method weight (0.6), failRate = 0.5
    //    breakProb = 0.6 * 0.5 = 0.3
    const riskB = result.riskFiles.find((r) => r.filePath === 'src/b.ts');
    expect(riskB).toBeDefined();
    expect(riskB!.breakProbability).toBeCloseTo(0.3, 2);

    // C: pathWeight = calls-method * uses-type = 0.6 * 0.4 = 0.24, failRate = 0.2
    //    breakProb = 0.24 * 0.2 = 0.048
    const riskC = result.riskFiles.find((r) => r.filePath === 'src/c.ts');
    expect(riskC).toBeDefined();
    expect(riskC!.breakProbability).toBeCloseTo(0.048, 2);

    // Aggregate risk = 1 - (1-0.3)(1-0.048) = 1 - 0.7*0.952 = 1 - 0.6664 = 0.3336
    expect(result.aggregateRisk).toBeCloseTo(0.3336, 2);

    // Adjusted P(pass) = 0.8 * (1 - 0.3336) ≈ 0.533
    expect(result.adjustedPPass).toBeCloseTo(0.8 * (1 - result.aggregateRisk), 2);
  });

  // =========================================================================
  // Cycle detection
  // =========================================================================

  test('cycle A→B→A does not infinite loop', () => {
    const edges = [
      makeEdge('src/a.ts', 'src/b.ts', 'imports'),
      makeEdge('src/b.ts', 'src/a.ts', 'imports'), // cycle back
    ];

    // Should complete without hanging
    const result = predictor.computeRisks(['src/a.ts'], edges, [], 0.8);
    // B should be found; A should not be in risk files (it's a target file)
    const filesAtRisk = result.riskFiles.map((r) => r.filePath);
    expect(filesAtRisk).toContain('src/b.ts');
    expect(result.aggregateRisk).toBeGreaterThan(0);
  });

  // =========================================================================
  // MAX_BFS_DEPTH = 3 enforcement
  // =========================================================================

  test('BFS depth capped at 3 — does not traverse to depth 4', () => {
    // Chain: A → B → C → D → E (depth 4 from A)
    const edges = [
      makeEdge('src/a.ts', 'src/b.ts', 'imports'),
      makeEdge('src/b.ts', 'src/c.ts', 'imports'),
      makeEdge('src/c.ts', 'src/d.ts', 'imports'),
      makeEdge('src/d.ts', 'src/e.ts', 'imports'),
    ];
    const fileStats = [
      makeFileStat('src/b.ts', 5, 5),
      makeFileStat('src/c.ts', 5, 5),
      makeFileStat('src/d.ts', 5, 5),
      makeFileStat('src/e.ts', 5, 5),
    ];

    const result = predictor.computeRisks(['src/a.ts'], edges, fileStats, 0.8);

    const filesAtRisk = result.riskFiles.map((r) => r.filePath);
    expect(filesAtRisk).toContain('src/b.ts'); // depth 1
    expect(filesAtRisk).toContain('src/c.ts'); // depth 2
    expect(filesAtRisk).toContain('src/d.ts'); // depth 3
    // E should NOT be reached (depth 4 > MAX_BFS_DEPTH=3)
    expect(filesAtRisk).not.toContain('src/e.ts');
  });

  // =========================================================================
  // MAX_RISK_FILES = 10 top-K ranking
  // =========================================================================

  test('returns at most 10 risk files (MAX_RISK_FILES)', () => {
    // Create 15 direct dependents of A
    const edges = Array.from({ length: 15 }, (_, i) =>
      makeEdge('src/a.ts', `src/dep-${i}.ts`, 'imports'),
    );
    const fileStats = Array.from({ length: 15 }, (_, i) =>
      makeFileStat(`src/dep-${i}.ts`, 5, 5),
    );

    const result = predictor.computeRisks(['src/a.ts'], edges, fileStats, 0.8);
    expect(result.riskFiles.length).toBeLessThanOrEqual(10);
  });

  test('top-K keeps highest break probability files', () => {
    // 12 dependents with varying fail rates
    const edges = Array.from({ length: 12 }, (_, i) =>
      makeEdge('src/a.ts', `src/dep-${i}.ts`, 'calls-method'),
    );
    const fileStats = Array.from({ length: 12 }, (_, i) =>
      makeFileStat(`src/dep-${i}.ts`, 10 - i, i), // dep-0: 0% fail, dep-11: ~100% fail
    );

    const result = predictor.computeRisks(['src/a.ts'], edges, fileStats, 0.8);

    // Should be sorted descending by breakProbability
    for (let i = 1; i < result.riskFiles.length; i++) {
      expect(result.riskFiles[i - 1]!.breakProbability).toBeGreaterThanOrEqual(
        result.riskFiles[i]!.breakProbability,
      );
    }
  });

  // =========================================================================
  // Edge type weight application
  // =========================================================================

  test('test-covers edge has highest weight (0.95)', () => {
    const edges = [
      makeEdge('src/a.ts', 'src/test.ts', 'test-covers'),
      makeEdge('src/a.ts', 'src/imp.ts', 'imports'),
    ];
    const fileStats = [
      makeFileStat('src/test.ts', 5, 5), // 50% fail
      makeFileStat('src/imp.ts', 5, 5),  // 50% fail
    ];

    const result = predictor.computeRisks(['src/a.ts'], edges, fileStats, 0.8);

    const testRisk = result.riskFiles.find((r) => r.filePath === 'src/test.ts');
    const impRisk = result.riskFiles.find((r) => r.filePath === 'src/imp.ts');

    expect(testRisk).toBeDefined();
    expect(impRisk).toBeDefined();

    // test-covers (0.95) * 0.5 = 0.475 vs imports (0.20) * 0.5 = 0.10
    expect(testRisk!.breakProbability).toBeGreaterThan(impRisk!.breakProbability);
    expect(testRisk!.breakProbability).toBeCloseTo(0.475, 2);
    expect(impRisk!.breakProbability).toBeCloseTo(0.10, 2);
  });

  // =========================================================================
  // Aggregate risk formula
  // =========================================================================

  test('aggregate risk: P(>=1 break) = 1 - ∏(1 - P(break_i))', () => {
    const edges = [
      makeEdge('src/a.ts', 'src/b.ts', 'calls-method'),
      makeEdge('src/a.ts', 'src/c.ts', 'calls-method'),
    ];
    const fileStats = [
      makeFileStat('src/b.ts', 5, 5), // 50% fail
      makeFileStat('src/c.ts', 8, 2), // 20% fail
    ];

    const result = predictor.computeRisks(['src/a.ts'], edges, fileStats, 0.8);

    // B: 0.6 * 0.5 = 0.3
    // C: 0.6 * 0.2 = 0.12
    // Aggregate: 1 - (1-0.3)(1-0.12) = 1 - 0.7*0.88 = 1 - 0.616 = 0.384
    expect(result.aggregateRisk).toBeCloseTo(0.384, 2);
  });

  // =========================================================================
  // Default fail rate
  // =========================================================================

  test('files without stats get default fail rate (0.1)', () => {
    const edges = [makeEdge('src/a.ts', 'src/unknown.ts', 'calls-method')];
    // No file stats for unknown.ts

    const result = predictor.computeRisks(['src/a.ts'], edges, [], 0.8);

    const risk = result.riskFiles.find((r) => r.filePath === 'src/unknown.ts');
    expect(risk).toBeDefined();
    // calls-method (0.6) * default_fail_rate (0.1) = 0.06
    expect(risk!.breakProbability).toBeCloseTo(0.06, 2);
  });

  // =========================================================================
  // Causal chain tracking
  // =========================================================================

  test('causal chain records the traversal path', () => {
    const edges = [
      makeEdge('src/a.ts', 'src/b.ts', 'calls-method'),
      makeEdge('src/b.ts', 'src/c.ts', 'uses-type'),
    ];

    const result = predictor.computeRisks(['src/a.ts'], edges, [], 0.8);

    const riskC = result.riskFiles.find((r) => r.filePath === 'src/c.ts');
    expect(riskC).toBeDefined();
    expect(riskC!.causalChain).toHaveLength(2);
    expect(riskC!.causalChain[0]!.fromFile).toBe('src/a.ts');
    expect(riskC!.causalChain[0]!.toFile).toBe('src/b.ts');
    expect(riskC!.causalChain[1]!.fromFile).toBe('src/b.ts');
    expect(riskC!.causalChain[1]!.toFile).toBe('src/c.ts');
  });

  // =========================================================================
  // Historical success rate population
  // =========================================================================

  test('historicalSuccessRate is populated from file stats', () => {
    const edges = [makeEdge('src/a.ts', 'src/b.ts', 'imports')];
    const fileStats = [makeFileStat('src/b.ts', 7, 3)]; // 70% success

    const result = predictor.computeRisks(['src/a.ts'], edges, fileStats, 0.8);

    const risk = result.riskFiles.find((r) => r.filePath === 'src/b.ts');
    expect(risk?.historicalSuccessRate).toBeCloseTo(0.7, 2);
  });

  // =========================================================================
  // Learned weights
  // =========================================================================

  test('uses learned weights when converged', () => {
    const edges = [makeEdge('src/a.ts', 'src/b.ts', 'imports')];
    const fileStats = [makeFileStat('src/b.ts', 5, 5)]; // 50% fail

    const learnedWeights = {
      weights: { ...CAUSAL_EDGE_WEIGHTS, imports: 0.8 }, // much higher than default 0.2
      observationCount: 300,
      converged: true,
    };

    const result = predictor.computeRisks(['src/a.ts'], edges, fileStats, 0.8, learnedWeights);

    // With learned weight 0.8: breakProb = 0.8 * 0.5 = 0.4
    const risk = result.riskFiles.find((r) => r.filePath === 'src/b.ts');
    expect(risk!.breakProbability).toBeCloseTo(0.4, 2);
  });

  // =========================================================================
  // Multiple target files
  // =========================================================================

  test('multiple target files seed BFS from all targets', () => {
    const edges = [
      makeEdge('src/a.ts', 'src/shared.ts', 'imports'),
      makeEdge('src/b.ts', 'src/other.ts', 'imports'),
    ];

    const result = predictor.computeRisks(['src/a.ts', 'src/b.ts'], edges, [], 0.8);

    const filesAtRisk = result.riskFiles.map((r) => r.filePath);
    expect(filesAtRisk).toContain('src/shared.ts');
    expect(filesAtRisk).toContain('src/other.ts');
  });

  // =========================================================================
  // P(pass) adjustment
  // =========================================================================

  test('adjustedPPass = tier2PPass × (1 - aggregateRisk)', () => {
    const edges = [makeEdge('src/a.ts', 'src/b.ts', 'test-covers')];
    const fileStats = [makeFileStat('src/b.ts', 0, 10)]; // 100% fail

    const result = predictor.computeRisks(['src/a.ts'], edges, fileStats, 0.8);

    // breakProb = 0.95 * 1.0 = 0.95. Aggregate = 0.95.
    // adjustedPPass = 0.8 * (1 - 0.95) = 0.04
    expect(result.adjustedPPass).toBeCloseTo(0.8 * (1 - result.aggregateRisk), 3);
  });
});
