/**
 * Silent Agent Detector — worker-level heartbeat visibility guardrail.
 *
 * Part of book-integration Wave 1.1 (see docs/architecture/book-integration-overview.md).
 *
 * Problem:
 *   Peer-level heartbeats (src/a2a/peer-health.ts) catch partitioned *peers*,
 *   but not individual workers that have stopped producing turns while their
 *   subprocess is still technically alive. A worker looping inside a tool
 *   call, thinking for minutes, or stuck on a blocking read looks identical
 *   to a responsive worker to anything above the agent-loop.
 *
 * Solution:
 *   SilentAgentDetector is a stateless, rule-based timeout watchdog that
 *   tracks the wall-clock gap between turn receipts for every live worker
 *   session. It fires two escalating signals:
 *
 *     1. `silent` at `warnAfterMs`   (default 15s) — TUI hint, bus event
 *     2. `stalled` at `stallAfterMs` (default 45s) — forcible termination
 *        recommendation (the core loop can decide whether to kill)
 *
 * Axiom safety:
 *   - A3 (Deterministic Governance): the detector is a pure rule-based
 *     timer. No LLM is in the governance path; thresholds are either
 *     passed in via config or defaulted.
 *   - A6 (Zero-Trust Execution): adds visibility *around* the sandboxed
 *     worker — it does not relax any existing zero-trust invariant.
 *     Workers still propose-then-dispose through their contract.
 *   - A1 (Epistemic Separation): the detector observes the worker's
 *     subprocess but never inspects its reasoning or substitutes for
 *     verification. It only fires structural visibility signals.
 *
 * Why a guardrail rather than a first-class subsystem:
 *   the worker-level heartbeat is a *defensive* observation that belongs
 *   next to prompt-injection and bypass detection — same role (detect
 *   anomalies without trusting the worker) and same callsite (agent loop).
 */

// ── Types ────────────────────────────────────────────────────────────

/**
 * State of a tracked worker session.
 *
 * `healthy`  — last turn arrived within warnAfterMs
 * `silent`   — no turn for warnAfterMs but still within stallAfterMs
 * `stalled`  — no turn for stallAfterMs — caller should treat as dead
 */
export type SilentAgentState = 'healthy' | 'silent' | 'stalled';

export interface SilentAgentConfig {
  /** After this gap (ms) a worker is marked `silent`. Default 15_000. */
  warnAfterMs?: number;
  /** After this gap (ms) a worker is marked `stalled`. Default 45_000. */
  stallAfterMs?: number;
  /** Clock injection for testability. Default `Date.now`. */
  now?: () => number;
}

export interface SilentAgentRecord {
  taskId: string;
  workerId?: string;
  lastTurnAt: number;
  lastEventLabel: string;
  state: SilentAgentState;
}

/**
 * Transition event produced when a record's state changes between ticks.
 * Callers wire these to bus events / TUI hints — the detector itself is
 * side-effect-free so it can be unit-tested without a bus.
 */
export interface SilentAgentTransition {
  taskId: string;
  workerId?: string;
  from: SilentAgentState;
  to: SilentAgentState;
  silentForMs: number;
  lastEventLabel: string;
}

// ── Detector ─────────────────────────────────────────────────────────

const DEFAULT_WARN_AFTER_MS = 15_000;
const DEFAULT_STALL_AFTER_MS = 45_000;

export class SilentAgentDetector {
  private records = new Map<string, SilentAgentRecord>();
  private readonly warnAfterMs: number;
  private readonly stallAfterMs: number;
  private readonly now: () => number;

  constructor(config: SilentAgentConfig = {}) {
    this.warnAfterMs = config.warnAfterMs ?? DEFAULT_WARN_AFTER_MS;
    this.stallAfterMs = config.stallAfterMs ?? DEFAULT_STALL_AFTER_MS;
    this.now = config.now ?? Date.now;

    if (this.stallAfterMs <= this.warnAfterMs) {
      throw new Error(
        `SilentAgentDetector: stallAfterMs (${this.stallAfterMs}) must be > warnAfterMs (${this.warnAfterMs})`,
      );
    }
  }

  /**
   * Register a new worker session. Called once by runAgentLoop right after
   * the subprocess spawns but before the first turn arrives — this primes
   * the timer so an unresponsive init is already detectable.
   */
  register(taskId: string, workerId?: string): void {
    this.records.set(taskId, {
      taskId,
      ...(workerId !== undefined ? { workerId } : {}),
      lastTurnAt: this.now(),
      lastEventLabel: 'session_start',
      state: 'healthy',
    });
  }

  /**
   * Record a worker heartbeat (any turn — tool_calls, done, uncertain,
   * progress pings). This resets the silence timer. `eventLabel` is stored
   * for diagnostics so operators can see what the last activity was.
   */
  heartbeat(taskId: string, eventLabel: string): void {
    const record = this.records.get(taskId);
    if (!record) return;
    record.lastTurnAt = this.now();
    record.lastEventLabel = eventLabel;
    record.state = 'healthy';
  }

  /** Remove a session when it terminates. */
  unregister(taskId: string): void {
    this.records.delete(taskId);
  }

  /**
   * Check all records for state transitions. Returns the list of
   * transitions that occurred during this tick so the caller can emit
   * bus events. Safe to call on any cadence — the detector is purely
   * derivative of `now()`, so overlapping ticks are idempotent.
   */
  tick(): SilentAgentTransition[] {
    const transitions: SilentAgentTransition[] = [];
    const now = this.now();

    for (const record of this.records.values()) {
      const silentForMs = now - record.lastTurnAt;
      const next = this.classify(silentForMs);

      if (next !== record.state) {
        transitions.push({
          taskId: record.taskId,
          ...(record.workerId !== undefined ? { workerId: record.workerId } : {}),
          from: record.state,
          to: next,
          silentForMs,
          lastEventLabel: record.lastEventLabel,
        });
        record.state = next;
      }
    }

    return transitions;
  }

  /** Snapshot all current records — for TUI / debug inspection. */
  snapshot(): ReadonlyArray<SilentAgentRecord> {
    return [...this.records.values()];
  }

  /** Current state of one task, or undefined if not tracked. */
  getState(taskId: string): SilentAgentState | undefined {
    return this.records.get(taskId)?.state;
  }

  private classify(silentForMs: number): SilentAgentState {
    if (silentForMs >= this.stallAfterMs) return 'stalled';
    if (silentForMs >= this.warnAfterMs) return 'silent';
    return 'healthy';
  }
}
