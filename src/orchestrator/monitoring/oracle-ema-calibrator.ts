/**
 * Monitoring — Per-oracle EMA accuracy calibration.
 *
 * For each oracle that runs in the gate, we want to know: when this oracle
 * says `verified=true`, how often is the task actually successful? When it
 * says `verified=false`, how often does the task actually fail? That's a
 * per-engine precision/recall pair that ECP §12 calls "engine calibration".
 *
 * This module maintains an online exponential moving average of per-oracle
 * accuracy keyed by oracle name. It is intentionally independent of the
 * SelfModel (which calibrates per task type) — Phase 7 needs the orthogonal
 * per-engine view so we can answer "is the type oracle reliable lately?"
 * without conditioning on the task.
 *
 * NOT A ROUTING DECISION: this calibrator is observational. Downstream
 * consumers (dashboards, sleep-cycle promotion, future ResolvedGateResult
 * weighting) can query the EMA and act on it. The calibrator itself never
 * mutates pipeline state.
 *
 * Source of truth: docs/design/ecp-v2-system-design.md §12 (Phase 7
 * Self-Improving Autonomy).
 */
import type { VinyanBus } from '../../core/bus.ts';

/**
 * Bounds chosen per the §12 design rationale: avoid collapse at extremes.
 * If any per-oracle accuracy could decay all the way to 0, a single bad
 * window would lock the oracle out forever; if it could climb to 1, the
 * gate would over-trust a mode that happens to be on a hot streak.
 */
export const ORACLE_EMA_MIN = 0.1;
export const ORACLE_EMA_MAX = 0.9;
/** Initial accuracy for an oracle with no observations yet. Vacuous coin-flip. */
export const ORACLE_EMA_COLD_START = 0.5;
/**
 * Min observations before the EMA is "warm" — below this the consumer
 * should treat the value as advisory only. Mirrors the SelfModel
 * `metaConfidence < 0.3 when obs < 10` convention.
 */
export const ORACLE_EMA_WARM_THRESHOLD = 10;

/**
 * Adaptive learning rate: fast when count is low (so a fresh oracle
 * stabilises quickly) and slow once warm (so calibrated oracles don't
 * jitter on a single bad task). Matches `adaptiveAlpha` in
 * src/orchestrator/prediction/self-model.ts so behaviour is consistent.
 */
export function adaptiveOracleAlpha(observationCount: number): number {
  return Math.max(0.05, Math.min(0.3, 1 / (1 + observationCount * 0.1)));
}

export interface OracleCalibration {
  oracleName: string;
  observationCount: number;
  accuracy: number;
  /** Raw count of observations where verdict and outcome agreed. */
  agreementCount: number;
  /** Whether enough observations exist to trust the EMA. */
  warm: boolean;
  lastUpdatedAt: number;
}

export interface OracleObservation {
  oracleName: string;
  verified: boolean;
  taskSucceeded: boolean;
}

export class OracleEMACalibrator {
  private readonly state = new Map<string, {
    observationCount: number;
    accuracy: number;
    agreementCount: number;
    lastUpdatedAt: number;
  }>();
  private readonly bus?: VinyanBus;

  constructor(options?: { bus?: VinyanBus }) {
    this.bus = options?.bus;
  }

  /**
   * Record one (oracle verdict, task outcome) pair. Updates the per-oracle
   * EMA in place and emits `monitoring:oracle_calibration` if a state change
   * crosses the warm threshold or accuracy moves by ≥ 0.01.
   */
  record(observation: OracleObservation): OracleCalibration {
    const existing = this.state.get(observation.oracleName) ?? {
      observationCount: 0,
      accuracy: ORACLE_EMA_COLD_START,
      agreementCount: 0,
      lastUpdatedAt: 0,
    };

    // Agreement rule: verdict.verified should match task success. A false
    // positive (verified=true, task failed) and a false negative
    // (verified=false, task succeeded) are equally bad.
    const agreed = observation.verified === observation.taskSucceeded;
    const observed = agreed ? 1 : 0;

    const alpha = adaptiveOracleAlpha(existing.observationCount);
    const newAccuracyRaw = alpha * observed + (1 - alpha) * existing.accuracy;
    // Clamp to bounds — see ORACLE_EMA_MIN/MAX rationale above.
    const newAccuracy = Math.max(ORACLE_EMA_MIN, Math.min(ORACLE_EMA_MAX, newAccuracyRaw));

    const next = {
      observationCount: existing.observationCount + 1,
      accuracy: newAccuracy,
      agreementCount: existing.agreementCount + (agreed ? 1 : 0),
      lastUpdatedAt: Date.now(),
    };
    this.state.set(observation.oracleName, next);

    const wasWarm = existing.observationCount >= ORACLE_EMA_WARM_THRESHOLD;
    const isWarm = next.observationCount >= ORACLE_EMA_WARM_THRESHOLD;
    const accuracyMoved = Math.abs(next.accuracy - existing.accuracy) >= 0.01;
    if (this.bus && (wasWarm !== isWarm || accuracyMoved)) {
      this.bus.emit('monitoring:oracle_calibration', {
        oracleName: observation.oracleName,
        accuracy: next.accuracy,
        observationCount: next.observationCount,
        warm: isWarm,
      });
    }

    return {
      oracleName: observation.oracleName,
      observationCount: next.observationCount,
      accuracy: next.accuracy,
      agreementCount: next.agreementCount,
      warm: isWarm,
      lastUpdatedAt: next.lastUpdatedAt,
    };
  }

  /**
   * Convenience: record one verdict map against a single task outcome.
   * Used by phase-learn after each task — feeds every oracle that ran
   * into the calibrator with the same `taskSucceeded` value.
   */
  recordTrace(verdicts: Record<string, boolean>, taskSucceeded: boolean): OracleCalibration[] {
    return Object.entries(verdicts).map(([oracleName, verified]) =>
      this.record({ oracleName, verified, taskSucceeded }),
    );
  }

  /** Look up the current calibration for one oracle. */
  get(oracleName: string): OracleCalibration | null {
    const s = this.state.get(oracleName);
    if (!s) return null;
    return {
      oracleName,
      observationCount: s.observationCount,
      accuracy: s.accuracy,
      agreementCount: s.agreementCount,
      warm: s.observationCount >= ORACLE_EMA_WARM_THRESHOLD,
      lastUpdatedAt: s.lastUpdatedAt,
    };
  }

  /** Snapshot all per-oracle calibrations for dashboards / tests. */
  snapshot(): OracleCalibration[] {
    return Array.from(this.state.entries())
      .map(([oracleName, s]) => ({
        oracleName,
        observationCount: s.observationCount,
        accuracy: s.accuracy,
        agreementCount: s.agreementCount,
        warm: s.observationCount >= ORACLE_EMA_WARM_THRESHOLD,
        lastUpdatedAt: s.lastUpdatedAt,
      }))
      .sort((a, b) => (a.oracleName < b.oracleName ? -1 : a.oracleName > b.oracleName ? 1 : 0));
  }

  /** Reset state for one oracle (used by drift-recovery). */
  reset(oracleName: string): void {
    this.state.delete(oracleName);
  }
}
