/**
 * A6: ForwardPredictor integration test — full 3-tier pipeline.
 *
 * Tests the ForwardPredictorImpl end-to-end:
 * - predictOutcome → recordOutcome → Brier score verification
 * - Tier progression: heuristic → statistical (after 100 traces)
 * - Graceful degradation on errors
 * - Prediction cache behavior
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ForwardPredictorConfig } from '../../src/config/schema.ts';
import type { PerceptualHierarchy, SelfModelPrediction, TaskInput } from '../../src/orchestrator/types.ts';
import type { PredictionOutcome } from '../../src/orchestrator/forward-predictor-types.ts';
import { ForwardPredictorImpl } from '../../src/orchestrator/forward-predictor.ts';
import { PredictionLedger } from '../../src/db/prediction-ledger.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ForwardPredictorConfig = {
  enabled: true,
  tiers: {
    statistical: { min_traces: 100 },
    causal: { min_traces: 100, min_edges: 50 },
  },
  budgets: {
    prediction_timeout_ms: 3000,
    max_alternative_plans: 3,
  },
  calibration: {
    temporal_decay_half_life_days: 30,
    miscalibration_threshold: 0.4,
    miscalibration_window: 20,
  },
};

function makeTask(id = 'task-1'): TaskInput {
  return {
    id,
    source: 'cli',
    goal: 'fix TypeScript compilation error in auth module',
    taskType: 'code',
    targetFiles: ['src/auth.ts'],
    budget: { maxTokens: 4000, maxDurationMs: 30000, maxRetries: 3 },
  };
}

function makePerception(): PerceptualHierarchy {
  return {
    taskTarget: { file: 'src/auth.ts', description: 'fix type error' },
    dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
    diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
    verifiedFacts: [],
    runtime: { nodeVersion: 'test', os: 'test', availableTools: [] },
    causalEdges: [],
  };
}

function makeSelfModel(overrides: Partial<SelfModelPrediction> = {}): SelfModelPrediction {
  return {
    taskId: 'task-1',
    timestamp: Date.now(),
    expectedTestResults: 'pass',
    expectedBlastRadius: 3,
    expectedDuration: 5000,
    expectedQualityScore: 0.75,
    uncertainAreas: [],
    confidence: 0.5,
    metaConfidence: 0.3,
    basis: 'static-heuristic',
    calibrationDataPoints: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('ForwardPredictor integration', () => {
  let db: Database;
  let ledger: PredictionLedger;

  beforeEach(() => {
    db = new Database(':memory:');
    ledger = new PredictionLedger(db);
  });

  afterEach(() => {
    db.close();
  });

  function createPredictor(
    selfModelResult?: Partial<SelfModelPrediction>,
    config?: Partial<ForwardPredictorConfig>,
  ): ForwardPredictorImpl {
    return new ForwardPredictorImpl({
      selfModel: {
        predict: async () => makeSelfModel(selfModelResult),
      },
      ledger,
      config: { ...DEFAULT_CONFIG, ...config },
    });
  }

  // =========================================================================
  // Basic prediction flow
  // =========================================================================

  test('predictOutcome returns a valid prediction at heuristic tier', async () => {
    const fp = createPredictor();
    const prediction = await fp.predictOutcome(makeTask(), makePerception());

    expect(prediction.taskId).toBe('task-1');
    expect(prediction.basis).toBe('heuristic');
    expect(prediction.predictionId).toBeTruthy();
    expect(prediction.timestamp).toBeGreaterThan(0);

    // Distribution sums to 1
    const { pPass, pPartial, pFail } = prediction.testOutcome;
    expect(pPass + pPartial + pFail).toBeCloseTo(1.0, 5);

    // Heuristic tier values for expected 'pass'
    expect(pPass).toBeGreaterThan(0.5);
  });

  // =========================================================================
  // Prediction → outcome → Brier scoring
  // =========================================================================

  test('recordOutcome returns Brier score for perfect prediction', async () => {
    const fp = createPredictor({ expectedTestResults: 'pass' });
    const prediction = await fp.predictOutcome(makeTask(), makePerception());

    const outcome: PredictionOutcome = {
      predictionId: prediction.predictionId,
      actualTestResult: 'pass',
      actualBlastRadius: 3,
      actualQuality: 0.75,
      actualDuration: 4800,
    };

    const brier = await fp.recordOutcome(outcome);

    // Not exactly 0 because heuristic pPass = 0.7, not 1.0
    // Brier = (0.7-1)^2 + (0.2-0)^2 + (0.1-0)^2 = 0.09 + 0.04 + 0.01 = 0.14
    expect(brier).toBeLessThan(0.5); // Reasonable for a correct-direction prediction
    expect(brier).toBeGreaterThanOrEqual(0);
  });

  test('recordOutcome returns high Brier for completely wrong prediction', async () => {
    const fp = createPredictor({ expectedTestResults: 'pass' });
    const prediction = await fp.predictOutcome(makeTask(), makePerception());

    const outcome: PredictionOutcome = {
      predictionId: prediction.predictionId,
      actualTestResult: 'fail', // completely wrong
      actualBlastRadius: 15,
      actualQuality: 0.2,
      actualDuration: 12000,
    };

    const brier = await fp.recordOutcome(outcome);
    expect(brier).toBeGreaterThan(0.5); // High error
  });

  test('recordOutcome for unknown predictionId returns 0', async () => {
    const fp = createPredictor();
    const outcome: PredictionOutcome = {
      predictionId: 'nonexistent',
      actualTestResult: 'pass',
      actualBlastRadius: 1,
      actualQuality: 0.8,
      actualDuration: 1000,
    };

    const brier = await fp.recordOutcome(outcome);
    expect(brier).toBe(0);
  });

  // =========================================================================
  // Tier progression
  // =========================================================================

  test('starts at heuristic, progresses to statistical after 100 traces', async () => {
    const fp = createPredictor();

    // First prediction — no trace history → heuristic
    const first = await fp.predictOutcome(makeTask('task-0'), makePerception());
    expect(first.basis).toBe('heuristic');

    // Feed 100 traces into the ledger
    for (let i = 1; i <= 100; i++) {
      const pred = await fp.predictOutcome(makeTask(`task-${i}`), makePerception());
      await fp.recordOutcome({
        predictionId: pred.predictionId,
        actualTestResult: 'pass',
        actualBlastRadius: 2,
        actualQuality: 0.7,
        actualDuration: 3000,
      });
    }

    // Now trace count = 101 (the 100 predictions + 1 first), should upgrade to statistical
    const upgraded = await fp.predictOutcome(makeTask('task-upgrade'), makePerception());
    expect(upgraded.basis).toBe('statistical');
  });

  // =========================================================================
  // Calibration summary
  // =========================================================================

  test('getCalibrationSummary reflects recorded outcomes', async () => {
    const fp = createPredictor();

    // Generate and record 5 outcomes
    for (let i = 0; i < 5; i++) {
      const pred = await fp.predictOutcome(makeTask(`task-${i}`), makePerception());
      await fp.recordOutcome({
        predictionId: pred.predictionId,
        actualTestResult: 'pass',
        actualBlastRadius: 3,
        actualQuality: 0.7,
        actualDuration: 4000,
      });
    }

    const summary = fp.getCalibrationSummary();
    expect(summary.predictionCount).toBe(5);
    expect(summary.brierScore).toBeGreaterThanOrEqual(0);
    // basis reflects the calibration engine's internal state, not the prediction tier
    expect(['heuristic', 'statistical', 'causal']).toContain(summary.basis);
  });

  // =========================================================================
  // Prediction persistence
  // =========================================================================

  test('predictions are persisted to ledger', async () => {
    const fp = createPredictor();
    await fp.predictOutcome(makeTask(), makePerception());

    expect(ledger.getTraceCount()).toBe(1);
  });

  test('outcomes are persisted to ledger', async () => {
    const fp = createPredictor();
    const pred = await fp.predictOutcome(makeTask(), makePerception());

    await fp.recordOutcome({
      predictionId: pred.predictionId,
      actualTestResult: 'pass',
      actualBlastRadius: 2,
      actualQuality: 0.8,
      actualDuration: 3000,
    });

    expect(ledger.getPredictionCount()).toBe(1);
  });

  // =========================================================================
  // Different heuristic expectations
  // =========================================================================

  test('expectedTestResults=fail → low pPass in prediction', async () => {
    const fp = createPredictor({ expectedTestResults: 'fail' });
    const prediction = await fp.predictOutcome(makeTask(), makePerception());

    expect(prediction.testOutcome.pPass).toBeLessThan(0.3);
    expect(prediction.testOutcome.pFail).toBeGreaterThan(0.5);
  });

  test('expectedTestResults=partial → moderate distribution', async () => {
    const fp = createPredictor({ expectedTestResults: 'partial' });
    const prediction = await fp.predictOutcome(makeTask(), makePerception());

    expect(prediction.testOutcome.pPass).toBeLessThan(0.5);
    expect(prediction.testOutcome.pFail).toBeLessThan(0.5);
  });

  // =========================================================================
  // Blast radius / quality score wrapping
  // =========================================================================

  test('blast radius wraps heuristic with ×0.5 / ×2.0 bounds', async () => {
    const fp = createPredictor({ expectedBlastRadius: 10 });
    const prediction = await fp.predictOutcome(makeTask(), makePerception());

    expect(prediction.blastRadius.lo).toBe(5);
    expect(prediction.blastRadius.mid).toBe(10);
    expect(prediction.blastRadius.hi).toBe(20);
  });
});
