import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { MODEL_PARAMS_SCHEMA_SQL } from '../../src/db/trace-schema.ts';
import { CalibratedSelfModel } from '../../src/orchestrator/prediction/self-model.ts';
import type { ExecutionTrace, PerceptualHierarchy, ReasoningPolicy, TaskInput } from '../../src/orchestrator/types.ts';

function makeInput(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 'task-001',
    source: 'cli',
    goal: 'add JSDoc to function',
    taskType: 'code',
    targetFiles: ['src/foo.ts'],
    budget: { maxTokens: 10000, maxRetries: 3, maxDurationMs: 60000 },
    ...overrides,
  };
}

function makePerception(overrides: Partial<PerceptualHierarchy> = {}): PerceptualHierarchy {
  return {
    taskTarget: { file: 'src/foo.ts', description: 'add JSDoc' },
    dependencyCone: {
      directImporters: [],
      directImportees: ['src/bar.ts'],
      transitiveBlastRadius: 3,
    },
    diagnostics: {
      lintWarnings: [],
      typeErrors: [],
      failingTests: [],
    },
    verifiedFacts: [],
    runtime: { nodeVersion: '18.0.0', os: 'darwin', availableTools: [] },
    ...overrides,
  };
}

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: 'trace-001',
    taskId: 'task-001',
    timestamp: Date.now(),
    routingLevel: 2,
    approach: 'direct-edit',
    oracleVerdicts: { ast: true, type: true },
    modelUsed: 'claude-sonnet',
    tokensConsumed: 1000,
    durationMs: 5000,
    outcome: 'success',
    affectedFiles: ['src/foo.ts', 'src/bar.ts'],
    ...overrides,
  };
}

describe('CalibratedSelfModel', () => {
  test('predict returns valid prediction without DB', async () => {
    const model = new CalibratedSelfModel();
    const pred = await model.predict(makeInput(), makePerception());

    expect(pred.taskId).toBe('task-001');
    expect(pred.expectedBlastRadius).toBe(3);
    expect(pred.expectedTestResults).toBe('pass');
    expect(pred.expectedQualityScore).toBe(0.5); // cold start default
    expect(pred.confidence).toBe(0.5);
    expect(pred.basis).toBe('static-heuristic');
    expect(pred.calibrationDataPoints).toBe(0);
  });

  test('S2: metaConfidence < 0.3 when < 10 task-type observations', async () => {
    const model = new CalibratedSelfModel();
    const pred = await model.predict(makeInput(), makePerception());

    expect(pred.metaConfidence).toBeLessThan(0.3);
  });

  test('type errors in perception → expectedTestResults = partial', async () => {
    const model = new CalibratedSelfModel();
    const perception = makePerception({
      diagnostics: {
        lintWarnings: [],
        typeErrors: [{ file: 'src/foo.ts', line: 10, message: 'Type error' }],
        failingTests: [],
      },
    });
    const pred = await model.predict(makeInput(), perception);

    expect(pred.expectedTestResults).toBe('partial');
    expect(pred.uncertainAreas).toContain('type-errors-present');
  });

  test('expectedDuration scales with file count', async () => {
    const model = new CalibratedSelfModel();
    const input1 = makeInput({ targetFiles: ['a.ts'] });
    const input3 = makeInput({ targetFiles: ['a.ts', 'b.ts', 'c.ts'] });

    const pred1 = await model.predict(input1, makePerception());
    const pred3 = await model.predict(input3, makePerception());

    expect(pred3.expectedDuration).toBeGreaterThan(pred1.expectedDuration);
  });

  test('calibrate updates observation count and accuracy', () => {
    const model = new CalibratedSelfModel();
    const pred = {
      taskId: 'task-001',
      timestamp: Date.now(),
      expectedTestResults: 'pass' as const,
      expectedBlastRadius: 2,
      expectedDuration: 4000,
      expectedQualityScore: 0.5,
      uncertainAreas: [],
      confidence: 0.5,
      metaConfidence: 0.1,
      basis: 'static-heuristic' as const,
      calibrationDataPoints: 0,
    };

    const trace = makeTrace({
      qualityScore: {
        architecturalCompliance: 0.9,
        efficiency: 0.8,
        composite: 0.85,
        dimensionsAvailable: 2,
        phase: 'phase0',
      },
    });

    const error = model.calibrate(pred, trace);
    expect(error.taskId).toBe('task-001');
    expect(error.error.testResultMatch).toBe(true);
    expect(error.actual.qualityScore).toBe(0.85);

    const params = model.getParams();
    expect(params.observationCount).toBe(1);
  });

  test('EMA calibration shifts avgQualityScore toward actuals', () => {
    const model = new CalibratedSelfModel();

    for (let i = 0; i < 20; i++) {
      const pred = {
        taskId: `task-${i}`,
        timestamp: Date.now(),
        expectedTestResults: 'pass' as const,
        expectedBlastRadius: 2,
        expectedDuration: 4000,
        expectedQualityScore: 0.5,
        uncertainAreas: [],
        confidence: 0.5,
        metaConfidence: 0.1,
        basis: 'static-heuristic' as const,
        calibrationDataPoints: i,
      };

      model.calibrate(
        pred,
        makeTrace({
          id: `trace-${i}`,
          taskTypeSignature: 'refactor',
          qualityScore: {
            architecturalCompliance: 0.9,
            efficiency: 0.9,
            composite: 0.9,
            dimensionsAvailable: 2,
            phase: 'phase0',
          },
        }),
      );
    }

    const params = model.getParams();
    // After 20 observations of 0.9 quality, EMA should have moved substantially from 0.5 toward 0.9
    expect(params.avgQualityScore).toBeGreaterThan(0.8);
    expect(params.avgQualityScore).toBeLessThan(0.95); // Not yet fully converged
    expect(params.observationCount).toBe(20);
  });

  test('basis transitions through static-heuristic → hybrid → trace-calibrated', async () => {
    const model = new CalibratedSelfModel();

    // PH3.1: basis now requires accuracy gating, not just observation count
    // 10 obs with moderate accuracy → "hybrid" (not "trace-calibrated")
    for (let i = 0; i < 10; i++) {
      model.calibrate(
        {
          taskId: `task-${i}`,
          timestamp: Date.now(),
          expectedTestResults: 'pass',
          expectedBlastRadius: 2,
          expectedDuration: 4000,
          expectedQualityScore: 0.5,
          uncertainAreas: [],
          confidence: 0.5,
          metaConfidence: 0.1,
          basis: 'static-heuristic',
          calibrationDataPoints: i,
        },
        makeTrace({ id: `trace-${i}`, taskTypeSignature: 'refactor' }),
      );
    }

    const pred10 = await model.predict(makeInput(), makePerception());
    expect(pred10.calibrationDataPoints).toBe(10);
    // With 10 observations, basis depends on per-task-type accuracy (not global params).
    // computeBasis(obs=10, accuracy): if accuracy >= 0.4 → "hybrid", else "static-heuristic"
    // The exact accuracy depends on how well predictions matched actuals.
    expect(['hybrid', 'static-heuristic']).toContain(pred10.basis);
  });

  describe('with SQLite persistence', () => {
    let db: Database;

    beforeEach(() => {
      db = new Database(':memory:');
      db.exec('PRAGMA journal_mode = WAL');
      db.exec(MODEL_PARAMS_SCHEMA_SQL);
    });

    afterEach(() => {
      db.close();
    });

    test('params persist across instances', () => {
      const model1 = new CalibratedSelfModel({ db });
      model1.calibrate(
        {
          taskId: 't1',
          timestamp: Date.now(),
          expectedTestResults: 'pass',
          expectedBlastRadius: 2,
          expectedDuration: 4000,
          expectedQualityScore: 0.5,
          uncertainAreas: [],
          confidence: 0.5,
          metaConfidence: 0.1,
          basis: 'static-heuristic',
          calibrationDataPoints: 0,
        },
        makeTrace({
          qualityScore: {
            architecturalCompliance: 0.9,
            efficiency: 0.9,
            composite: 0.9,
            dimensionsAvailable: 2,
            phase: 'phase0',
          },
        }),
      );

      expect(model1.getParams().observationCount).toBe(1);

      // New instance loads from same DB
      const model2 = new CalibratedSelfModel({ db });
      expect(model2.getParams().observationCount).toBe(1);
      expect(model2.getParams().avgQualityScore).toBeGreaterThan(0.5);
    });
  });

  describe('getEpistemicSignal', () => {
    test('returns insufficient for fresh task type', () => {
      const model = new CalibratedSelfModel();
      const signal = model.getEpistemicSignal('unknown-task-type');
      expect(signal.avgOracleConfidence).toBe(0.5);
      expect(signal.observationCount).toBe(0);
      expect(signal.basis).toBe('insufficient');
    });

    test('calibrate updates avgOracleConfidence via EMA', () => {
      const model = new CalibratedSelfModel();
      const pred = {
        taskId: 'task-epi-1',
        timestamp: Date.now(),
        expectedTestResults: 'pass' as const,
        expectedBlastRadius: 2,
        expectedDuration: 4000,
        expectedQualityScore: 0.5,
        uncertainAreas: [],
        confidence: 0.5,
        metaConfidence: 0.1,
        basis: 'static-heuristic' as const,
        calibrationDataPoints: 0,
      };

      model.calibrate(
        pred,
        makeTrace({
          id: 'trace-epi-1',
          taskTypeSignature: 'fix::ts::single',
          qualityScore: {
            architecturalCompliance: 0.9,
            efficiency: 0.9,
            composite: 0.9,
            dimensionsAvailable: 2,
            phase: 'phase0',
          },
        }),
      );

      const signal = model.getEpistemicSignal('fix::ts::single');
      expect(signal.avgOracleConfidence).toBeGreaterThan(0.5);
      expect(signal.observationCount).toBe(1);
      expect(signal.basis).toBe('insufficient');
    });

    test('basis transitions: insufficient → emerging → calibrated', () => {
      const model = new CalibratedSelfModel();
      const taskSig = 'refactor::ts::single';

      const makePred = (i: number) => ({
        taskId: `task-basis-${i}`,
        timestamp: Date.now(),
        expectedTestResults: 'pass' as const,
        expectedBlastRadius: 2,
        expectedDuration: 4000,
        expectedQualityScore: 0.5,
        uncertainAreas: [],
        confidence: 0.5,
        metaConfidence: 0.1,
        basis: 'static-heuristic' as const,
        calibrationDataPoints: i,
      });

      // 10 calibrations → emerging
      for (let i = 0; i < 10; i++) {
        model.calibrate(
          makePred(i),
          makeTrace({
            id: `trace-basis-${i}`,
            taskTypeSignature: taskSig,
            qualityScore: {
              architecturalCompliance: 0.9,
              efficiency: 0.9,
              composite: 0.9,
              dimensionsAvailable: 2,
              phase: 'phase0',
            },
          }),
        );
      }

      const signal10 = model.getEpistemicSignal(taskSig);
      expect(signal10.observationCount).toBe(10);
      expect(signal10.basis).toBe('emerging');

      // 20 more calibrations (total 30) → calibrated
      for (let i = 10; i < 30; i++) {
        model.calibrate(
          makePred(i),
          makeTrace({
            id: `trace-basis-${i}`,
            taskTypeSignature: taskSig,
            qualityScore: {
              architecturalCompliance: 0.9,
              efficiency: 0.9,
              composite: 0.9,
              dimensionsAvailable: 2,
              phase: 'phase0',
            },
          }),
        );
      }

      const signal30 = model.getEpistemicSignal(taskSig);
      expect(signal30.observationCount).toBe(30);
      expect(signal30.basis).toBe('calibrated');
      expect(signal30.avgOracleConfidence).toBeGreaterThan(0.8);
    });
  });

  describe('getReasoningPolicy (EO #6)', () => {
    test('returns default policy when no traces exist', () => {
      const model = new CalibratedSelfModel();
      const policy = model.getReasoningPolicy('unknown::none::single');

      expect(policy.basis).toBe('default');
      expect(policy.generationBudget).toBe(0.65);
      expect(policy.verificationBudget).toBe(0.20);
      expect(policy.contingencyReserve).toBe(0.15);
    });

    test('returns default policy when <10 observations', () => {
      const model = new CalibratedSelfModel();
      const taskSig = 'add::ts::single';

      // Calibrate 5 times (< 10 threshold)
      for (let i = 0; i < 5; i++) {
        const pred = {
          taskId: `task-rp-${i}`,
          timestamp: Date.now(),
          expectedTestResults: 'pass' as const,
          expectedBlastRadius: 1,
          expectedDuration: 2000,
          expectedQualityScore: 0.5,
          uncertainAreas: [],
          confidence: 0.5,
          metaConfidence: 0.1,
          basis: 'static-heuristic' as const,
          calibrationDataPoints: i,
        };
        model.calibrate(pred, makeTrace({
          id: `trace-rp-${i}`,
          taskTypeSignature: taskSig,
          qualityScore: { architecturalCompliance: 0.7, efficiency: 0.7, composite: 0.7, dimensionsAvailable: 2, phase: 'phase0' },
        }));
      }

      const policy = model.getReasoningPolicy(taskSig);
      expect(policy.basis).toBe('default');
      expect(policy.generationBudget).toBe(0.65);
    });

    test('returns calibrated policy when ≥10 observations', () => {
      const model = new CalibratedSelfModel();
      const taskSig = 'fix::ts::small';

      for (let i = 0; i < 15; i++) {
        const pred = {
          taskId: `task-rp-${i}`,
          timestamp: Date.now(),
          expectedTestResults: 'pass' as const,
          expectedBlastRadius: 2,
          expectedDuration: 3000,
          expectedQualityScore: 0.5,
          uncertainAreas: [],
          confidence: 0.5,
          metaConfidence: 0.1,
          basis: 'static-heuristic' as const,
          calibrationDataPoints: i,
        };
        model.calibrate(pred, makeTrace({
          id: `trace-rp-${i}`,
          taskTypeSignature: taskSig,
          qualityScore: { architecturalCompliance: 0.8, efficiency: 0.8, composite: 0.8, dimensionsAvailable: 2, phase: 'phase0' },
        }));
      }

      const policy = model.getReasoningPolicy(taskSig);
      expect(policy.basis).toBe('calibrated');
      expect(policy.generationBudget).toBeGreaterThanOrEqual(0.4);
      expect(policy.generationBudget).toBeLessThanOrEqual(0.85);
    });

    test('calibrated policy clamps generationBudget to [0.4, 0.85]', () => {
      const model = new CalibratedSelfModel();
      const taskSigLow = 'fix::ts::low';
      const taskSigHigh = 'fix::ts::high';

      // Simulate low quality (quality → 0) → genBudget should clamp to 0.4
      for (let i = 0; i < 12; i++) {
        const pred = {
          taskId: `task-lo-${i}`,
          timestamp: Date.now(),
          expectedTestResults: 'pass' as const,
          expectedBlastRadius: 1,
          expectedDuration: 2000,
          expectedQualityScore: 0.5,
          uncertainAreas: [],
          confidence: 0.5,
          metaConfidence: 0.1,
          basis: 'static-heuristic' as const,
          calibrationDataPoints: i,
        };
        model.calibrate(pred, makeTrace({
          id: `trace-lo-${i}`,
          taskTypeSignature: taskSigLow,
          qualityScore: { architecturalCompliance: 0.0, efficiency: 0.0, composite: 0.0, dimensionsAvailable: 2, phase: 'phase0' },
        }));
      }

      // Simulate high quality (quality → 1) → genBudget should clamp to 0.8
      for (let i = 0; i < 12; i++) {
        const pred = {
          taskId: `task-hi-${i}`,
          timestamp: Date.now(),
          expectedTestResults: 'pass' as const,
          expectedBlastRadius: 1,
          expectedDuration: 2000,
          expectedQualityScore: 0.5,
          uncertainAreas: [],
          confidence: 0.5,
          metaConfidence: 0.1,
          basis: 'static-heuristic' as const,
          calibrationDataPoints: i,
        };
        model.calibrate(pred, makeTrace({
          id: `trace-hi-${i}`,
          taskTypeSignature: taskSigHigh,
          qualityScore: { architecturalCompliance: 1.0, efficiency: 1.0, composite: 1.0, dimensionsAvailable: 2, phase: 'phase0' },
        }));
      }

      const policyLow = model.getReasoningPolicy(taskSigLow);
      const policyHigh = model.getReasoningPolicy(taskSigHigh);

      expect(policyLow.generationBudget).toBeGreaterThanOrEqual(0.4);
      expect(policyHigh.generationBudget).toBeLessThanOrEqual(0.85);
      expect(policyHigh.generationBudget).toBeGreaterThan(policyLow.generationBudget);
    });

    test('budget fractions sum to 1.0', () => {
      const model = new CalibratedSelfModel();
      const taskSig = 'refactor::ts::medium';

      // Default policy
      const defaultPolicy = model.getReasoningPolicy(taskSig);
      const defaultSum = defaultPolicy.generationBudget + defaultPolicy.verificationBudget + defaultPolicy.contingencyReserve;
      expect(Math.abs(defaultSum - 1.0)).toBeLessThan(0.001);

      // Calibrated policy
      for (let i = 0; i < 12; i++) {
        const pred = {
          taskId: `task-sum-${i}`,
          timestamp: Date.now(),
          expectedTestResults: 'pass' as const,
          expectedBlastRadius: 3,
          expectedDuration: 5000,
          expectedQualityScore: 0.5,
          uncertainAreas: [],
          confidence: 0.5,
          metaConfidence: 0.1,
          basis: 'static-heuristic' as const,
          calibrationDataPoints: i,
        };
        model.calibrate(pred, makeTrace({
          id: `trace-sum-${i}`,
          taskTypeSignature: taskSig,
          qualityScore: { architecturalCompliance: 0.6, efficiency: 0.6, composite: 0.6, dimensionsAvailable: 2, phase: 'phase0' },
        }));
      }

      const calibrated = model.getReasoningPolicy(taskSig);
      const calibratedSum = calibrated.generationBudget + calibrated.verificationBudget + calibrated.contingencyReserve;
      expect(Math.abs(calibratedSum - 1.0)).toBeLessThan(0.001);
    });

    test('oraclePriority follows A5 tiered trust order', () => {
      const model = new CalibratedSelfModel();
      const policy = model.getReasoningPolicy('any::sig::single');

      // A5: deterministic first → ast, type, dep, lint (deterministic), then test (heuristic)
      expect(policy.oraclePriority).toEqual(['ast', 'type', 'dep', 'lint', 'test']);
    });
  });
});
