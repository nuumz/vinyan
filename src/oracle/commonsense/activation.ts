/**
 * M3 — Surprise-driven activation for the CommonSense Oracle.
 *
 * Pure-function activation predicate + debouncer. Decides whether the
 * (cheap, but not free) commonsense oracle should be invoked for a given
 * proposed action.
 *
 * Activation triggers (in priority order):
 *  1. Cold-start: self-model has < 30 obs for the task signature
 *  2. Risk override: hypothesisRisk ≥ 0.6
 *  3. Destructive class: mutation classified as `mutation-destructive`
 *  4. Cool-down: keep activated for N ms after last firing (anti-flap)
 *  5. Surprise gate: predictionError > sigma * 2.0 + dwell-time satisfied
 *
 * Sigma multiplier 2.0 (vs design v1 1.5) follows Datadog/Sinch convergent
 * default of 2σ–3σ — see docs/design/commonsense-substrate-system-design.md
 * §6 / Appendix B (Friston, Datadog, Prometheus citations).
 *
 * Anti-thrashing: Prometheus-style `for:` (dwell) + `keep_firing_for:`
 * (cool-down) — see [Prometheus alerting rules](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/).
 *
 * No LLM. No I/O. Deterministic given (input, debouncer state, clock).
 */
import type { MicrotheoryAction } from './types.ts';

// ── Defaults (research-driven; tuneable via ActivationConfig) ────────────

export interface ActivationConfig {
  /** Self-model observation count below which activation is forced. */
  coldStartObsThreshold: number;
  /** Risk score above which activation is forced. */
  riskThreshold: number;
  /** Sigma multiplier for surprise gate. */
  sigmaMultiplier: number;
  /** Minimum time the surprise condition must hold before first firing. */
  minDwellMs: number;
  /** After firing, stay activated for at least this long. */
  coolDownMs: number;
}

export const DEFAULT_ACTIVATION_CONFIG: ActivationConfig = {
  coldStartObsThreshold: 30,
  riskThreshold: 0.6,
  sigmaMultiplier: 2.0, // bumped from 1.5 (research-driven)
  minDwellMs: 500,
  coolDownMs: 5000,
};

// ── Debouncer (per-key dwell + cool-down state) ──────────────────────────

/**
 * Per-key state for the dwell + cool-down gate. Key is typically the task
 * type signature (e.g. `delete::ts::large-blast`) — lets the gate track
 * surprise stability per task class without cross-talk.
 *
 * Process-scoped singleton (mirrors `OracleCircuitBreaker` in gate.ts:47).
 * Resets on process restart — no persistence.
 */
export class ActivationDebouncer {
  /** When did the surprise condition first become true for this key? */
  private firstSurprise: Map<string, number> = new Map();
  /** When was the most recent activation for this key? */
  private lastActivated: Map<string, number> = new Map();
  /** Clock injection for testability. */
  private nowFn: () => number;

  constructor(nowFn: () => number = Date.now) {
    this.nowFn = nowFn;
  }

  /**
   * Record an observation: was the surprise condition met this cycle?
   * Resets the dwell timer when condition becomes false.
   */
  observe(key: string, surprised: boolean): void {
    if (surprised) {
      if (!this.firstSurprise.has(key)) {
        this.firstSurprise.set(key, this.nowFn());
      }
    } else {
      this.firstSurprise.delete(key);
    }
  }

  /**
   * Has the surprise condition been continuously true for at least `dwellMs`?
   * Returns false if the condition is currently absent or just started.
   */
  dwellExceeded(key: string, dwellMs: number): boolean {
    const t = this.firstSurprise.get(key);
    if (t == null) return false;
    return this.nowFn() - t >= dwellMs;
  }

  /** Mark this key as activated now. Starts the cool-down window. */
  recordActivation(key: string): void {
    this.lastActivated.set(key, this.nowFn());
  }

  /** Are we still inside the cool-down window after the last activation? */
  inCoolDown(key: string, coolDownMs: number): boolean {
    const t = this.lastActivated.get(key);
    if (t == null) return false;
    return this.nowFn() - t < coolDownMs;
  }

  /** Test affordance — clear all per-key state. */
  reset(): void {
    this.firstSurprise.clear();
    this.lastActivated.clear();
  }

  /** Test affordance — override the clock. */
  setClock(nowFn: () => number): void {
    this.nowFn = nowFn;
  }
}

/** Module-level singleton — shared across all activation calls. */
export const defaultDebouncer = new ActivationDebouncer();

// ── Activation predicate ─────────────────────────────────────────────────

export interface ActivationInput {
  /** Task type signature (e.g. `delete::ts::large-blast`). Used as debouncer key. */
  taskTypeSignature: string;
  /** Self-model observation count for this signature. */
  observationCount: number;
  /** Self-model EMA prediction accuracy ∈ [0, 1]. */
  predictionAccuracy: number;
  /**
   * Optional per-task prediction error. When present, the surprise gate uses
   * this directly. When absent, falls back to `(1 - predictionAccuracy)`
   * (the EMA error rate) — useful for cold-pre-execution checks where the
   * actual outcome is unknown.
   */
  predictionError?: number;
  /** Risk score from risk-router ∈ [0, 1]. Optional. */
  riskScore?: number;
  /** Mutation classification (from `classifyMutation`). */
  mutationAction: MicrotheoryAction;
}

export interface ActivationDecision {
  activate: boolean;
  /** Audit trail — explains which gate fired. */
  reason:
    | 'cold-start'
    | 'risk-threshold'
    | 'destructive-mutation'
    | 'cool-down'
    | 'surprise'
    | 'surprise-but-dwelling'
    | 'no-trigger';
}

/**
 * Compute the activation decision. Side-effect: updates the debouncer's
 * dwell counter (for `surprise` path) and lastActivated timestamp (when
 * activation is granted by surprise / risk / destructive triggers).
 *
 * Pass an `ActivationDebouncer` for tests; defaults to module singleton.
 */
export function shouldActivate(
  input: ActivationInput,
  debouncer: ActivationDebouncer = defaultDebouncer,
  config: ActivationConfig = DEFAULT_ACTIVATION_CONFIG,
): ActivationDecision {
  const key = input.taskTypeSignature;

  // 1. Cold-start: self-model unreliable — always activate
  if (input.observationCount < config.coldStartObsThreshold) {
    debouncer.recordActivation(key);
    return { activate: true, reason: 'cold-start' };
  }

  // 2. Risk override (bypass surprise gate)
  if ((input.riskScore ?? 0) >= config.riskThreshold) {
    debouncer.recordActivation(key);
    return { activate: true, reason: 'risk-threshold' };
  }

  // 3. Destructive class override
  if (input.mutationAction === 'mutation-destructive') {
    debouncer.recordActivation(key);
    return { activate: true, reason: 'destructive-mutation' };
  }

  // 4. Cool-down: stay activated for N ms after last firing
  if (debouncer.inCoolDown(key, config.coolDownMs)) {
    return { activate: true, reason: 'cool-down' };
  }

  // 5. Surprise gate (Bernoulli-variance proxy)
  const p = clampUnit(input.predictionAccuracy);
  const sigma = Math.sqrt(p * (1 - p));
  const error = input.predictionError ?? (1 - p);
  const surprised = error > sigma * config.sigmaMultiplier;

  debouncer.observe(key, surprised);

  if (surprised && debouncer.dwellExceeded(key, config.minDwellMs)) {
    debouncer.recordActivation(key);
    return { activate: true, reason: 'surprise' };
  }

  return {
    activate: false,
    reason: surprised ? 'surprise-but-dwelling' : 'no-trigger',
  };
}

function clampUnit(x: number): number {
  if (Number.isNaN(x)) return 0.5;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
