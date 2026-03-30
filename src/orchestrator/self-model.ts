/**
 * Calibrated Self-Model — heuristic predictions with EMA-based calibration.
 *
 * Replaces SelfModelStub with:
 * - Heuristic-based predictions from perception data
 * - EMA calibration loop (predict → execute → observe → compare → update)
 * - Cold-start safeguards S1-S4 per TDD §12
 * - Model parameter persistence via SQLite
 *
 * Source of truth: vinyan-tdd.md §12, arch D11
 */
import type { Database } from "bun:sqlite";
import type { SelfModel } from "./core-loop.ts";
import type {
  TaskInput,
  PerceptualHierarchy,
  SelfModelPrediction,
  PredictionError,
  ExecutionTrace,
} from "./types.ts";
import type { TraceStore } from "../db/trace-store.ts";

const EMA_ALPHA = 0.1;
const BASE_MS_PER_FILE = 2000;

interface ModelParams {
  observationCount: number;
  avgQualityScore: number;
  avgDurationPerFile: number;
  predictionAccuracy: number;
  /** Per-task-type observation counts for S2 check. */
  taskTypeObservations: Record<string, number>;
}

const DEFAULT_PARAMS: ModelParams = {
  observationCount: 0,
  avgQualityScore: 0.5,
  avgDurationPerFile: BASE_MS_PER_FILE,
  predictionAccuracy: 0.5,
  taskTypeObservations: {},
};

export class CalibratedSelfModel implements SelfModel {
  private params: ModelParams;
  private db?: Database;
  private traceStore?: TraceStore;

  constructor(options?: { traceStore?: TraceStore; db?: Database }) {
    this.traceStore = options?.traceStore;
    this.db = options?.db;
    this.params = this.loadParams();
  }

  async predict(
    input: TaskInput,
    perception: PerceptualHierarchy,
  ): Promise<SelfModelPrediction> {
    const fileCount = Math.max(1, input.targetFiles?.length ?? 1);
    const obs = this.params.observationCount;
    const taskSig = this.computeTaskSignature(input);
    const taskObs = this.params.taskTypeObservations[taskSig] ?? 0;

    // Heuristic predictions
    const expectedBlastRadius = perception.dependencyCone.transitiveBlastRadius;

    const expectedTestResults = this.predictTestResults(perception);

    const expectedDuration = Math.min(
      input.budget.maxDurationMs,
      fileCount * this.params.avgDurationPerFile,
    );

    const expectedQualityScore = this.params.avgQualityScore;

    // Confidence & meta-confidence
    let confidence = this.params.predictionAccuracy;

    // S2: Meta-uncertainty — forced < 0.3 when < 10 observations for this task type
    let metaConfidence = Math.min(confidence, taskObs / 20);
    if (taskObs < 10) {
      metaConfidence = Math.min(metaConfidence, 0.29);
    }

    // S4: Influence increases only as accuracy improves
    metaConfidence = Math.min(metaConfidence, this.params.predictionAccuracy ** 2);

    const uncertainAreas: string[] = [];
    if (perception.diagnostics.typeErrors.length > 0) uncertainAreas.push("type-errors-present");
    if (expectedBlastRadius > 5) uncertainAreas.push("high-blast-radius");
    if (taskObs < 5) uncertainAreas.push("low-task-type-observations");

    // S1: Conservative override — first 50 tasks, suggest L2 minimum
    const forceMinLevel = obs < 50 ? 2 : undefined;

    // S3: Human audit sampling — 10% for first 100 tasks
    const auditSample = obs < 100 && Math.random() < 0.1;

    return {
      taskId: input.id,
      timestamp: Date.now(),
      expectedTestResults,
      expectedBlastRadius,
      expectedDuration,
      expectedQualityScore,
      uncertainAreas,
      confidence,
      metaConfidence,
      basis: obs >= 10 ? "trace-calibrated" : "static-heuristic",
      calibrationDataPoints: obs,
      ...(forceMinLevel != null ? { forceMinLevel } : {}),
      ...(auditSample ? { auditSample } : {}),
    };
  }

  /**
   * Calibrate model from prediction vs actual outcome.
   * Called from core loop after LEARN step.
   */
  calibrate(prediction: SelfModelPrediction, trace: ExecutionTrace): PredictionError {
    const actual = {
      testResults: (trace.outcome === "success" ? "pass" : "fail") as "pass" | "fail" | "partial",
      blastRadius: trace.affected_files.length,
      duration: trace.duration_ms,
      qualityScore: trace.qualityScore?.composite ?? 0.5,
    };

    const error: PredictionError = {
      taskId: prediction.taskId,
      predicted: prediction,
      actual,
      error: {
        testResultMatch: prediction.expectedTestResults === actual.testResults,
        blastRadiusDelta: actual.blastRadius - prediction.expectedBlastRadius,
        durationDelta: actual.duration - prediction.expectedDuration,
        qualityScoreDelta: actual.qualityScore - prediction.expectedQualityScore,
        composite: this.computeCompositeError(prediction, actual),
      },
    };

    // EMA update
    this.params.avgQualityScore = ema(this.params.avgQualityScore, actual.qualityScore);
    const fileCount = Math.max(1, trace.affected_files.length);
    this.params.avgDurationPerFile = ema(this.params.avgDurationPerFile, actual.duration / fileCount);

    // Accuracy tracking (lower composite error = higher accuracy)
    const accuracy = Math.max(0, 1 - error.error.composite);
    this.params.predictionAccuracy = ema(this.params.predictionAccuracy, accuracy);

    this.params.observationCount++;

    // Track per-task-type observations
    const taskSig = trace.task_type_signature ?? "unknown";
    this.params.taskTypeObservations[taskSig] = (this.params.taskTypeObservations[taskSig] ?? 0) + 1;

    this.persistParams();

    return error;
  }

  getParams(): Readonly<ModelParams> {
    return this.params;
  }

  // ── Private ────────────────────────────────────────────────────────

  private predictTestResults(perception: PerceptualHierarchy): "pass" | "fail" | "partial" {
    if (perception.diagnostics.typeErrors.length > 0) return "partial";
    return "pass";
  }

  private computeTaskSignature(input: TaskInput): string {
    const filePattern = input.targetFiles?.length
      ? input.targetFiles.map(f => f.replace(/\/[^/]+$/, "/")).join(",")
      : "unknown";
    return `${filePattern}`;
  }

  private computeCompositeError(
    predicted: SelfModelPrediction,
    actual: { testResults: string; blastRadius: number; duration: number; qualityScore: number },
  ): number {
    const testMatch = predicted.expectedTestResults === actual.testResults ? 0 : 0.3;
    const blastDelta = Math.abs(actual.blastRadius - predicted.expectedBlastRadius) /
      Math.max(1, predicted.expectedBlastRadius);
    const durationDelta = Math.abs(actual.duration - predicted.expectedDuration) /
      Math.max(1, predicted.expectedDuration);
    const qualityDelta = Math.abs(actual.qualityScore - predicted.expectedQualityScore);

    return Math.min(1, testMatch * 0.3 + Math.min(1, blastDelta) * 0.2 + Math.min(1, durationDelta) * 0.2 + qualityDelta * 0.3);
  }

  private loadParams(): ModelParams {
    if (!this.db) return { ...DEFAULT_PARAMS };
    try {
      const row = this.db.prepare(
        `SELECT value FROM model_parameters WHERE key = 'self_model_params'`,
      ).get() as { value: string } | null;
      if (row) return JSON.parse(row.value);
    } catch {
      // DB not ready or corrupt — use defaults
    }
    return { ...DEFAULT_PARAMS };
  }

  private persistParams(): void {
    if (!this.db) return;
    try {
      this.db.prepare(
        `INSERT OR REPLACE INTO model_parameters (key, value, updated_at) VALUES (?, ?, ?)`,
      ).run("self_model_params", JSON.stringify(this.params), Date.now());
    } catch {
      // Persistence is best-effort
    }
  }
}

function ema(current: number, observed: number): number {
  return EMA_ALPHA * observed + (1 - EMA_ALPHA) * current;
}
