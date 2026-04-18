/**
 * Comprehension Trace Listener — writes adaptive-behavior events to the
 * TraceCollector so Sleep Cycle, SelfModel, and dashboards see the full
 * A7 loop (not just generation, but also calibration + responses).
 *
 * Subscribes to three comprehension events that previously had no
 * consumer:
 *   - `comprehension:calibrated`          — a prior turn got labeled (outcome)
 *   - `comprehension:calibration_diverged` — engine accuracy dropped
 *   - `comprehension:ceiling_adjusted`    — divergence clamped the ceiling
 *
 * Each becomes a structured ExecutionTrace with `approach` in the
 * `'comprehension-*'` family and enough detail in `approachDescription`
 * for future miners (Sleep Cycle) to extract patterns.
 *
 * Pure observer — no side effects beyond trace persistence. A3 compliant.
 */

import type { VinyanBus } from '../core/bus.ts';
import type { TraceCollector } from '../orchestrator/core-loop.ts';
import type { ComprehensionCalibrator } from '../orchestrator/comprehension/learning/calibrator.ts';

/** Brier threshold above which an engine is flagged miscalibrated. */
export const MISCALIBRATION_BRIER_THRESHOLD = 0.25;

export interface ComprehensionTraceListenerOptions {
  readonly bus: VinyanBus;
  readonly traceCollector: TraceCollector;
  /**
   * AXM#7 wiring: when provided, after every `comprehension:calibrated`
   * event the listener checks the engine's Brier score. Above threshold
   * → emits `comprehension:miscalibrated` + a dedicated trace entry.
   * Without a calibrator, the listener still records the 3 baseline
   * events and just skips the Brier check.
   */
  readonly calibrator?: ComprehensionCalibrator;
}

export interface ComprehensionTraceListenerHandle {
  readonly detach: () => void;
}

/**
 * Attach the listener. Returns a detach handle; the orchestrator's
 * shutdown path MUST call it so lingering subscriptions don't leak
 * across sessions.
 */
export function attachComprehensionTraceListener(
  opts: ComprehensionTraceListenerOptions,
): ComprehensionTraceListenerHandle {
  const { bus, traceCollector, calibrator } = opts;

  const offCalibrated = bus.on('comprehension:calibrated', (payload) => {
    void traceCollector
      .record({
        id: `trace-${payload.taskId}-comprehension-calibrated-${payload.priorInputHash.slice(0, 8)}`,
        taskId: payload.taskId,
        workerId: 'comprehension-phase',
        timestamp: Date.now(),
        routingLevel: 0,
        approach: 'comprehension-calibrated',
        approachDescription:
          `engine=${payload.engineId} outcome=${payload.outcome} ` +
          `reason=${String(payload.evidence.reason ?? 'unknown')} ` +
          `labelConfidence=${String(payload.evidence.confidence ?? 'unset')}`,
        oracleVerdicts: {},
        modelUsed: payload.engineId,
        engineId: payload.engineId,
        tokensConsumed: 0,
        durationMs: 0,
        outcome: payload.outcome === 'corrected' ? 'failure' : 'success',
        affectedFiles: [],
      })
      .catch(() => {
        // Trace recording is best-effort — a DB hiccup must not throw.
      });

    // AXM#7 wiring: after a new outcome lands, check whether the
    // engine's Brier score crossed the miscalibration threshold. If so,
    // emit `comprehension:miscalibrated` + a dedicated trace entry.
    // Deferred behind calibrator injection so the listener still works
    // without persistence (unit tests, degraded mode).
    if (!calibrator) return;
    const b = calibrator.brierScore(payload.engineId);
    if (b.insufficient || b.brier == null) return;
    if (b.brier <= MISCALIBRATION_BRIER_THRESHOLD) return;
    bus.emit('comprehension:miscalibrated', {
      taskId: payload.taskId,
      engineId: payload.engineId,
      brier: b.brier,
      sampleSize: b.sampleSize,
      threshold: MISCALIBRATION_BRIER_THRESHOLD,
    });
    void traceCollector
      .record({
        id: `trace-${payload.taskId}-comprehension-miscalibrated-${payload.engineId}`,
        taskId: payload.taskId,
        workerId: 'comprehension-phase',
        timestamp: Date.now(),
        routingLevel: 0,
        approach: 'comprehension-miscalibrated',
        approachDescription:
          `engine=${payload.engineId} brier=${b.brier.toFixed(3)} ` +
          `n=${b.sampleSize} threshold=${MISCALIBRATION_BRIER_THRESHOLD}`,
        oracleVerdicts: {},
        modelUsed: payload.engineId,
        engineId: payload.engineId,
        tokensConsumed: 0,
        durationMs: 0,
        outcome: 'failure',
        failureReason: `Brier ${b.brier.toFixed(3)} > ${MISCALIBRATION_BRIER_THRESHOLD}`,
        affectedFiles: [],
      })
      .catch(() => { /* best-effort */ });
  });

  const offDiverged = bus.on('comprehension:calibration_diverged', (payload) => {
    void traceCollector
      .record({
        id: `trace-${payload.taskId}-comprehension-diverged-${payload.engineId}`,
        taskId: payload.taskId,
        workerId: 'comprehension-phase',
        timestamp: Date.now(),
        routingLevel: 0,
        approach: 'comprehension-diverged',
        approachDescription:
          `engine=${payload.engineId} type=${payload.engineType} ` +
          `recent=${payload.recentAccuracy.toFixed(3)}/${payload.recentSamples} ` +
          `historical=${payload.historicalAccuracy.toFixed(3)}/${payload.historicalSamples} ` +
          `delta=${payload.delta.toFixed(3)}`,
        oracleVerdicts: {},
        modelUsed: payload.engineId,
        engineId: payload.engineId,
        tokensConsumed: 0,
        durationMs: 0,
        // `failure` is the right semantic here — a diverged engine IS failing
        // its implicit prediction, even if no task yet officially flopped.
        outcome: 'failure',
        failureReason: `divergence delta=${payload.delta.toFixed(3)}`,
        affectedFiles: [],
      })
      .catch(() => { /* best-effort */ });
  });

  const offAdjusted = bus.on('comprehension:ceiling_adjusted', (payload) => {
    void traceCollector
      .record({
        id: `trace-${payload.taskId}-comprehension-adjusted-${payload.engineId}`,
        taskId: payload.taskId,
        workerId: 'comprehension-phase',
        timestamp: Date.now(),
        routingLevel: 0,
        approach: 'comprehension-adjusted',
        approachDescription:
          `engine=${payload.engineId} ` +
          `base=${payload.baseCeiling.toFixed(3)} ` +
          `effective=${payload.effectiveCeiling.toFixed(3)} ` +
          `tightening=${payload.tightening.toFixed(3)}`,
        oracleVerdicts: {},
        modelUsed: payload.engineId,
        engineId: payload.engineId,
        tokensConsumed: 0,
        durationMs: 0,
        // Success in the sense that the adaptive mechanism fired correctly;
        // operator dashboards rely on this to monitor A7 activity.
        outcome: 'success',
        affectedFiles: [],
      })
      .catch(() => { /* best-effort */ });
  });

  return {
    detach: () => {
      offCalibrated();
      offDiverged();
      offAdjusted();
    },
  };
}
