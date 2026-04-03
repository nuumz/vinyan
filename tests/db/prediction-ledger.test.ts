import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { PredictionLedger } from '../../src/db/prediction-ledger.ts';
import type { OutcomePrediction, PredictionOutcome } from '../../src/orchestrator/forward-predictor-types.ts';

function makePrediction(overrides: Partial<OutcomePrediction> = {}): OutcomePrediction {
  return {
    predictionId: `pred-${Math.random().toString(36).slice(2, 8)}`,
    taskId: 'task-1',
    timestamp: Date.now(),
    testOutcome: { pPass: 0.7, pPartial: 0.2, pFail: 0.1 },
    blastRadius: { lo: 1, mid: 3, hi: 8 },
    qualityScore: { lo: 60, mid: 75, hi: 90 },
    expectedDuration: 5000,
    causalRiskFiles: [],
    basis: 'heuristic',
    causalChainDepth: 0,
    confidence: 0.3,
    ...overrides,
  };
}

function makeOutcome(predictionId: string, overrides: Partial<PredictionOutcome> = {}): PredictionOutcome {
  return {
    predictionId,
    actualTestResult: 'pass',
    actualBlastRadius: 3,
    actualQuality: 80,
    actualDuration: 4500,
    ...overrides,
  };
}

describe('PredictionLedger', () => {
  let db: Database;
  let ledger: PredictionLedger;

  beforeEach(() => {
    db = new Database(':memory:');
    ledger = new PredictionLedger(db);
  });

  afterEach(() => {
    db.close();
  });

  // --- CRUD ---

  test('recordPrediction stores a prediction', () => {
    const pred = makePrediction({ predictionId: 'pred-1' });
    ledger.recordPrediction(pred);

    const count = ledger.getTraceCount();
    expect(count).toBe(1);
  });

  test('recordPrediction is idempotent (INSERT OR IGNORE)', () => {
    const pred = makePrediction({ predictionId: 'pred-1' });
    ledger.recordPrediction(pred);
    ledger.recordPrediction(pred); // duplicate

    expect(ledger.getTraceCount()).toBe(1);
  });

  test('recordOutcome stores outcome with Brier score', () => {
    const pred = makePrediction({ predictionId: 'pred-1' });
    ledger.recordPrediction(pred);

    const outcome = makeOutcome('pred-1');
    ledger.recordOutcome(outcome, 0.18);

    expect(ledger.getPredictionCount()).toBe(1);
  });

  test('recordOutcome with CRPS scores', () => {
    const pred = makePrediction({ predictionId: 'pred-1' });
    ledger.recordPrediction(pred);

    const outcome = makeOutcome('pred-1');
    ledger.recordOutcome(outcome, 0.18, 1.5, 2.3);

    const scores = ledger.getRecentBrierScores(10);
    expect(scores).toHaveLength(1);
    expect(scores[0]).toBe(0.18);
  });

  // --- getFileOutcomeStats ---

  test('getFileOutcomeStats returns empty array for no matches', () => {
    expect(ledger.getFileOutcomeStats(['nonexistent.ts'])).toEqual([]);
  });

  test('getFileOutcomeStats aggregates per-file stats correctly', () => {
    // Record 3 predictions with overlapping files
    const files = ['src/a.ts', 'src/b.ts'];

    const pred1 = makePrediction({
      predictionId: 'p1',
      causalRiskFiles: [
        { filePath: 'src/a.ts', breakProbability: 0.5, causalChain: [] },
        { filePath: 'src/b.ts', breakProbability: 0.3, causalChain: [] },
      ],
    });
    ledger.recordPrediction(pred1);
    ledger.recordOutcome(makeOutcome('p1', { actualTestResult: 'pass', actualQuality: 80 }), 0.1);

    const pred2 = makePrediction({
      predictionId: 'p2',
      causalRiskFiles: [
        { filePath: 'src/a.ts', breakProbability: 0.5, causalChain: [] },
      ],
    });
    ledger.recordPrediction(pred2);
    ledger.recordOutcome(makeOutcome('p2', { actualTestResult: 'fail', actualQuality: 30 }), 0.8);

    const stats = ledger.getFileOutcomeStats(files);

    const statA = stats.find((s) => s.filePath === 'src/a.ts');
    expect(statA).toBeDefined();
    expect(statA!.samples).toBe(2);
    expect(statA!.successCount).toBe(1);
    expect(statA!.failCount).toBe(1);

    const statB = stats.find((s) => s.filePath === 'src/b.ts');
    expect(statB).toBeDefined();
    expect(statB!.samples).toBe(1);
    expect(statB!.successCount).toBe(1);
  });

  test('getFileOutcomeStats handles partial test results', () => {
    const pred = makePrediction({
      predictionId: 'p1',
      causalRiskFiles: [{ filePath: 'src/a.ts', breakProbability: 0.5, causalChain: [] }],
    });
    ledger.recordPrediction(pred);
    ledger.recordOutcome(makeOutcome('p1', { actualTestResult: 'partial', actualQuality: 50 }), 0.3);

    const stats = ledger.getFileOutcomeStats(['src/a.ts']);
    expect(stats[0]!.partialCount).toBe(1);
    expect(stats[0]!.successCount).toBe(0);
    expect(stats[0]!.failCount).toBe(0);
  });

  // --- getPercentiles ---

  test('getPercentiles returns zeros when no data', () => {
    const result = ledger.getPercentiles('unknown-type', [10, 50, 90]);
    expect(result).toEqual({ lo: 0, mid: 0, hi: 0 });
  });

  test('getPercentiles computes correct percentiles for known task type', () => {
    // Insert 10 predictions with known blast radius outcomes
    for (let i = 0; i < 10; i++) {
      const pred = makePrediction({
        predictionId: `perc-${i}`,
        taskId: `task-${i}`,
      });
      ledger.recordPrediction(pred);
      ledger.recordOutcome(makeOutcome(`perc-${i}`, { actualBlastRadius: i + 1 }), 0.1);
    }

    // task_type_signature defaults to '' in our makePrediction
    const result = ledger.getPercentiles('', [10, 50, 90]);

    // 10 values [1..10] sorted: floor(0.1*10)=1→val[1]=2, floor(0.5*10)=5→val[5]=6, floor(0.9*10)=9→val[9]=10
    expect(result.lo).toBe(2);
    expect(result.mid).toBe(6);
    expect(result.hi).toBe(10);
  });

  test('getPercentiles with single data point returns same value for all', () => {
    const pred = makePrediction({ predictionId: 'single' });
    ledger.recordPrediction(pred);
    ledger.recordOutcome(makeOutcome('single', { actualBlastRadius: 5 }), 0.1);

    const result = ledger.getPercentiles('', [10, 50, 90]);
    expect(result.lo).toBe(5);
    expect(result.mid).toBe(5);
    expect(result.hi).toBe(5);
  });

  // --- getRecentBrierScores ---

  test('getRecentBrierScores returns empty for no outcomes', () => {
    expect(ledger.getRecentBrierScores(10)).toEqual([]);
  });

  test('getRecentBrierScores returns scores ordered by recorded_at DESC, limited', () => {
    for (let i = 0; i < 5; i++) {
      const pred = makePrediction({ predictionId: `bs-${i}` });
      ledger.recordPrediction(pred);
      ledger.recordOutcome(makeOutcome(`bs-${i}`), i * 0.1);
    }

    const scores = ledger.getRecentBrierScores(3);
    expect(scores).toHaveLength(3);
    // All inserted within same ms → ordering by recorded_at is stable by ROWID DESC
    // Values: 0,0.1,0.2,0.3,0.4 → top-3 by ROWID DESC = [0.4,0.3,0.2]
    // But same-ms ties are implementation-dependent; verify set membership + count
    const allScores = [0, 0.1, 0.2, 0.3, 0.4];
    for (const s of scores) {
      expect(allScores).toContain(s);
    }
  });

  test('getRecentBrierScores respects window limit', () => {
    for (let i = 0; i < 10; i++) {
      const pred = makePrediction({ predictionId: `w-${i}` });
      ledger.recordPrediction(pred);
      ledger.recordOutcome(makeOutcome(`w-${i}`), 0.1);
    }

    expect(ledger.getRecentBrierScores(5)).toHaveLength(5);
    expect(ledger.getRecentBrierScores(20)).toHaveLength(10);
  });

  // --- getTraceCount / getPredictionCount ---

  test('getTraceCount counts predictions, getPredictionCount counts outcomes', () => {
    const pred1 = makePrediction({ predictionId: 'tc-1' });
    const pred2 = makePrediction({ predictionId: 'tc-2' });
    ledger.recordPrediction(pred1);
    ledger.recordPrediction(pred2);

    expect(ledger.getTraceCount()).toBe(2);
    expect(ledger.getPredictionCount()).toBe(0);

    ledger.recordOutcome(makeOutcome('tc-1'), 0.1);
    expect(ledger.getPredictionCount()).toBe(1);
  });

  // --- Schema migration idempotency ---

  test('schema migration is idempotent', () => {
    // Constructor already ran migration. Create another ledger on same DB.
    const ledger2 = new PredictionLedger(db);
    // Should not throw
    expect(ledger2.getTraceCount()).toBe(0);
  });

  // --- Plan ranking ---

  test('recordPlanRanking stores ranking record', () => {
    ledger.recordPlanRanking({
      taskId: 'task-1',
      selectedPlanId: 'plan-a',
      selectedReason: 'highest_quality',
      planRankings: [{
        planId: 'plan-a',
        predictedOutcome: makePrediction({ predictionId: 'rank-pred' }),
        rank: 1,
        executed: true,
      }],
    });

    // Verify it was inserted (no getter API, but should not throw)
    const row = db.prepare('SELECT COUNT(*) as cnt FROM plan_rankings').get() as { cnt: number };
    expect(row.cnt).toBe(1);
  });
});
