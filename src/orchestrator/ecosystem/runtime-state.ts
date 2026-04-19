/**
 * Runtime-state FSM for the Vinyan agent ecosystem.
 *
 * This axis is *orthogonal* to the career FSM in
 * `src/orchestrator/fleet/worker-lifecycle.ts`
 * (probation → active → demoted → retired).
 *
 * - **Career state** answers: "does this agent have a trusted track record?"
 *   (slow, days/weeks)
 * - **Runtime state** answers: "is this agent able to take work *right now*?"
 *   (fast, seconds/minutes)
 *
 * An `active` agent can be in any runtime state; a `probation` agent can too.
 * Enforcement layers (bid filter, dispatch gate) consult BOTH axes.
 *
 * Source of truth: docs/design/vinyan-os-ecosystem-plan.md §2.1, §3.1
 */

import type { VinyanBus } from '../../core/bus.ts';
import type { AgentRuntimeStore } from '../../db/agent-runtime-store.ts';

// ── Types ────────────────────────────────────────────────────────────

export type RuntimeState = 'dormant' | 'awakening' | 'standby' | 'working';

export interface AgentRuntimeSnapshot {
  readonly agentId: string;
  readonly state: RuntimeState;
  readonly activeTaskCount: number;
  readonly capacityMax: number;
  readonly lastTransitionAt: number;
  readonly lastTransitionReason: string | null;
  readonly lastHeartbeatAt: number;
}

export interface RuntimeTransition {
  readonly agentId: string;
  readonly from: RuntimeState;
  readonly to: RuntimeState;
  readonly reason: string;
  readonly taskId?: string;
  readonly activeTaskCount: number;
  readonly at: number;
}

export interface RuntimeStateManagerConfig {
  readonly store: AgentRuntimeStore;
  readonly bus?: VinyanBus;
  readonly now?: () => number;
}

// ── FSM rules (pure, A3) ─────────────────────────────────────────────

/**
 * Allowed transitions. The special case `working → working` represents an
 * additional task assignment while the agent is still working on others
 * (guarded by capacity in `markWorking`).
 *
 * Anywhere → dormant is allowed to model shutdown / eviction; callers supply
 * an explicit reason.
 */
const ALLOWED: Readonly<Record<RuntimeState, ReadonlySet<RuntimeState>>> = {
  dormant: new Set<RuntimeState>(['awakening', 'dormant']),
  awakening: new Set<RuntimeState>(['standby', 'dormant']),
  standby: new Set<RuntimeState>(['working', 'dormant']),
  working: new Set<RuntimeState>(['working', 'standby', 'dormant']),
};

export function isTransitionAllowed(from: RuntimeState, to: RuntimeState): boolean {
  return ALLOWED[from].has(to);
}

// ── Manager ──────────────────────────────────────────────────────────

/**
 * Owns the runtime-state table. All transitions go through this class so
 * the FSM, event emission, and audit log stay consistent.
 *
 * Thread-safety: single-process. Callers that dispatch concurrently must
 * serialize through `markWorking`/`markStandby` — the store uses SQLite
 * transactions for the row+log write, so no intermediate state is visible.
 */
export class RuntimeStateManager {
  private readonly store: AgentRuntimeStore;
  private readonly bus?: VinyanBus;
  private readonly now: () => number;

  constructor(config: RuntimeStateManagerConfig) {
    this.store = config.store;
    this.bus = config.bus;
    this.now = config.now ?? (() => Date.now());
  }

  /** Ensure a row exists for the agent. New agents start as dormant. */
  register(agentId: string, capacityMax = 1): AgentRuntimeSnapshot {
    const existing = this.store.get(agentId);
    if (existing) return existing;
    const t = this.now();
    this.store.insert({
      agentId,
      state: 'dormant',
      activeTaskCount: 0,
      capacityMax,
      lastTransitionAt: t,
      lastTransitionReason: 'registered',
      lastHeartbeatAt: t,
    });
    return this.store.get(agentId)!;
  }

  /** Snapshot read-through. */
  get(agentId: string): AgentRuntimeSnapshot | null {
    return this.store.get(agentId);
  }

  /** List all agents in a given state (useful for scheduler/auction scans). */
  listByState(state: RuntimeState): readonly AgentRuntimeSnapshot[] {
    return this.store.listByState(state);
  }

  // ── High-level transitions (lifecycle hooks) ─────────────────────

  /** dormant → awakening. Worker process booted, loading context. */
  awaken(agentId: string, reason = 'boot'): RuntimeTransition {
    return this.transition(agentId, 'awakening', reason);
  }

  /** awakening → standby. Worker is ready to accept work. */
  markReady(agentId: string, reason = 'warmup-complete'): RuntimeTransition {
    return this.transition(agentId, 'standby', reason);
  }

  /**
   * standby → working OR working → working (if capacity allows).
   * Increments `activeTaskCount`.
   */
  markWorking(agentId: string, taskId: string, reason = 'dispatch'): RuntimeTransition {
    const snap = this.requireSnapshot(agentId);
    if (snap.state === 'working' && snap.activeTaskCount >= snap.capacityMax) {
      throw new Error(
        `runtime-state: agent ${agentId} at capacity (${snap.activeTaskCount}/${snap.capacityMax}) — cannot assign task ${taskId}`,
      );
    }
    return this.transitionInternal(agentId, 'working', reason, taskId, +1);
  }

  /**
   * working → standby (when last task returns) OR working → working (if
   * other tasks still in flight). Decrements `activeTaskCount`.
   */
  markTaskComplete(agentId: string, taskId: string, reason = 'complete'): RuntimeTransition {
    const snap = this.requireSnapshot(agentId);
    if (snap.state !== 'working') {
      throw new Error(
        `runtime-state: agent ${agentId} not working (state=${snap.state}) — cannot complete task ${taskId}`,
      );
    }
    const next = snap.activeTaskCount - 1 <= 0 ? 'standby' : 'working';
    return this.transitionInternal(agentId, next, reason, taskId, -1);
  }

  /**
   * Any → dormant. Used by shutdown, idle-timeout sweeps, eviction.
   * Resets active_task_count to 0 because any in-flight work is abandoned.
   */
  markDormant(agentId: string, reason: string): RuntimeTransition {
    const snap = this.requireSnapshot(agentId);
    const t = this.now();
    this.store.applyTransition({
      agentId,
      fromState: snap.state,
      toState: 'dormant',
      reason,
      at: t,
      activeTaskCountDelta: 0,
      resetActiveTaskCount: true,
    });
    const transition: RuntimeTransition = {
      agentId,
      from: snap.state,
      to: 'dormant',
      reason,
      activeTaskCount: 0,
      at: t,
    };
    this.bus?.emit('ecosystem:runtime_transition', transition);
    return transition;
  }

  /** Record a heartbeat without changing state. */
  heartbeat(agentId: string): void {
    this.store.updateHeartbeat(agentId, this.now());
  }

  /**
   * Crash-recovery sweep. Any agent found in `working` or `awakening` at
   * startup is force-dropped to `standby` with an explicit "crash-recovered"
   * reason. Active task count is reset to 0 because any prior assignments
   * did not survive the crash.
   */
  recoverFromCrash(reason = 'crash-recovered'): readonly RuntimeTransition[] {
    const out: RuntimeTransition[] = [];
    for (const stuck of [
      ...this.store.listByState('working'),
      ...this.store.listByState('awakening'),
    ]) {
      const t = this.now();
      const transition: RuntimeTransition = {
        agentId: stuck.agentId,
        from: stuck.state,
        to: 'standby',
        reason,
        activeTaskCount: 0,
        at: t,
      };
      this.store.applyTransition({
        agentId: stuck.agentId,
        fromState: stuck.state,
        toState: 'standby',
        reason,
        at: t,
        activeTaskCountDelta: -stuck.activeTaskCount,
        resetActiveTaskCount: true,
      });
      this.bus?.emit('ecosystem:runtime_transition', transition);
      out.push(transition);
    }
    return out;
  }

  // ── Internals ────────────────────────────────────────────────────

  /**
   * Simple transition that doesn't change active_task_count (awaken, mark-ready).
   * Throws on illegal transitions.
   */
  private transition(agentId: string, to: RuntimeState, reason: string): RuntimeTransition {
    return this.transitionInternal(agentId, to, reason, undefined, 0);
  }

  private transitionInternal(
    agentId: string,
    to: RuntimeState,
    reason: string,
    taskId: string | undefined,
    taskCountDelta: number,
  ): RuntimeTransition {
    const snap = this.requireSnapshot(agentId);
    if (!isTransitionAllowed(snap.state, to)) {
      throw new Error(
        `runtime-state: illegal transition ${snap.state} → ${to} for agent ${agentId} (reason: ${reason})`,
      );
    }
    const t = this.now();
    this.store.applyTransition({
      agentId,
      fromState: snap.state,
      toState: to,
      reason,
      taskId,
      at: t,
      activeTaskCountDelta: taskCountDelta,
    });
    const after = this.store.get(agentId)!;
    const transition: RuntimeTransition = {
      agentId,
      from: snap.state,
      to,
      reason,
      ...(taskId !== undefined ? { taskId } : {}),
      activeTaskCount: after.activeTaskCount,
      at: t,
    };
    this.bus?.emit('ecosystem:runtime_transition', transition);
    return transition;
  }

  private requireSnapshot(agentId: string): AgentRuntimeSnapshot {
    const snap = this.store.get(agentId);
    if (!snap) {
      throw new Error(`runtime-state: agent ${agentId} not registered`);
    }
    return snap;
  }
}
