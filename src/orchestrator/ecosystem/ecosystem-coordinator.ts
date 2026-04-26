/**
 * EcosystemCoordinator — the thin integrator that wires the five
 * ecosystem subsystems together and maintains cross-system invariants.
 *
 * Subsystems:
 *   1. RuntimeStateManager     (O1) — Dormant/Awakening/Standby/Working FSM
 *   2. CommitmentLedger        (O2) — accountability backlog
 *   3. DepartmentIndex + TeamManager (O3) — org structure
 *   4. VolunteerRegistry + HelpfulnessTracker (O4) — "I can help" protocol
 *   5. CommitmentBridge        (bridges market + trace events → ledger)
 *
 * Invariants checked by `reconcile()`:
 *   I-E1: every Working engine has at least one open commitment
 *   I-E2: every open commitment has a Working engine (or awakening in warm-up window)
 *   I-E3: department membership matches engine capabilities (auto-healed)
 *
 * On `start()`:
 *   - bridges attach to the bus
 *   - `RuntimeStateManager.recoverFromCrash()` is invoked
 *   - helpfulness tracker starts listening
 *
 * The coordinator is optional — the rest of the system works without it —
 * but when present it is the single handle wiring owns, so there is no
 * cross-subsystem state ambiguity.
 *
 * Source of truth: docs/design/vinyan-os-ecosystem-plan.md §3.1, §5 (O5)
 */

import type { VinyanBus } from '../../core/bus.ts';
import type { ReasoningEngine } from '../types.ts';

import { CommitmentBridge, type TaskFacts } from './commitment-bridge.ts';
import { CommitmentLedger } from './commitment-ledger.ts';
import { DepartmentIndex } from './department.ts';
import { HelpfulnessTracker } from './helpfulness-tracker.ts';
import { RuntimeStateManager } from './runtime-state.ts';
import { TeamManager } from './team.ts';
import {
  VolunteerRegistry,
  selectVolunteer,
  type SelectionVerdict,
  type VolunteerCandidate,
  type VolunteerContext,
} from './volunteer-protocol.ts';

// ── Config ───────────────────────────────────────────────────────────

/**
 * Minimal timer abstraction so tests can swap real setTimeout/clearTimeout
 * for a controllable fake. A single pair of calls is enough — the
 * scheduler uses chained setTimeout (not setInterval) so the handle type
 * is whatever the injected `setTimer` returns.
 */
export interface CoordinatorTimerImpl {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface EcosystemCoordinatorConfig {
  readonly bus: VinyanBus;
  readonly runtime: RuntimeStateManager;
  readonly commitments: CommitmentLedger;
  readonly teams: TeamManager;
  readonly volunteers: VolunteerRegistry;
  readonly helpfulness: HelpfulnessTracker;
  readonly departments: DepartmentIndex;
  /** Resolve task facts by id (used by the commitment bridge). */
  readonly taskResolver: (taskId: string) => TaskFacts | null;
  /** Produce the current engine roster (for department refresh). */
  readonly engineRoster: () => readonly Pick<ReasoningEngine, 'id' | 'capabilities'>[];
  readonly now?: () => number;
  /**
   * Workspace root — when provided, `start()` attaches the team blackboard
   * chokidar watcher on `<workspace>/.vinyan/teams/**\/*.md` and tears it
   * down in `stop()`. Omit to skip the watcher (tests, embedded use).
   */
  readonly workspace?: string;
  /**
   * Reconcile cadence in ms. 0 / undefined disables the scheduler — callers
   * must then invoke `reconcile()` manually. Default is off so tests and
   * legacy paths don't leak timers.
   */
  readonly reconcileIntervalMs?: number;
  /**
   * Optional timer injection. Defaults to the global setTimeout /
   * clearTimeout — tests use a fake clock to drive deterministic ticks.
   */
  readonly timer?: CoordinatorTimerImpl;
}

// ── Reconciliation ───────────────────────────────────────────────────

export type InvariantId = 'I-E1' | 'I-E2' | 'I-E3';

export interface InvariantViolation {
  readonly id: InvariantId;
  readonly subject: string; // engineId or commitmentId
  readonly detail: string;
}

export interface ReconcileReport {
  readonly checkedAt: number;
  readonly violations: readonly InvariantViolation[];
  readonly departmentsRefreshed: number;
  /** Count of commitments past their deadline that were force-closed as `failed`. */
  readonly expiredCommitmentsReaped: number;
}

// ── Coordinator ──────────────────────────────────────────────────────

export class EcosystemCoordinator {
  private readonly bus: VinyanBus;
  private readonly runtime: RuntimeStateManager;
  private readonly commitments: CommitmentLedger;
  private readonly teams: TeamManager;
  private readonly volunteers: VolunteerRegistry;
  private readonly helpfulness: HelpfulnessTracker;
  private readonly departments: DepartmentIndex;
  private readonly resolveTask: (taskId: string) => TaskFacts | null;
  private readonly engineRoster: () => readonly Pick<ReasoningEngine, 'id' | 'capabilities'>[];
  private readonly now: () => number;
  private readonly commitmentBridge: CommitmentBridge;
  private readonly reconcileIntervalMs: number;
  private readonly timer: CoordinatorTimerImpl;
  private readonly workspace?: string;
  private reconcileHandle: unknown = null;
  private reconcileInFlight = false;
  private unsubEngineRegistered: (() => void) | null = null;
  private unsubEngineDeregistered: (() => void) | null = null;
  private teamBlackboardWatcherDispose: (() => void) | null = null;
  private started = false;

  constructor(config: EcosystemCoordinatorConfig) {
    this.bus = config.bus;
    this.runtime = config.runtime;
    this.commitments = config.commitments;
    this.teams = config.teams;
    this.volunteers = config.volunteers;
    this.helpfulness = config.helpfulness;
    this.departments = config.departments;
    this.resolveTask = config.taskResolver;
    this.engineRoster = config.engineRoster;
    this.now = config.now ?? (() => Date.now());
    this.reconcileIntervalMs = config.reconcileIntervalMs ?? 0;
    this.workspace = config.workspace;
    this.timer = config.timer ?? {
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    this.commitmentBridge = new CommitmentBridge({
      ledger: this.commitments,
      bus: this.bus,
      taskResolver: this.resolveTask,
    });
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  start(): void {
    if (this.started) return;
    this.commitmentBridge.start();
    this.helpfulness.start();
    // Crash recovery: any engine stuck in working/awakening resets to standby.
    this.runtime.recoverFromCrash();
    // Build the department index from the current roster. Defensive try/catch
    // mirrors the scheduled-reconcile behavior so a flaky roster provider
    // cannot brick the coordinator at startup.
    try {
      this.departments.refresh(this.engineRoster());
    } catch (err) {
      console.error(
        '[vinyan] ecosystem: initial department refresh failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
    this.started = true;
    this.scheduleNextReconcile();

    // Phase 3 — attach team-blackboard filesystem watcher when a workspace
    // is available. The watcher is owned by TeamManager; we keep the
    // disposer here so stop() can tear it down deterministically.
    if (this.workspace) {
      this.teamBlackboardWatcherDispose = this.teams.attachBlackboardWatcher(this.workspace);
    }

    // Subscribe to engine registry events so department membership stays
    // fresh and newly-registered engines are auto-registered into the
    // runtime FSM (otherwise they remain unknown and the selector filters
    // them out).
    this.unsubEngineRegistered = this.bus.on('engine:registered', (payload) => {
      try {
        this.departments.upsertEngine({
          id: payload.engineId,
          capabilities: [...payload.capabilities],
        });
        if (!this.runtime.get(payload.engineId)) {
          this.runtime.register(payload.engineId);
          this.runtime.awaken(payload.engineId, 'engine-registered');
          this.runtime.markReady(payload.engineId, 'engine-registered');
        }
      } catch (err) {
        console.error(
          '[vinyan] ecosystem: engine:registered handler failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
    });
    this.unsubEngineDeregistered = this.bus.on('engine:deregistered', (payload) => {
      try {
        this.departments.removeEngine(payload.engineId);
        // Keep the runtime row (audit log stays valid); just force dormant
        // so selector pre-filter drops it.
        if (this.runtime.get(payload.engineId)) {
          this.runtime.markDormant(payload.engineId, 'engine-deregistered');
        }
      } catch (err) {
        console.error(
          '[vinyan] ecosystem: engine:deregistered handler failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
    });
  }

  stop(): void {
    if (!this.started) return;
    this.commitmentBridge.stop();
    this.helpfulness.stop();
    this.unsubEngineRegistered?.();
    this.unsubEngineRegistered = null;
    this.unsubEngineDeregistered?.();
    this.unsubEngineDeregistered = null;
    if (this.reconcileHandle !== null) {
      this.timer.clearTimer(this.reconcileHandle);
      this.reconcileHandle = null;
    }
    this.teamBlackboardWatcherDispose?.();
    this.teamBlackboardWatcherDispose = null;
    this.started = false;
  }

  // ── Scheduled reconcile (chained setTimeout — avoids pile-up) ────

  private scheduleNextReconcile(): void {
    if (!this.started || this.reconcileIntervalMs <= 0) return;
    this.reconcileHandle = this.timer.setTimer(
      () => this.runScheduledReconcile(),
      this.reconcileIntervalMs,
    );
  }

  private runScheduledReconcile(): void {
    this.reconcileHandle = null;
    if (!this.started) return;
    // Reentrancy guard: if a previous sweep is still running (shouldn't
    // happen with chained setTimeout, but defensive), skip this tick.
    if (this.reconcileInFlight) {
      this.scheduleNextReconcile();
      return;
    }
    this.reconcileInFlight = true;
    const startedAt = this.now();
    let violationCount = 0;
    let departmentsRefreshed = 0;
    let errorMessage: string | undefined;
    try {
      const report = this.reconcile();
      violationCount = report.violations.length;
      departmentsRefreshed = report.departmentsRefreshed;
      // Emit per-violation events so dashboards can aggregate/alert.
      for (const v of report.violations) {
        this.bus.emit('ecosystem:invariant_violation', {
          id: v.id,
          subject: v.subject,
          detail: v.detail,
          checkedAt: report.checkedAt,
        });
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      console.error('[vinyan] ecosystem: reconcile error:', errorMessage);
    } finally {
      this.reconcileInFlight = false;
      this.bus.emit('ecosystem:reconcile_tick', {
        checkedAt: startedAt,
        violationCount,
        departmentsRefreshed,
        durationMs: this.now() - startedAt,
        ...(errorMessage ? { error: errorMessage } : {}),
      });
      this.scheduleNextReconcile();
    }
  }

  // ── Subsystem accessors ──────────────────────────────────────────
  // Expose subsystems read-only so callers can query them without having
  // to thread each one through DI separately.

  get runtimeStates(): RuntimeStateManager {
    return this.runtime;
  }

  get commitmentLedger(): CommitmentLedger {
    return this.commitments;
  }

  get teamManager(): TeamManager {
    return this.teams;
  }

  get volunteerRegistry(): VolunteerRegistry {
    return this.volunteers;
  }

  get helpfulnessTracker(): HelpfulnessTracker {
    return this.helpfulness;
  }

  get departmentIndex(): DepartmentIndex {
    return this.departments;
  }

  // ── Volunteer fallback ───────────────────────────────────────────

  /**
   * Market-empty fallback: pick a winning volunteer for a task when the
   * auction returned no winner. Deterministic (A3): all standby engines
   * in the task's department (or fleet-wide when no department is given)
   * declare an implicit offer, the caller supplies scoring context, and
   * the highest score wins.
   *
   * When a winner is picked, a VolunteerOffer is persisted, accepted, and
   * bound to a new Commitment. The caller is responsible for flipping the
   * runtime state to Working (usually via `markWorking` on dispatch).
   *
   * Returns `null` when no standby engine can volunteer.
   */
  attemptVolunteerFallback(params: {
    taskId: string;
    goal: string;
    targetFiles?: readonly string[];
    deadlineAt: number;
    departmentId?: string;
    /** Scoring context for each eligible engine. Usually supplied by the selector. */
    contextProvider: (engineId: string) => VolunteerContext;
  }): { engineId: string; commitmentId: string; verdict: SelectionVerdict } | null {
    // 1. Build the eligible pool: standby + Working-with-capacity.
    const eligible = new Set<string>();
    for (const snap of this.runtime.listByState('standby')) {
      eligible.add(snap.agentId);
    }
    for (const snap of this.runtime.listByState('working')) {
      if (snap.activeTaskCount < snap.capacityMax) eligible.add(snap.agentId);
    }

    // 2. Narrow by department if asked and the department has members.
    if (params.departmentId) {
      const members = new Set(
        this.departments.getEnginesInDepartment(params.departmentId),
      );
      if (members.size > 0) {
        for (const id of [...eligible]) {
          if (!members.has(id)) eligible.delete(id);
        }
      }
    }

    if (eligible.size === 0) return null;

    // 3. Record offers for each eligible engine (persist for audit).
    const candidates: VolunteerCandidate[] = [];
    for (const engineId of eligible) {
      const offer = this.volunteers.declareOffer({ taskId: params.taskId, engineId });
      candidates.push({ offer, context: params.contextProvider(engineId) });
    }

    // 4. Pure selection — no persistence side effects.
    const verdict = selectVolunteer(candidates);
    if (!verdict.winner) {
      // All candidates scored zero. Decline every offer so the row is not
      // left in an indeterminate (accepted_at=NULL, declined_reason=NULL)
      // state forever. Delegate to finalize() with a sentinel commitmentId
      // — since there is no winner, finalize's accept branch is skipped
      // and all offers land in declineOffer with `verdict.reason`.
      this.volunteers.finalize(params.taskId, candidates, '__no-winner__');
      return null;
    }

    // 5. Open the real commitment with the winner bound, then finalize to
    //    link winner's offer → commitmentId and decline the rest.
    const commitment = this.commitments.open({
      engineId: verdict.winner.engineId,
      taskId: params.taskId,
      goal: params.goal,
      targetFiles: params.targetFiles ?? [],
      deadlineAt: params.deadlineAt,
    });
    this.volunteers.finalize(params.taskId, candidates, commitment.commitmentId);

    return {
      engineId: verdict.winner.engineId,
      commitmentId: commitment.commitmentId,
      verdict,
    };
  }

  // ── Reconciliation (cross-system invariants) ─────────────────────

  reconcile(): ReconcileReport {
    const checkedAt = this.now();
    const violations: InvariantViolation[] = [];

    // Expired-commitment reaper — closes commitments whose deadline has
    // passed as `failed` with evidence "deadline exceeded". Runs first so
    // the subsequent I-E1/I-E2 checks don't flag commitments that the
    // reaper is about to close anyway.
    const expiredCommitmentsReaped = this.commitments.reapExpired(checkedAt);

    // I-E3: rebuild department index from the live roster. This is the
    // cheap self-heal path — any capability changes since last refresh
    // get picked up.
    const roster = this.engineRoster();
    this.departments.refresh(roster);

    // I-E1: every Working engine must have ≥1 open commitment.
    for (const snap of this.runtime.listByState('working')) {
      const open = this.commitments.openByEngine(snap.agentId);
      if (open.length === 0) {
        violations.push({
          id: 'I-E1',
          subject: snap.agentId,
          detail: 'engine is Working but has no open commitment',
        });
      }
    }

    // I-E2: every open commitment must belong to a Working (or Awakening)
    // engine. Commitments held by Standby/Dormant engines are orphans —
    // something opened the commitment but never flipped the runtime state.
    const workingIds = new Set(this.runtime.listByState('working').map((s) => s.agentId));
    const awakeningIds = new Set(
      this.runtime.listByState('awakening').map((s) => s.agentId),
    );
    const seenEngines = new Set<string>();
    for (const snap of [
      ...this.runtime.listByState('standby'),
      ...this.runtime.listByState('dormant'),
    ]) {
      if (seenEngines.has(snap.agentId)) continue;
      seenEngines.add(snap.agentId);
      const open = this.commitments.openByEngine(snap.agentId);
      for (const c of open) {
        if (!workingIds.has(c.engineId) && !awakeningIds.has(c.engineId)) {
          violations.push({
            id: 'I-E2',
            subject: c.commitmentId,
            detail: `commitment held by ${c.engineId} in state ${snap.state}`,
          });
        }
      }
    }

    return {
      checkedAt,
      violations,
      departmentsRefreshed: roster.length,
      expiredCommitmentsReaped,
    };
  }
}
