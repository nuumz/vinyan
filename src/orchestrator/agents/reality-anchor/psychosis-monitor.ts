/**
 * PsychosisMonitor — Phase C3 reality-anchor.
 *
 * Subscribes to `trace:record` and maintains a rolling per-persona
 * window of signal snapshots. When a signal's mean over the window
 * breaches its ceiling, emits a single `psychosis:trigger` event and
 * enters a cooldown so subsequent traces don't re-trigger every cycle.
 *
 * Three signals shipped in C3 (goal_drift signal is reserved in the
 * registry for Phase C4 when re-grounding state machine consumes it):
 *
 *   - prediction_error  →  mean(trace.predictionError.magnitude)
 *   - contradiction     →  mean(failed_oracles / total_oracles per trace)
 *   - delusion          →  mean(trace.delusionResult.delusionRate)
 *
 * The monitor is in-memory only — no DB persistence. State resets on
 * orchestrator restart. Phase C4 adds a durable audit table for the
 * re-grounding state machine that consumes this trigger; the windowed
 * signals themselves remain ephemeral.
 *
 * Honesty contract:
 *   - Traces without `agentId` are skipped (no persona to attribute).
 *   - Triggers fire ONCE per breach, then a cooldown of `cooldownTraces`
 *     traces follows during which checks are suppressed for that
 *     persona. Without cooldown, every trace after a breach would
 *     re-emit the same alert.
 *   - Window must be at least `minObservations` traces full before any
 *     check fires (warmup). Prevents spurious early triggers.
 */

import type { VinyanBus } from '../../../core/bus.ts';
import type { ParameterStore } from '../../adaptive-params/parameter-store.ts';
import type { ExecutionTrace } from '../../types.ts';

export type PsychosisSignal = 'prediction_error' | 'contradiction' | 'delusion' | 'goal_drift';

interface SignalSnapshot {
  readonly predictionError: number | undefined;
  readonly contradictionRate: number | undefined;
  readonly delusionRate: number | undefined;
  readonly goalDriftRate: number | undefined;
}

/** Sliding window of recent traces for a single persona. */
class TraceWindow {
  private readonly data: SignalSnapshot[] = [];
  /** Cooldown counter; zero means "checks armed." */
  private cooldownLeft = 0;

  constructor(public readonly capacity: number) {}

  push(snapshot: SignalSnapshot): void {
    this.data.push(snapshot);
    if (this.data.length > this.capacity) this.data.shift();
  }

  size(): number {
    return this.data.length;
  }

  /**
   * Returns true if checks should be suppressed for this trace AND
   * decrements the cooldown counter. Decrementing here (rather than on
   * `push`) gives "N traces silenced after a trigger" semantics: the
   * (N+1)th trace re-arms checks, not the Nth.
   */
  inCooldownAndStep(): boolean {
    if (this.cooldownLeft <= 0) return false;
    this.cooldownLeft--;
    return true;
  }

  startCooldown(traces: number): void {
    this.cooldownLeft = traces;
  }

  /** Mean over snapshots whose value is defined. Undefined when no defined values. */
  meanFor(pick: (s: SignalSnapshot) => number | undefined): number | undefined {
    let sum = 0;
    let count = 0;
    for (const s of this.data) {
      const v = pick(s);
      if (typeof v === 'number' && Number.isFinite(v)) {
        sum += v;
        count++;
      }
    }
    return count === 0 ? undefined : sum / count;
  }
}

export interface PsychosisMonitorOptions {
  readonly bus: VinyanBus;
  /** Optional — when supplied, ceilings are read live from the registry. */
  readonly parameterStore?: ParameterStore;
  /** Window capacity per persona. Default 20. */
  readonly windowSize?: number;
  /** Minimum trace count before the first check runs (warmup). Default 10. */
  readonly minObservations?: number;
  /** Traces to skip after a trigger fires before re-arming. Default 20. */
  readonly cooldownTraces?: number;
  /** Hard-coded ceilings for tests / when ParameterStore is absent. */
  readonly fallbackCeilings?: Partial<Record<PsychosisSignal, number>>;
}

const DEFAULT_CEILINGS: Record<PsychosisSignal, number> = {
  prediction_error: 0.4,
  contradiction: 0.2,
  delusion: 0.15,
  goal_drift: 0.3,
};

const PARAM_KEY: Record<PsychosisSignal, string> = {
  prediction_error: 'psychosis.prediction_error_ceiling',
  contradiction: 'psychosis.contradiction_ceiling',
  delusion: 'psychosis.delusion_ceiling',
  goal_drift: 'psychosis.goal_drift_ceiling',
};

export class PsychosisMonitor {
  private readonly windows = new Map<string, TraceWindow>();
  private readonly bus: VinyanBus;
  private readonly parameterStore: ParameterStore | undefined;
  private readonly windowSize: number;
  private readonly minObservations: number;
  private readonly cooldownTraces: number;
  private readonly fallbackCeilings: Partial<Record<PsychosisSignal, number>>;

  constructor(opts: PsychosisMonitorOptions) {
    this.bus = opts.bus;
    this.parameterStore = opts.parameterStore;
    this.windowSize = opts.windowSize ?? 20;
    this.minObservations = opts.minObservations ?? 10;
    this.cooldownTraces = opts.cooldownTraces ?? 20;
    this.fallbackCeilings = opts.fallbackCeilings ?? {};
  }

  /**
   * Register the monitor to listen on the `trace:record` bus topic.
   * Returns the unsubscribe handle so callers can detach the listener
   * during shutdown / test cleanup.
   */
  attach(): () => void {
    return this.bus.on('trace:record', (event) => this.onTraceRecord(event.trace));
  }

  /**
   * Process one execution trace. Public so tests can drive the monitor
   * directly without going through the bus.
   *
   * Skips traces without `agentId` (no persona attribution). Pushes a
   * signal snapshot to the persona's window. Once the window has at
   * least `minObservations` snapshots AND is not in cooldown, checks
   * each signal's mean against its ceiling. First breach fires the
   * trigger; subsequent breaches in the same trace are silenced (one
   * trigger per trace; cooldown applies after).
   */
  onTraceRecord(trace: ExecutionTrace): void {
    const personaId = trace.agentId;
    if (!personaId) return;
    const window = this.getWindow(personaId);
    window.push(this.deriveSnapshot(trace));

    if (window.inCooldownAndStep()) return;
    if (window.size() < this.minObservations) return;

    for (const signal of ['prediction_error', 'contradiction', 'delusion', 'goal_drift'] as const) {
      const observed = window.meanFor(picker(signal));
      if (observed === undefined) continue;
      const ceiling = this.ceilingFor(signal);
      if (observed > ceiling) {
        this.bus.emit('psychosis:trigger', {
          personaId,
          signal,
          value: observed,
          ceiling,
          windowSize: window.size(),
        });
        window.startCooldown(this.cooldownTraces);
        return; // one trigger per trace
      }
    }
  }

  /** Number of snapshots currently buffered for a persona. Test seam. */
  windowSizeFor(personaId: string): number {
    return this.windows.get(personaId)?.size() ?? 0;
  }

  // ── internal ────────────────────────────────────────────────────────────

  private getWindow(personaId: string): TraceWindow {
    const existing = this.windows.get(personaId);
    if (existing) return existing;
    const created = new TraceWindow(this.windowSize);
    this.windows.set(personaId, created);
    return created;
  }

  private deriveSnapshot(trace: ExecutionTrace): SignalSnapshot {
    return {
      // Composite prediction-error magnitude from PredictionError.error.composite —
      // the same scalar `evolution-engine` uses for trend analysis (A7).
      predictionError: trace.predictionError?.error.composite,
      contradictionRate: contradictionRateOf(trace),
      delusionRate: trace.delusionResult?.delusionRate,
      // Phase C3-followup: A10 goal-grounding integration. Reads
      // trace.goalGrounding (populated by phase-learn from the
      // boundary checks accumulated in PhaseContext) and computes the
      // fraction of grounding actions that aren't 'continue' — i.e.
      // goal drift / re-clarification / abort. Undefined when no
      // grounding checks fired this trace.
      goalDriftRate: goalDriftRateOf(trace),
    };
  }

  private ceilingFor(signal: PsychosisSignal): number {
    if (this.parameterStore) {
      try {
        return this.parameterStore.getNumber(PARAM_KEY[signal]);
      } catch {
        // fall through to fallback / default
      }
    }
    return this.fallbackCeilings[signal] ?? DEFAULT_CEILINGS[signal];
  }
}

function picker(signal: PsychosisSignal): (s: SignalSnapshot) => number | undefined {
  switch (signal) {
    case 'prediction_error':
      return (s) => s.predictionError;
    case 'contradiction':
      return (s) => s.contradictionRate;
    case 'delusion':
      return (s) => s.delusionRate;
    case 'goal_drift':
      return (s) => s.goalDriftRate;
  }
}

function goalDriftRateOf(trace: ExecutionTrace): number | undefined {
  const checks = trace.goalGrounding;
  if (!checks || checks.length === 0) return undefined;
  let drift = 0;
  for (const c of checks) {
    if (c.action !== 'continue') drift++;
  }
  return drift / checks.length;
}

function contradictionRateOf(trace: ExecutionTrace): number | undefined {
  const verdicts = trace.oracleVerdicts;
  if (!verdicts) return undefined;
  const entries = Object.values(verdicts);
  if (entries.length === 0) return undefined;
  let failed = 0;
  for (const v of entries) {
    if (v === false) failed++;
  }
  return failed / entries.length;
}
