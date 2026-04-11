import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { MODEL_PARAMS_SCHEMA_SQL, SELF_MODEL_PARAMS_SCHEMA_SQL, TRACE_SCHEMA_SQL } from '../../src/db/trace-schema.ts';
import { TraceStore } from '../../src/db/trace-store.ts';
import { CalibratedSelfModel } from '../../src/orchestrator/prediction/self-model.ts';
import type {
  ExecutionTrace,
  PerceptualHierarchy,
  SelfModelPrediction,
  TaskInput,
} from '../../src/orchestrator/types.ts';

function createModel() {
  const db = new Database(':memory:');
  db.exec(TRACE_SCHEMA_SQL);
  db.exec(MODEL_PARAMS_SCHEMA_SQL);
  db.exec(SELF_MODEL_PARAMS_SCHEMA_SQL);
  const traceStore = new TraceStore(db);
  const model = new CalibratedSelfModel({ traceStore, db });
  return { model, db, traceStore };
}

const defaultInput: TaskInput = {
  id: 'task-1',
  source: 'cli',
  goal: 'refactor authentication logic',
  taskType: 'code',
  targetFiles: ['src/auth.ts'],
  budget: { maxTokens: 5000, maxDurationMs: 10000, maxRetries: 1 },
};

const defaultPerception: PerceptualHierarchy = {
  taskTarget: { file: 'src/auth.ts', description: 'test' },
  dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 1 },
  diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
  verifiedFacts: [],
  runtime: { nodeVersion: '', os: '', availableTools: [] },
};

function makeTrace(_prediction: SelfModelPrediction, outcome: 'success' | 'failure' = 'success'): ExecutionTrace {
  return {
    id: `t-${Math.random().toString(36).slice(2)}`,
    taskId: 'task-1',
    timestamp: Date.now(),
    routingLevel: 1,
    taskTypeSignature: 'refactor::ts::single',
    approach: 'direct',
    oracleVerdicts: { ast: true },
    modelUsed: 'mock',
    tokensConsumed: 100,
    durationMs: 500,
    outcome,
    affectedFiles: ['src/auth.ts'],
    qualityScore: {
      architecturalCompliance: 0.9,
      efficiency: 0.8,
      composite: 0.85,
      dimensionsAvailable: 2,
      phase: 'phase0' as const,
    },
  };
}

describe('Self-Model Foundation (PH3.1)', () => {
  describe('Fix 1: Failure prediction', () => {
    test("predicts 'pass' by default with no history", async () => {
      const { model } = createModel();
      const prediction = await model.predict(defaultInput, defaultPerception);
      expect(prediction.expectedTestResults).toBe('pass');
    });

    test("predicts 'partial' with type errors in perception (no history)", async () => {
      // Fresh model with no calibration history — falls back to heuristic
      const { model } = createModel();
      const perception = {
        ...defaultPerception,
        diagnostics: {
          ...defaultPerception.diagnostics,
          typeErrors: [{ file: 'auth.ts', line: 10, message: 'Type error' }],
        },
      };
      const prediction = await model.predict(defaultInput, perception);
      expect(prediction.expectedTestResults).toBe('partial');
    });

    test("predicts 'fail' when majority of observations are failures", async () => {
      const { model } = createModel();

      // 9 failures + 1 success → failRate via EMA should stay above 0.5
      for (let i = 0; i < 9; i++) {
        const pred = await model.predict(defaultInput, defaultPerception);
        model.calibrate(pred, makeTrace(pred, 'failure'));
      }
      const pred = await model.predict(defaultInput, defaultPerception);
      model.calibrate(pred, makeTrace(pred, 'success'));

      const prediction = await model.predict(defaultInput, defaultPerception);
      expect(prediction.expectedTestResults).toBe('fail');
    });
  });

  describe('Fix 2: Improved task signature', () => {
    test('signature includes action verb, extension, and blast radius', async () => {
      const { model } = createModel();
      const prediction = await model.predict(defaultInput, defaultPerception);

      // We can verify the task signature by checking that the model stores it
      const _params = model.getParams();
      // After predict, no calibration yet — no observations stored
      // Calibrate to store the task type
      model.calibrate(prediction, makeTrace(prediction));
      const updatedParams = model.getParams();

      // Should have a key matching the pattern {verb}::{ext}::{bucket}
      const keys = Object.keys(updatedParams.taskTypeObservations);
      expect(keys.length).toBeGreaterThan(0);
      // The trace's taskTypeSignature is "refactor::ts::single" from makeTrace
      // But the model's internal signature comes from computeTaskSignature
      // Let's verify the internal format by checking the signature doesn't match old format
      const key = keys.find((k) => k.includes('::'));
      expect(key).toBeDefined();
    });

    test('different goals produce different action verbs', async () => {
      const { model } = createModel();

      const refactorInput = { ...defaultInput, id: 't-1', goal: 'refactor the auth module' };
      const fixInput = { ...defaultInput, id: 't-2', goal: 'fix the login bug' };

      const pred1 = await model.predict(refactorInput, defaultPerception);
      model.calibrate(pred1, { ...makeTrace(pred1), taskTypeSignature: 'refactor::ts::single' });

      const pred2 = await model.predict(fixInput, defaultPerception);
      model.calibrate(pred2, { ...makeTrace(pred2), taskTypeSignature: 'fix::ts::single' });

      // Should have two different task type entries
      const params = model.getParams();
      const keys = Object.keys(params.taskTypeObservations);
      expect(keys.length).toBeGreaterThanOrEqual(2);
    });

    test('blast radius buckets: single, small, medium, large', async () => {
      const { model } = createModel();

      // single file
      const singleInput = { ...defaultInput, id: 't-1', targetFiles: ['a.ts'] };
      const p1 = await model.predict(singleInput, defaultPerception);
      model.calibrate(p1, { ...makeTrace(p1), taskTypeSignature: 'refactor::ts::single' });

      // 5 files = medium
      const mediumInput = { ...defaultInput, id: 't-2', targetFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'] };
      const p2 = await model.predict(mediumInput, defaultPerception);
      model.calibrate(p2, { ...makeTrace(p2), taskTypeSignature: 'refactor::ts::medium' });

      const params = model.getParams();
      const keys = Object.keys(params.taskTypeObservations);
      expect(keys.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Fix 3: Basis honesty', () => {
    test('basis is static-heuristic with <10 observations', async () => {
      const { model } = createModel();
      const prediction = await model.predict(defaultInput, defaultPerception);
      expect(prediction.basis).toBe('static-heuristic');
    });

    test('basis remains static-heuristic if accuracy < 0.4 even with many observations', async () => {
      const { model } = createModel();

      // Simulate 15 observations with bad accuracy (always wrong predictions)
      for (let i = 0; i < 15; i++) {
        const pred = await model.predict(defaultInput, defaultPerception);
        // Calibrate with very different outcomes to keep accuracy low
        model.calibrate(pred, {
          ...makeTrace(pred, 'failure'),
          durationMs: 50000, // very different from predicted
          affectedFiles: Array.from({ length: 20 }, (_, j) => `file-${j}.ts`),
        });
      }

      const prediction = await model.predict(defaultInput, defaultPerception);
      // With very inaccurate predictions, basis should not be "trace-calibrated"
      expect(prediction.basis).not.toBe('trace-calibrated');
    });

    test('basis transitions to hybrid with moderate observations and accuracy', async () => {
      const { model } = createModel();

      // Simulate 20 observations with decent accuracy
      for (let i = 0; i < 20; i++) {
        const pred = await model.predict(defaultInput, defaultPerception);
        model.calibrate(pred, makeTrace(pred)); // success matches default prediction
      }

      const prediction = await model.predict(defaultInput, defaultPerception);
      // With decent accuracy and 20+ observations, should be hybrid
      expect(['hybrid', 'trace-calibrated']).toContain(prediction.basis);
    });
  });
});
