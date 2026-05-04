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
import type { PersonaFactCitationsStore } from '../../../db/persona-fact-citations-store.ts';
import type { RealityAnchorAuditStore } from '../../../db/reality-anchor-audit-store.ts';
import type { TraceStore } from '../../../db/trace-store.ts';
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
  /**
   * Persona-fact-citation store. When supplied, the `rebuild` sub-action
   * drops the persona's stale citations (older than `rebuildHorizonMs`)
   * so the next verify cycle writes fresh ones. When unset, rebuild
   * audits but does no work.
   */
  readonly citationsStore?: PersonaFactCitationsStore;
  /**
   * Trace store. When supplied, the `replay` sub-action scans the
   * persona's recent traces and reports how many were delusion-flagged.
   * When unset, replay audits but does no work.
   */
  readonly traceStore?: TraceStore;
  /**
   * Maximum age of citations the `rebuild` sub-action keeps. Older
   * citations are dropped on rebuild. Default: 7 days.
   */
  readonly rebuildHorizonMs?: number;
  /**
   * How many recent traces `replay` scans for delusion-flagged outcomes.
   * Default: 20.
   */
  readonly replayWindowSize?: number;
}

const STREAK_PARAM_KEY = 'reality_anchor.shadow_clean_streak_required';
const DEFAULT_STREAK_REQUIRED = 5;
const DEFAULT_REBUILD_HORIZON_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_REPLAY_WINDOW_SIZE = 20;

export class RealityAnchorReGrounder {
  private readonly bus: VinyanBus;
  private readonly auditStore: RealityAnchorAuditStore;
  private readonly parameterStore: ParameterStore | undefined;
  private readonly cleanStreakRequiredOverride: number | undefined;
  private readonly clock: () => number;
  private readonly citationsStore: PersonaFactCitationsStore | undefined;
  private readonly traceStore: TraceStore | undefined;
  private readonly rebuildHorizonMs: number;
  private readonly replayWindowSize: number;

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
    this.citationsStore = opts.citationsStore;
    this.traceStore = opts.traceStore;
    this.rebuildHorizonMs = opts.rebuildHorizonMs ?? DEFAULT_REBUILD_HORIZON_MS;
    this.replayWindowSize = opts.replayWindowSize ?? DEFAULT_REPLAY_WINDOW_SIZE;
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
    // 1. quarantine — entering quarantined state
    this.transitionTo(personaId, prev, 'quarantined', 'quarantine', reason);
    // 2. rebuild — drop stale citations + transition into rebuilding
    const rebuildOutcome = this.runRebuild(personaId);
    this.transitionTo(personaId, 'quarantined', 'rebuilding', 'rebuild', `${reason}; ${rebuildOutcome}`);
    // 3. prune — sub-action; stays in rebuilding state
    const pruneOutcome = this.runPrune(personaId);
    this.recordSubAction(personaId, 'prune', `${reason}; ${pruneOutcome}`);
    // 4. replay — scan recent traces + transition into shadow-mode
    const replayOutcome = this.runReplay(personaId);
    this.transitionTo(personaId, 'rebuilding', 'shadow-mode', 'replay', `${reason}; ${replayOutcome}`);
    this.shadowStreak.set(personaId, 0);
  }

  /**
   * Rebuild work body — drop the persona's citations older than
   * `rebuildHorizonMs` so the next verify cycle writes fresh citations
   * at current hashes. Returns a one-line summary for the audit reason.
   *
   * No-op when the citations store wasn't wired (test fixture).
   */
  private runRebuild(personaId: string): string {
    if (!this.citationsStore) return 'rebuild=skipped (no citations store)';
    const cutoff = this.clock() - this.rebuildHorizonMs;
    const dropped = this.citationsStore.pruneOlderThanForPersona(personaId, cutoff);
    return `rebuild=dropped ${dropped} stale citation(s) older than ${Math.round(this.rebuildHorizonMs / (24 * 60 * 60 * 1000))}d`;
  }

  /**
   * Prune work body — Phase C4-followup. Drops the persona's
   * "superseded" citations: for each fact the persona has cited
   * multiple times, keep only the latest. Collapses the belief
   * ledger to exactly one citation per fact.
   *
   * Distinct from `rebuild` (time-based, drops citations >7d) and
   * from DelusionDetector's stale check (compares against current
   * source hash). This handles the case where the persona has
   * RE-CITED a fact at a different hash in a later task — the
   * earlier append-only row is now historical noise that recovery
   * should drop.
   *
   * The plan §11 originally framed this as "drop tier-3 evidence"
   * via A5 confidence tiers. The current world-graph schema doesn't
   * carry a tier_reliability column; superseded-citation dedup is
   * the schema-honest interpretation of the same intent (the latest
   * citation IS the persona's most recent confidence statement;
   * older same-fact citations are by definition superseded).
   *
   * No-op when the citations store wasn't wired (test fixture).
   */
  private runPrune(personaId: string): string {
    if (!this.citationsStore) return 'prune=skipped (no citations store)';
    const dropped = this.citationsStore.pruneSupersededForPersona(personaId);
    return `prune=dropped ${dropped} superseded citation(s)`;
  }

  /**
   * Replay work body — scan the persona's most recent `replayWindowSize`
   * traces and report how many were delusion-flagged. The count is
   * surfaced in the audit reason so operators see how "off-reality"
   * the persona's recent history is at re-grounding time.
   *
   * No-op when the trace store wasn't wired (test fixture).
   */
  private runReplay(personaId: string): string {
    if (!this.traceStore) return 'replay=skipped (no trace store)';
    const recent = this.traceStore.findByAgent(personaId, this.replayWindowSize);
    let delusions = 0;
    for (const t of recent) {
      if (t.delusionResult?.kind === 'delusion') delusions++;
    }
    return `replay=scanned ${recent.length} trace(s), ${delusions} delusion-flagged`;
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
