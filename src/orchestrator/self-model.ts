/**
 * Calibrated Self-Model — per-task-type predictions with adaptive EMA calibration.
 *
 * PH3.2: Per-task-type parameter storage in SQLite, adaptive learning rate,
 * global fallback for unseen task types. Migrates from old single-blob format.
 *
 * Source of truth: vinyan-tdd.md §12, arch D11, implementation-plan.md §PH3.2
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
import type { VinyanBus } from "../core/bus.ts";

const BASE_MS_PER_FILE = 2000;

/** Minimum samples in bias window before emitting miscalibration event. */
const MISCALIBRATION_WINDOW = 20;
/** Fraction of same-direction errors to trigger alert. */
const MISCALIBRATION_THRESHOLD = 0.7;

/** Per-task-type parameter row in `self_model_params` table. */
interface TaskTypeParams {
  taskTypeSignature: string;
  observationCount: number;
  avgQualityScore: number;
  avgDurationPerFile: number;
  predictionAccuracy: number;
  failRate: number;
  partialRate: number;
  lastUpdated: number;
  basis: "static-heuristic" | "hybrid" | "trace-calibrated";
}

const DEFAULT_TASK_TYPE_PARAMS: Omit<TaskTypeParams, "taskTypeSignature" | "lastUpdated"> = {
  observationCount: 0,
  avgQualityScore: 0.5,
  avgDurationPerFile: BASE_MS_PER_FILE,
  predictionAccuracy: 0.5,
  failRate: 0.0,
  partialRate: 0.1,
  basis: "static-heuristic",
};

/**
 * Adaptive alpha — learning rate varies by observation count.
 * Early (count < 10): α ≈ 0.3 (fast adaptation)
 * After 30+: α ≈ 0.05 (slow drift tracking)
 */
function adaptiveAlpha(observationCount: number): number {
  return Math.max(0.05, Math.min(0.3, 1 / (1 + observationCount * 0.1)));
}

function ema(current: number, observed: number, alpha: number): number {
  return alpha * observed + (1 - alpha) * current;
}

export class CalibratedSelfModel implements SelfModel {
  private db?: Database;
  private traceStore?: TraceStore;
  private bus?: VinyanBus;
  /** Cached global average — invalidated on calibrate. */
  private globalAvgCache?: TaskTypeParams;
  /** In-memory store for when DB is unavailable. */
  private memStore: Map<string, TaskTypeParams> = new Map();
  /** Total observation count across all task types. */
  private totalObservations: number = 0;
  /** G3: Sliding window of prediction error directions for miscalibration detection. */
  private recentBiases: Array<"over" | "under"> = [];

  constructor(options?: { traceStore?: TraceStore; db?: Database; bus?: VinyanBus }) {
    this.traceStore = options?.traceStore;
    this.db = options?.db;
    this.bus = options?.bus;
    this.ensureSchema();
    this.migrateFromOldBlob();
    this.totalObservations = this.computeTotalObservations();
  }

  async predict(
    input: TaskInput,
    perception: PerceptualHierarchy,
  ): Promise<SelfModelPrediction> {
    const fileCount = Math.max(1, input.targetFiles?.length ?? 1);
    const taskSig = this.computeTaskSignature(input);
    const params = this.resolveTaskTypeParams(taskSig);
    const obs = params.observationCount;

    // Heuristic predictions enriched with per-task-type data
    const expectedBlastRadius = perception.dependencyCone.transitiveBlastRadius;
    const expectedTestResults = this.predictTestResults(perception, params);
    const expectedDuration = Math.min(
      input.budget.maxDurationMs,
      fileCount * params.avgDurationPerFile,
    );
    const expectedQualityScore = params.avgQualityScore;

    // Confidence & meta-confidence
    let confidence = params.predictionAccuracy;

    // S2: Meta-uncertainty — forced < 0.3 when < 10 observations for this task type
    let metaConfidence = Math.min(confidence, obs / 20);
    if (obs < 10) {
      metaConfidence = Math.min(metaConfidence, 0.29);
    }

    // S4: Influence increases only as accuracy improves
    metaConfidence = Math.min(metaConfidence, params.predictionAccuracy ** 2);

    const uncertainAreas: string[] = [];
    if (perception.diagnostics.typeErrors.length > 0) uncertainAreas.push("type-errors-present");
    if (expectedBlastRadius > 5) uncertainAreas.push("high-blast-radius");
    if (obs < 5) uncertainAreas.push("low-task-type-observations");

    // S1: Conservative override — first 50 tasks, suggest L2 minimum
    const forceMinLevel = this.totalObservations < 50 ? 2 : undefined;

    // S3: Human audit sampling — 10% for first 100 tasks
    const auditSample = this.totalObservations < 100 && Math.random() < 0.1;

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
      basis: this.computeBasis(obs, params.predictionAccuracy),
      calibrationDataPoints: this.totalObservations,
      ...(forceMinLevel != null ? { forceMinLevel } : {}),
      ...(auditSample ? { auditSample } : {}),
    };
  }

  /**
   * Calibrate model from prediction vs actual outcome.
   * Updates per-task-type parameters with adaptive EMA.
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

    // Load current per-task-type params
    const taskSig = trace.task_type_signature ?? this.computeTaskSignature({
      id: trace.taskId, source: "cli", goal: "", targetFiles: trace.affected_files,
      budget: { maxTokens: 0, maxDurationMs: 0, maxRetries: 0 },
    });
    const params = this.resolveTaskTypeParams(taskSig);

    // Adaptive alpha based on this task type's observation count
    const alpha = adaptiveAlpha(params.observationCount);

    // EMA updates
    params.avgQualityScore = ema(params.avgQualityScore, actual.qualityScore, alpha);
    const fileCount = Math.max(1, trace.affected_files.length);
    params.avgDurationPerFile = ema(params.avgDurationPerFile, actual.duration / fileCount, alpha);

    // Accuracy tracking
    const accuracy = Math.max(0, 1 - error.error.composite);
    params.predictionAccuracy = ema(params.predictionAccuracy, accuracy, alpha);

    // Outcome distribution via EMA
    const isFail = actual.testResults === "fail" ? 1 : 0;
    const isPartial = actual.testResults === "partial" ? 1 : 0;
    params.failRate = ema(params.failRate, isFail, alpha);
    params.partialRate = ema(params.partialRate, isPartial, alpha);

    params.observationCount++;
    params.lastUpdated = Date.now();
    params.basis = this.computeBasis(params.observationCount, params.predictionAccuracy);

    this.upsertTaskTypeParams(params);
    this.totalObservations++;
    this.globalAvgCache = undefined; // invalidate

    // G3: Track prediction error direction for systematic miscalibration detection
    const predictionError = error.error.composite;
    this.recentBiases.push(predictionError > 0 ? "over" : "under");
    if (this.recentBiases.length > MISCALIBRATION_WINDOW) {
      this.recentBiases.shift();
    }

    if (this.bus && this.recentBiases.length >= MISCALIBRATION_WINDOW) {
      const overCount = this.recentBiases.filter(b => b === "over").length;
      const underCount = this.recentBiases.length - overCount;
      const dominantBias = overCount > this.recentBiases.length * MISCALIBRATION_THRESHOLD
        ? "over" as const
        : underCount > this.recentBiases.length * MISCALIBRATION_THRESHOLD
          ? "under" as const
          : null;

      if (dominantBias) {
        this.bus.emit("selfmodel:systematic_miscalibration", {
          taskId: prediction.taskId,
          biasDirection: dominantBias,
          magnitude: Math.abs(overCount / this.recentBiases.length - 0.5),
          windowSize: this.recentBiases.length,
        });
      }
    }

    return error;
  }

  /** Expose params for testing. Returns global-level summary. */
  getParams(): Readonly<{
    observationCount: number;
    avgQualityScore: number;
    avgDurationPerFile: number;
    predictionAccuracy: number;
    taskTypeObservations: Record<string, number>;
    taskTypeOutcomes: Record<string, { pass: number; fail: number; partial: number }>;
  }> {
    const allParams = this.getAllTaskTypeParams();
    const taskTypeObservations: Record<string, number> = {};
    const taskTypeOutcomes: Record<string, { pass: number; fail: number; partial: number }> = {};
    let totalObs = 0;
    let totalQuality = 0;
    let totalDuration = 0;
    let totalAccuracy = 0;

    for (const p of allParams) {
      taskTypeObservations[p.taskTypeSignature] = p.observationCount;
      taskTypeOutcomes[p.taskTypeSignature] = {
        pass: Math.round(p.observationCount * (1 - p.failRate - p.partialRate)),
        fail: Math.round(p.observationCount * p.failRate),
        partial: Math.round(p.observationCount * p.partialRate),
      };
      totalObs += p.observationCount;
      totalQuality += p.avgQualityScore * p.observationCount;
      totalDuration += p.avgDurationPerFile * p.observationCount;
      totalAccuracy += p.predictionAccuracy * p.observationCount;
    }

    return {
      observationCount: totalObs,
      avgQualityScore: totalObs > 0 ? totalQuality / totalObs : 0.5,
      avgDurationPerFile: totalObs > 0 ? totalDuration / totalObs : BASE_MS_PER_FILE,
      predictionAccuracy: totalObs > 0 ? totalAccuracy / totalObs : 0.5,
      taskTypeObservations,
      taskTypeOutcomes,
    };
  }

  /** Get params for a specific task type. */
  getTaskTypeParams(taskSig: string): TaskTypeParams {
    return this.resolveTaskTypeParams(taskSig);
  }

  /** PH3.6: Get all per-task-type params for counterfactual analysis. */
  getTaskTypeParamsMap(): Map<string, TaskTypeParams> {
    const all = this.getAllTaskTypeParams();
    const map = new Map<string, TaskTypeParams>();
    for (const p of all) {
      map.set(p.taskTypeSignature, p);
    }
    return map;
  }

  // ── Private ────────────────────────────────────────────────────────

  private predictTestResults(
    perception: PerceptualHierarchy,
    params: TaskTypeParams,
  ): "pass" | "fail" | "partial" {
    // PH3.1: Use per-task-type outcome rates when enough data exists
    if (params.observationCount >= 5) {
      if (params.failRate > 0.5) return "fail";
      if (params.partialRate > 0.3) return "partial";
      return "pass";
    }
    // Fallback to heuristic
    if (perception.diagnostics.typeErrors.length > 0) return "partial";
    return "pass";
  }

  private computeTaskSignature(input: TaskInput): string {
    const actionVerb = this.extractActionVerb(input.goal);
    const exts = this.extractFileExtensions(input.targetFiles ?? []);
    const blastBucket = this.blastRadiusBucket(input.targetFiles?.length ?? 1);
    return `${actionVerb}::${exts}::${blastBucket}`;
  }

  private extractActionVerb(goal: string): string {
    const lower = goal.toLowerCase().trim();
    const verbs = ["refactor", "fix", "add", "remove", "update", "test", "rename", "move", "extract", "inline"];
    for (const v of verbs) {
      if (lower.startsWith(v)) return v;
    }
    return lower.split(/\s+/)[0]?.slice(0, 20) ?? "unknown";
  }

  private extractFileExtensions(files: string[]): string {
    const exts = new Set(files.map(f => {
      const dot = f.lastIndexOf(".");
      return dot >= 0 ? f.slice(dot + 1) : "none";
    }));
    return [...exts].sort().join(",") || "none";
  }

  private blastRadiusBucket(fileCount: number): string {
    if (fileCount <= 1) return "single";
    if (fileCount <= 3) return "small";
    if (fileCount <= 10) return "medium";
    return "large";
  }

  private computeBasis(obs: number, accuracy: number): "static-heuristic" | "hybrid" | "trace-calibrated" {
    if (obs < 10 || accuracy < 0.4) return "static-heuristic";
    if (obs < 50 || accuracy < 0.6) return "hybrid";
    return "trace-calibrated";
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

  // ── SQLite persistence (per-task-type) ────────────────────────────

  private ensureSchema(): void {
    if (!this.db) return;
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS self_model_params (
        task_type_signature   TEXT PRIMARY KEY,
        observation_count     INTEGER NOT NULL DEFAULT 0,
        avg_quality_score     REAL NOT NULL DEFAULT 0.5,
        avg_duration_per_file REAL NOT NULL DEFAULT 2000,
        prediction_accuracy   REAL NOT NULL DEFAULT 0.5,
        fail_rate             REAL NOT NULL DEFAULT 0.0,
        partial_rate          REAL NOT NULL DEFAULT 0.1,
        last_updated          INTEGER NOT NULL,
        basis                 TEXT NOT NULL DEFAULT 'static-heuristic'
      )`);
    } catch { /* table may already exist */ }
  }

  private resolveTaskTypeParams(taskSig: string): TaskTypeParams {
    // Check DB first
    if (this.db) {
      try {
        const row = this.db.prepare(
          `SELECT * FROM self_model_params WHERE task_type_signature = ?`,
        ).get(taskSig) as any;
        if (row) return this.rowToParams(row);
      } catch { /* fallback */ }
    }

    // Check in-memory store (for no-DB mode)
    const mem = this.memStore.get(taskSig);
    if (mem) return { ...mem };

    // Global fallback for unseen task types
    const global = this.getGlobalAverage();
    return { ...global, taskTypeSignature: taskSig, observationCount: 0, lastUpdated: Date.now() };
  }

  private getGlobalAverage(): TaskTypeParams {
    if (this.globalAvgCache) return this.globalAvgCache;

    const allParams = this.getAllTaskTypeParams();
    if (allParams.length === 0) {
      this.globalAvgCache = {
        taskTypeSignature: "__global__",
        ...DEFAULT_TASK_TYPE_PARAMS,
        lastUpdated: Date.now(),
      };
      return this.globalAvgCache;
    }

    let totalObs = 0;
    let wQuality = 0, wDuration = 0, wAccuracy = 0, wFail = 0, wPartial = 0;
    for (const p of allParams) {
      const w = p.observationCount;
      totalObs += w;
      wQuality += p.avgQualityScore * w;
      wDuration += p.avgDurationPerFile * w;
      wAccuracy += p.predictionAccuracy * w;
      wFail += p.failRate * w;
      wPartial += p.partialRate * w;
    }

    this.globalAvgCache = {
      taskTypeSignature: "__global__",
      observationCount: 0,
      avgQualityScore: totalObs > 0 ? wQuality / totalObs : 0.5,
      avgDurationPerFile: totalObs > 0 ? wDuration / totalObs : BASE_MS_PER_FILE,
      predictionAccuracy: totalObs > 0 ? wAccuracy / totalObs : 0.5,
      failRate: totalObs > 0 ? wFail / totalObs : 0.0,
      partialRate: totalObs > 0 ? wPartial / totalObs : 0.1,
      lastUpdated: Date.now(),
      basis: "static-heuristic",
    };
    return this.globalAvgCache;
  }

  private getAllTaskTypeParams(): TaskTypeParams[] {
    if (this.db) {
      try {
        const rows = this.db.prepare(`SELECT * FROM self_model_params`).all() as any[];
        return rows.map(r => this.rowToParams(r));
      } catch { /* fallback to memStore */ }
    }
    return [...this.memStore.values()];
  }

  private rowToParams(row: any): TaskTypeParams {
    return {
      taskTypeSignature: row.task_type_signature,
      observationCount: row.observation_count,
      avgQualityScore: row.avg_quality_score,
      avgDurationPerFile: row.avg_duration_per_file,
      predictionAccuracy: row.prediction_accuracy,
      failRate: row.fail_rate,
      partialRate: row.partial_rate,
      lastUpdated: row.last_updated,
      basis: row.basis,
    };
  }

  private upsertTaskTypeParams(params: TaskTypeParams): void {
    // Always store in memory
    this.memStore.set(params.taskTypeSignature, { ...params });

    if (!this.db) return;
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO self_model_params
          (task_type_signature, observation_count, avg_quality_score, avg_duration_per_file,
           prediction_accuracy, fail_rate, partial_rate, last_updated, basis)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        params.taskTypeSignature,
        params.observationCount,
        params.avgQualityScore,
        params.avgDurationPerFile,
        params.predictionAccuracy,
        params.failRate,
        params.partialRate,
        params.lastUpdated,
        params.basis,
      );
    } catch { /* persistence is best-effort */ }
  }

  private computeTotalObservations(): number {
    if (!this.db) return 0;
    try {
      const row = this.db.prepare(
        `SELECT COALESCE(SUM(observation_count), 0) as total FROM self_model_params`,
      ).get() as { total: number } | null;
      return row?.total ?? 0;
    } catch {
      return 0;
    }
  }

  /** Migrate from old single-blob `model_parameters` format to per-task-type rows. */
  private migrateFromOldBlob(): void {
    if (!this.db) return;
    try {
      const row = this.db.prepare(
        `SELECT value FROM model_parameters WHERE key = 'self_model_params'`,
      ).get() as { value: string } | null;
      if (!row) return;

      const old = JSON.parse(row.value) as {
        observationCount?: number;
        avgQualityScore?: number;
        avgDurationPerFile?: number;
        predictionAccuracy?: number;
        taskTypeObservations?: Record<string, number>;
        taskTypeOutcomes?: Record<string, { pass: number; fail: number; partial: number }>;
      };

      // Decompose into per-task-type rows
      const taskTypes = old.taskTypeObservations ?? {};
      const outcomes = old.taskTypeOutcomes ?? {};

      for (const [sig, count] of Object.entries(taskTypes)) {
        const o = outcomes[sig] ?? { pass: 0, fail: 0, partial: 0 };
        const total = o.pass + o.fail + o.partial;
        this.upsertTaskTypeParams({
          taskTypeSignature: sig,
          observationCount: count,
          avgQualityScore: old.avgQualityScore ?? 0.5,
          avgDurationPerFile: old.avgDurationPerFile ?? BASE_MS_PER_FILE,
          predictionAccuracy: old.predictionAccuracy ?? 0.5,
          failRate: total > 0 ? o.fail / total : 0,
          partialRate: total > 0 ? o.partial / total : 0.1,
          lastUpdated: Date.now(),
          basis: this.computeBasis(count, old.predictionAccuracy ?? 0.5),
        });
      }

      // Remove old blob
      this.db.prepare(`DELETE FROM model_parameters WHERE key = 'self_model_params'`).run();
    } catch {
      // Migration failure is non-fatal — start fresh
    }
  }
}
