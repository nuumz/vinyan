/**
 * Error Attribution Bus — deterministic event subscriber that routes orphaned
 * learning signals into corrective actions.
 *
 * Before this module, Vinyan emitted three learning events that had NO
 * consumers: `selfmodel:systematic_miscalibration`, `prediction:miscalibrated`,
 * and `hms:risk_scored`. The signals were logged but never acted upon. This
 * module subscribes to all three and dispatches rule-based corrective actions.
 *
 * A3 compliance: all logic is threshold comparisons + method dispatch. Zero LLM.
 * A7 compliance: closes the emit→consume gap — every prediction error signal
 * now has a consumer that feeds correction back into the system.
 */
import type { EventBus, VinyanBusEvents } from '../../core/bus.ts';
import type { ExecutionTrace, PredictionError } from '../types.ts';

// ── Configuration ─────────────────────────────────────────────────────

export interface ErrorAttributionConfig {
  compositeErrorThreshold: number;
  hmsRiskThreshold: number;
  miscalibrationForceMinLevel: 0 | 1 | 2 | 3;
}

const DEFAULT_CONFIG: ErrorAttributionConfig = {
  compositeErrorThreshold: 0.3,
  hmsRiskThreshold: 0.7,
  miscalibrationForceMinLevel: 2,
};

// ── Corrective action types ───────────────────────────────────────────

export type CorrectionType = 'selfmodel-reset' | 'prediction-recalibrate' | 'hms-failure-inject';

export interface AttributionResult {
  correctionType: CorrectionType;
  taskId: string;
  detail: string;
  applied: boolean;
}

// ── Callbacks injected by factory ─────────────────────────────────────

export interface ErrorAttributionDeps {
  bus: EventBus<VinyanBusEvents>;
  onSelfModelReset?: (taskTypeSignature: string, forceMinLevel: number) => void;
  onPredictionRecalibrate?: (taskId: string, brierScore: number) => void;
  onHMSFailureInject?: (taskId: string, riskScore: number, primarySignal: string) => void;
}

// ── Implementation ────────────────────────────────────────────────────

export class ErrorAttributionBus {
  private readonly config: ErrorAttributionConfig;
  private readonly deps: ErrorAttributionDeps;
  private readonly unsubs: Array<() => void> = [];
  private readonly corrections: AttributionResult[] = [];

  constructor(deps: ErrorAttributionDeps, config?: Partial<ErrorAttributionConfig>) {
    this.deps = deps;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  start(): void {
    const { bus } = this.deps;

    this.unsubs.push(
      bus.on('selfmodel:systematic_miscalibration', (payload) => {
        this.handleMiscalibration(payload);
      }),
    );

    this.unsubs.push(
      bus.on('prediction:miscalibrated', (payload) => {
        this.handlePredictionMiscalibrated(payload);
      }),
    );

    this.unsubs.push(
      bus.on('hms:risk_scored', (payload) => {
        this.handleHMSRisk(payload);
      }),
    );
  }

  stop(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
  }

  /**
   * Explicit attribution call from phase-learn. When a prediction error's
   * composite delta exceeds the threshold, this determines which component
   * was responsible and dispatches a targeted correction.
   */
  attributeError(predictionError: PredictionError, trace: ExecutionTrace): AttributionResult | null {
    if (Math.abs(predictionError.error.composite) < this.config.compositeErrorThreshold) {
      return null;
    }

    const dominantDelta = this.findDominantErrorSource(predictionError);
    const result: AttributionResult = {
      correctionType: dominantDelta.type,
      taskId: predictionError.taskId,
      detail: dominantDelta.detail,
      applied: false,
    };

    switch (dominantDelta.type) {
      case 'selfmodel-reset': {
        const sig = trace.taskTypeSignature ?? 'unknown';
        this.deps.onSelfModelReset?.(sig, this.config.miscalibrationForceMinLevel);
        result.applied = !!this.deps.onSelfModelReset;
        break;
      }
      case 'prediction-recalibrate': {
        this.deps.onPredictionRecalibrate?.(predictionError.taskId, predictionError.error.composite);
        result.applied = !!this.deps.onPredictionRecalibrate;
        break;
      }
      case 'hms-failure-inject': {
        this.deps.onHMSFailureInject?.(predictionError.taskId, predictionError.error.composite, 'prediction-error');
        result.applied = !!this.deps.onHMSFailureInject;
        break;
      }
    }

    this.corrections.push(result);
    this.deps.bus.emit('learning:error_attributed', {
      taskId: result.taskId,
      correctionType: result.correctionType,
      detail: result.detail,
      applied: result.applied,
    });

    return result;
  }

  getCorrections(): readonly AttributionResult[] {
    return this.corrections;
  }

  // ── Bus event handlers ──────────────────────────────────────────────

  private handleMiscalibration(payload: VinyanBusEvents['selfmodel:systematic_miscalibration']): void {
    this.deps.onSelfModelReset?.(`miscalibrated-${payload.biasDirection}`, this.config.miscalibrationForceMinLevel);
    this.corrections.push({
      correctionType: 'selfmodel-reset',
      taskId: payload.taskId,
      detail: `systematic ${payload.biasDirection}-prediction (magnitude ${payload.magnitude.toFixed(2)}, window ${payload.windowSize})`,
      applied: !!this.deps.onSelfModelReset,
    });
  }

  private handlePredictionMiscalibrated(payload: VinyanBusEvents['prediction:miscalibrated']): void {
    this.deps.onPredictionRecalibrate?.(payload.taskId, payload.brierScore);
    this.corrections.push({
      correctionType: 'prediction-recalibrate',
      taskId: payload.taskId,
      detail: `Brier score ${payload.brierScore.toFixed(3)} > threshold ${payload.threshold}`,
      applied: !!this.deps.onPredictionRecalibrate,
    });
  }

  private handleHMSRisk(payload: VinyanBusEvents['hms:risk_scored']): void {
    if (payload.risk < this.config.hmsRiskThreshold) return;
    this.deps.onHMSFailureInject?.(payload.taskId, payload.risk, payload.primary_signal);
    this.corrections.push({
      correctionType: 'hms-failure-inject',
      taskId: payload.taskId,
      detail: `HMS risk ${payload.risk.toFixed(2)} (signal: ${payload.primary_signal}) above threshold ${this.config.hmsRiskThreshold}`,
      applied: !!this.deps.onHMSFailureInject,
    });
  }

  // ── Error source attribution ────────────────────────────────────────

  private findDominantErrorSource(error: PredictionError): { type: CorrectionType; detail: string } {
    const { qualityScoreDelta, durationDelta, blastRadiusDelta } = error.error;

    if (
      Math.abs(qualityScoreDelta) > Math.abs(durationDelta) &&
      Math.abs(qualityScoreDelta) > Math.abs(blastRadiusDelta)
    ) {
      return {
        type: 'selfmodel-reset',
        detail: `quality score delta ${qualityScoreDelta.toFixed(3)} dominates (duration: ${durationDelta.toFixed(3)}, blast: ${blastRadiusDelta.toFixed(3)})`,
      };
    }
    if (Math.abs(blastRadiusDelta) > Math.abs(durationDelta)) {
      return {
        type: 'prediction-recalibrate',
        detail: `blast radius delta ${blastRadiusDelta.toFixed(3)} dominates`,
      };
    }
    return {
      type: 'hms-failure-inject',
      detail: `duration delta ${durationDelta.toFixed(3)} dominates — possible hallucination or stall`,
    };
  }
}
