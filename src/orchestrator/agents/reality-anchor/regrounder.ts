/**
 * RealityAnchorReGrounder — Phase C4 state machine.
 *
 * Subscribes to:
 *   - `psychosis:trigger` → enters quarantine for the affected persona
 *     and walks through the rebuild → prune → replay sub-actions
 *     synchronously. Each sub-action emits an audit row; in MVP the
 *     work bodies are no-op (see `Stage` mapping below). Real workflow
 *     engines hook in by subclassing or overriding `runStageWork`.
 *
 *   - `trace:record` → for personas in `shadow-mode`, increments their
 *     clean-streak when the trace is clean (success outcome AND no
 *     delusion). On reaching `cleanStreakRequired` consecutive cleans,
 *     transitions persona back to `active` (writes the `reentry`
 *     audit row). A non-clean trace resets the streak; the persona
 *     stays in shadow-mode. A new psychosis:trigger during shadow-mode
 *     bounces persona back to quarantined to restart the loop.
 *
 * State persistence: in-memory cache + on-boot rehydrate from the
 * `reality_anchor_audit` table's latest-row-per-persona view. Survives
 * orchestrator restarts via the audit ledger; the cache is just speed.
 *
 * A3 honesty: every transition is rule-based. No LLM in the recovery
 * path. Deterministic given a fixed input event stream + clock.
 */

import type { VinyanBus } from '../../../core/bus.ts';
import type { RealityAnchorAuditStore } from '../../../db/reality-anchor-audit-store.ts';
import type { ParameterStore } from '../../adaptive-params/parameter-store.ts';
import type { ExecutionTrace } from '../../types.ts';
import { assertValidTransition, type RealityAnchorStage, type RealityAnchorState } from './state.ts';

export interface RealityAnchorReGrounderOptions {
  readonly bus: VinyanBus;
  readonly auditStore: RealityAnchorAuditStore;
  /** Optional — when supplied, ceilings are read live from the registry. */
  readonly parameterStore?: ParameterStore;
  /** Override the clean-streak required for reentry. Default: parameter or 5. */
  readonly cleanStreakRequired?: number;
  /** Test-injectable clock so audit timestamps are deterministic. */
  readonly clock?: () => number;
}

const STREAK_PARAM_KEY = 'reality_anchor.shadow_clean_streak_required';
const DEFAULT_STREAK_REQUIRED = 5;

export class RealityAnchorReGrounder {
  private readonly bus: VinyanBus;
  private readonly auditStore: RealityAnchorAuditStore;
  private readonly parameterStore: ParameterStore | undefined;
  private readonly cleanStreakRequiredOverride: number | undefined;
  private readonly clock: () => number;

  /** Current state per persona. Hydrated from audit on first access. */
  private readonly states = new Map<string, RealityAnchorState>();
  /** Consecutive clean traces while in shadow-mode. Reset on non-clean. */
  private readonly shadowStreak = new Map<string, number>();
  /** Latest audit timestamp per persona — guarantees monotonic recordedAt. */
  private readonly lastAuditTs = new Map<string, number>();
  /** True after `hydrateFromAudit` has run; prevents double-hydrate on attach. */
  private hydrated = false;

  constructor(opts: RealityAnchorReGrounderOptions) {
    this.bus = opts.bus;
    this.auditStore = opts.auditStore;
    this.parameterStore = opts.parameterStore;
    this.cleanStreakRequiredOverride = opts.cleanStreakRequired;
    this.clock = opts.clock ?? Date.now;
  }

  /**
   * Subscribe to `psychosis:trigger` and `trace:record`. Returns an
   * unsubscribe handle that detaches both. Idempotent across restarts —
   * hydrates from audit on first call so persona states survive.
   */
  attach(): () => void {
    this.hydrateFromAudit();
    const offTrigger = this.bus.on('psychosis:trigger', (e) => {
      this.startRegrounding(e.personaId, `psychosis:${e.signal}=${e.value.toFixed(3)}>${e.ceiling.toFixed(3)}`);
    });
    const offTrace = this.bus.on('trace:record', (e) => {
      this.onTraceRecord(e.trace);
    });
    return () => {
      offTrigger();
      offTrace();
    };
  }

  /**
   * Read current state of a persona. Returns `'active'` for personas
   * never seen by the regrounder (the default; no audit row exists).
   */
  getState(personaId: string): RealityAnchorState {
    this.hydrateFromAudit();
    return this.states.get(personaId) ?? 'active';
  }

  /** Whether the persona may dispatch new tasks (active or shadow-mode). */
  canDispatch(personaId: string): boolean {
    const state = this.getState(personaId);
    return state === 'active' || state === 'shadow-mode';
  }

  /**
   * Manually start re-grounding (operator override). Walks the workflow
   * synchronously: writes the quarantine audit row, then the rebuild /
   * prune / replay rows. Real implementations would interleave actual
   * work; the MVP fires audit-only and lets real workflows hook in
   * later.
   *
   * Idempotent: re-calling on a persona already past `active` resets
   * the workflow to quarantined again. The audit table records the
   * cycle so operator dashboards see the bounce.
   */
  startRegrounding(personaId: string, reason: string): void {
    const prev = this.getState(personaId);
    // active → quarantined OR rebuilding/shadow-mode → quarantined (bounce)
    this.transitionTo(personaId, prev, 'quarantined', 'quarantine', reason);
    this.transitionTo(personaId, 'quarantined', 'rebuilding', 'rebuild', reason);
    // sub-actions emit audit rows but stay in `rebuilding`
    this.recordSubAction(personaId, 'prune', reason);
    this.recordSubAction(personaId, 'replay', reason);
    // After replay, persona implicitly enters shadow-mode
    this.transitionTo(personaId, 'rebuilding', 'shadow-mode', 'replay', `${reason}; shadow-entry`);
    this.shadowStreak.set(personaId, 0);
  }

  /**
   * Drive the trace observer manually (test seam). Public so tests can
   * verify shadow-streak accounting + reentry without going through the
   * bus.
   */
  onTraceRecord(trace: ExecutionTrace): void {
    const personaId = trace.agentId;
    if (!personaId) return;
    const state = this.getState(personaId);
    if (state !== 'shadow-mode') return; // only counts during shadow

    if (isCleanTrace(trace)) {
      const streak = (this.shadowStreak.get(personaId) ?? 0) + 1;
      this.shadowStreak.set(personaId, streak);
      const required = this.cleanStreakRequired();
      if (streak >= required) {
        this.transitionTo(personaId, 'shadow-mode', 'active', 'reentry', `clean-streak ${streak}/${required}`);
        this.shadowStreak.delete(personaId);
      }
    } else {
      // Reset streak on non-clean trace; persona stays in shadow-mode
      // until either a fresh psychosis:trigger bounces them back to
      // quarantined or they accumulate a clean streak from scratch.
      this.shadowStreak.set(personaId, 0);
    }
  }

  /** Test seam — read current shadow-streak count for a persona. */
  shadowStreakFor(personaId: string): number {
    return this.shadowStreak.get(personaId) ?? 0;
  }

  // ── internal ────────────────────────────────────────────────────────────

  private cleanStreakRequired(): number {
    if (this.cleanStreakRequiredOverride !== undefined) return this.cleanStreakRequiredOverride;
    if (this.parameterStore) {
      try {
        const n = this.parameterStore.getInteger(STREAK_PARAM_KEY);
        if (n > 0) return n;
      } catch {
        // fall through to default
      }
    }
    return DEFAULT_STREAK_REQUIRED;
  }

  private hydrateFromAudit(): void {
    if (this.hydrated) return;
    this.hydrated = true;
    try {
      const map = this.auditStore.getLatestStateMap();
      for (const [personaId, state] of map) {
        this.states.set(personaId, state);
      }
    } catch {
      // Hydrate failure (e.g. table missing in tests) — treat all
      // personas as `active`. The audit ledger remains the source of
      // truth, but we degrade gracefully.
    }
  }

  /** State transition + audit row, with monotonic timestamp guarantee. */
  private transitionTo(
    personaId: string,
    from: RealityAnchorState,
    to: RealityAnchorState,
    stage: RealityAnchorStage,
    reason: string,
  ): void {
    assertValidTransition(from, to);
    const ts = this.nextTs(personaId);
    this.auditStore.recordAudit({
      personaId,
      prevState: from,
      newState: to,
      stage,
      reason,
      recordedAt: ts,
    });
    this.states.set(personaId, to);
  }

  /** Sub-action audit row (no state change — same prev/new state). */
  private recordSubAction(personaId: string, stage: RealityAnchorStage, reason: string): void {
    const state = this.states.get(personaId) ?? 'active';
    const ts = this.nextTs(personaId);
    this.auditStore.recordAudit({
      personaId,
      prevState: state,
      newState: state,
      stage,
      reason,
      recordedAt: ts,
    });
  }

  /**
   * Generate a strictly-monotonic timestamp per persona so the
   * (persona_id, recorded_at) PK doesn't collide on rapid sub-action
   * sequences. If the wall clock hasn't advanced, increment by 1ms.
   */
  private nextTs(personaId: string): number {
    const now = this.clock();
    const last = this.lastAuditTs.get(personaId) ?? 0;
    const ts = now > last ? now : last + 1;
    this.lastAuditTs.set(personaId, ts);
    return ts;
  }
}

function isCleanTrace(trace: ExecutionTrace): boolean {
  if (trace.outcome !== 'success') return false;
  if (trace.delusionResult?.kind === 'delusion') return false;
  return true;
}
