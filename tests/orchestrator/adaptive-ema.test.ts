import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { MODEL_PARAMS_SCHEMA_SQL, SELF_MODEL_PARAMS_SCHEMA_SQL } from '../../src/db/trace-schema.ts';
import { CalibratedSelfModel } from '../../src/orchestrator/prediction/self-model.ts';
import type {
  ExecutionTrace,
  PerceptualHierarchy,
  SelfModelPrediction,
  TaskInput,
} from '../../src/orchestrator/types.ts';

function createDb() {
  const db = new Database(':memory:');
  db.exec(MODEL_PARAMS_SCHEMA_SQL);
  db.exec(SELF_MODEL_PARAMS_SCHEMA_SQL);
  return db;
}

function makeInput(goal = 'refactor auth logic', files = ['src/auth.ts']): TaskInput {
  return {
    id: `task-${Math.random().toString(36).slice(2)}`,
    source: 'cli',
    goal,
    taskType: 'code',
    targetFiles: files,
    budget: { maxTokens: 5000, maxDurationMs: 10000, maxRetries: 1 },
  };
}

const defaultPerception: PerceptualHierarchy = {
  taskTarget: { file: 'src/auth.ts', description: 'test' },
  dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 1 },
  diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
  verifiedFacts: [],
  runtime: { nodeVersion: '', os: '', availableTools: [] },
};

function makeTrace(
  pred: SelfModelPrediction,
  outcome: 'success' | 'failure' = 'success',
  files = ['src/auth.ts'],
): ExecutionTrace {
  return {
    id: `t-${Math.random().toString(36).slice(2)}`,
    taskId: pred.taskId,
    timestamp: Date.now(),
    routingLevel: 1,
    taskTypeSignature: 'refactor::ts::single',
    approach: 'direct',
    oracleVerdicts: { ast: true },
    modelUsed: 'mock',
    tokensConsumed: 100,
    durationMs: 500,
    outcome,
    affectedFiles: files,
    qualityScore: {
      architecturalCompliance: 0.9,
      efficiency: 0.8,
      composite: 0.85,
      dimensionsAvailable: 2,
      phase: 'basic' as const,
    },
  };
}

describe('PH3.2: Adaptive EMA + Per-Task-Type Storage', () => {
  describe('Adaptive alpha', () => {
    test('new task types converge within 5 observations', async () => {
      const db = createDb();
      const model = new CalibratedSelfModel({ db });
      const input = makeInput();

      // First prediction uses global fallback (0.5)
      const pred0 = await model.predict(input, defaultPerception);
      expect(pred0.expectedQualityScore).toBeCloseTo(0.5, 1);

      // Feed 5 traces with quality 0.9 — should converge quickly
      for (let i = 0; i < 5; i++) {
        const pred = await model.predict(input, defaultPerception);
        model.calibrate(pred, {
          ...makeTrace(pred),
          qualityScore: {
            architecturalCompliance: 0.9,
            efficiency: 0.9,
            composite: 0.9,
            dimensionsAvailable: 2,
            phase: 'basic' as const,
          },
        });
      }

      const pred5 = await model.predict(input, defaultPerception);
      // After 5 obs with alpha≈0.2-0.3, should be significantly closer to 0.9 than 0.5
      expect(pred5.expectedQualityScore).toBeGreaterThan(0.7);
    });

    test('after 30+ obs, alpha drops to ~0.05 (slow drift)', async () => {
      const db = createDb();
      const model = new CalibratedSelfModel({ db });
      const input = makeInput();

      // Build up 30 observations
      for (let i = 0; i < 30; i++) {
        const pred = await model.predict(input, defaultPerception);
        model.calibrate(pred, {
          ...makeTrace(pred),
          qualityScore: {
            architecturalCompliance: 0.8,
            efficiency: 0.8,
            composite: 0.8,
            dimensionsAvailable: 2,
            phase: 'basic' as const,
          },
        });
      }

      const before = await model.predict(input, defaultPerception);
      const qBefore = before.expectedQualityScore;

      // Inject one outlier with quality 0.0
      const pred = await model.predict(input, defaultPerception);
      model.calibrate(pred, {
        ...makeTrace(pred),
        qualityScore: {
          architecturalCompliance: 0,
          efficiency: 0,
          composite: 0,
          dimensionsAvailable: 2,
          phase: 'basic' as const,
        },
      });

      const after = await model.predict(input, defaultPerception);
      // With alpha bounded [0.05, 0.3], at 30+ obs the drift from a single outlier is bounded
      expect(Math.abs(after.expectedQualityScore - qBefore)).toBeLessThan(0.25);
    });
  });

  describe('Per-task-type isolation', () => {
    test('different task types have independent parameters', async () => {
      const db = createDb();
      const model = new CalibratedSelfModel({ db });

      const refactorInput = makeInput('refactor auth', ['src/auth.ts']);
      const fixInput = makeInput('fix login bug', ['src/login.ts']);

      // Feed refactors with high quality
      for (let i = 0; i < 10; i++) {
        const pred = await model.predict(refactorInput, defaultPerception);
        model.calibrate(pred, {
          ...makeTrace(pred),
          taskTypeSignature: 'refactor::ts::single',
          qualityScore: {
            architecturalCompliance: 0.9,
            efficiency: 0.9,
            composite: 0.9,
            dimensionsAvailable: 2,
            phase: 'basic' as const,
          },
        });
      }

      // Feed fixes with low quality
      for (let i = 0; i < 10; i++) {
        const pred = await model.predict(fixInput, defaultPerception);
        model.calibrate(pred, {
          ...makeTrace(pred),
          taskTypeSignature: 'fix::ts::single',
          qualityScore: {
            architecturalCompliance: 0.3,
            efficiency: 0.3,
            composite: 0.3,
            dimensionsAvailable: 2,
            phase: 'basic' as const,
          },
        });
      }

      const refactorPred = await model.predict(refactorInput, defaultPerception);
      const fixPred = await model.predict(fixInput, defaultPerception);

      // Should have significantly different predictions
      expect(refactorPred.expectedQualityScore).toBeGreaterThan(fixPred.expectedQualityScore + 0.2);
    });
  });

  describe('Global fallback', () => {
    test('unseen task type uses project-wide average (not 0.5)', async () => {
      const db = createDb();
      const model = new CalibratedSelfModel({ db });

      // Establish project average quality of ~0.85
      const existingInput = makeInput('refactor auth', ['src/auth.ts']);
      for (let i = 0; i < 10; i++) {
        const pred = await model.predict(existingInput, defaultPerception);
        model.calibrate(pred, {
          ...makeTrace(pred),
          taskTypeSignature: 'refactor::ts::single',
          qualityScore: {
            architecturalCompliance: 0.85,
            efficiency: 0.85,
            composite: 0.85,
            dimensionsAvailable: 2,
            phase: 'basic' as const,
          },
        });
      }

      // New unseen task type should use global avg (~0.85), not default 0.5
      const newInput = makeInput('test database queries', ['src/db.ts']);
      const newPred = await model.predict(newInput, defaultPerception);
      expect(newPred.expectedQualityScore).toBeGreaterThan(0.7);
    });
  });

  describe('SQLite persistence', () => {
    test('parameters survive process restart', async () => {
      const db = createDb();
      const model1 = new CalibratedSelfModel({ db });
      const input = makeInput();

      // Calibrate
      for (let i = 0; i < 5; i++) {
        const pred = await model1.predict(input, defaultPerception);
        model1.calibrate(pred, makeTrace(pred));
      }

      const pred1 = await model1.predict(input, defaultPerception);

      // Create new model instance with same DB — simulates restart
      const model2 = new CalibratedSelfModel({ db });
      const pred2 = await model2.predict(input, defaultPerception);

      expect(pred2.expectedQualityScore).toBeCloseTo(pred1.expectedQualityScore, 2);
      expect(pred2.calibrationDataPoints).toBe(pred1.calibrationDataPoints);
    });
  });

  describe('Migration from old blob', () => {
    test('migrates old model_parameters blob to per-task-type rows', async () => {
      const db = createDb();

      // Insert old-format blob
      db.prepare(`INSERT INTO model_parameters (key, value, updated_at) VALUES (?, ?, ?)`).run(
        'self_model_params',
        JSON.stringify({
          observationCount: 25,
          avgQualityScore: 0.8,
          avgDurationPerFile: 1500,
          predictionAccuracy: 0.7,
          taskTypeObservations: { 'refactor::ts::single': 15, 'fix::ts::single': 10 },
          taskTypeOutcomes: {
            'refactor::ts::single': { pass: 13, fail: 1, partial: 1 },
            'fix::ts::single': { pass: 6, fail: 3, partial: 1 },
          },
        }),
        Date.now(),
      );

      // Create model — should auto-migrate
      const _model = new CalibratedSelfModel({ db });

      // Old blob should be deleted
      const oldRow = db.prepare(`SELECT * FROM model_parameters WHERE key = 'self_model_params'`).get();
      expect(oldRow).toBeNull();

      // Per-task-type rows should exist
      const rows = db.prepare(`SELECT * FROM self_model_params`).all() as any[];
      expect(rows.length).toBe(2);

      const refactorRow = rows.find((r: any) => r.task_type_signature === 'refactor::ts::single');
      expect(refactorRow).toBeDefined();
      expect(refactorRow!.observation_count).toBe(15);
    });
  });
});
