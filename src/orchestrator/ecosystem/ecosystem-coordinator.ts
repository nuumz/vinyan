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
import { DepartmentIndex, type DepartmentSeed } from './department.ts';
import { HelpfulnessTracker } from './helpfulness-tracker.ts';
import { RuntimeStateManager } from './runtime-state.ts';
import { TeamManager } from './team.ts';
import { VolunteerRegistry } from './volunteer-protocol.ts';

// ── Config ───────────────────────────────────────────────────────────

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
    // Build the department index from the current roster.
    this.departments.refresh(this.engineRoster());
    this.started = true;
  }

  stop(): void {
    if (!this.started) return;
    this.commitmentBridge.stop();
    this.helpfulness.stop();
    this.started = false;
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

  // ── Reconciliation (cross-system invariants) ─────────────────────

  reconcile(): ReconcileReport {
    const checkedAt = this.now();
    const violations: InvariantViolation[] = [];

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
    };
  }
}
