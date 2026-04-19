/**
 * CommitmentLedger — accountability substrate for the ecosystem.
 *
 * A Commitment is the durable record of "engine X owes deliverable Y by
 * deadline Z". It is created the moment a bid is accepted (before the engine
 * starts work) and resolved the moment the oracle gate lands a verdict.
 *
 * A4 (Content-Addressed Truth): `deliverableHash` binds the commitment to a
 *   canonicalized (goal + targetFiles) tuple. Rewording the goal produces a
 *   new hash → it is a different commitment.
 *
 * A7 (Prediction Error as Learning): resolution outcome (delivered / failed /
 *   transferred) is emitted as `commitment:resolved` so the learning pipeline
 *   can attribute outcome deltas back to the engine.
 *
 * The ledger does NOT decide who bids, who wins, or how tasks are priced —
 * those are Market concerns. It only guarantees that every awarded task
 * leaves a trace of responsibility.
 *
 * Source of truth: docs/design/vinyan-os-ecosystem-plan.md §3.4
 */

import { randomUUID } from 'crypto';

import type { VinyanBus } from '../../core/bus.ts';
import { computeGoalHash } from '../../core/content-hash.ts';
import type {
  Commitment,
  CommitmentResolution,
  CommitmentStore,
} from '../../db/commitment-store.ts';

// ── Public API ───────────────────────────────────────────────────────

export interface OpenCommitmentParams {
  engineId: string;
  taskId: string;
  /** Natural-language goal. Hashed into `deliverableHash` (A4). */
  goal: string;
  /** Files the commitment is scoped to — contributes to the hash (A4). */
  targetFiles?: readonly string[];
  /** Wall-clock deadline for delivery. */
  deadlineAt: number;
}

export interface ResolveCommitmentParams {
  commitmentId: string;
  kind: CommitmentResolution;
  /** Human-readable explanation (oracle verdict summary, failure reason, etc.). */
  evidence: string;
}

export interface CommitmentLedgerConfig {
  readonly store: CommitmentStore;
  readonly bus?: VinyanBus;
  readonly now?: () => number;
  readonly idFactory?: () => string;
}

/**
 * Owner of the commitments table. All creation / resolution goes through
 * this class so bus events and persistence stay in lock-step.
 */
export class CommitmentLedger {
  private readonly store: CommitmentStore;
  private readonly bus?: VinyanBus;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(config: CommitmentLedgerConfig) {
    this.store = config.store;
    this.bus = config.bus;
    this.now = config.now ?? (() => Date.now());
    this.newId = config.idFactory ?? (() => randomUUID());
  }

  // ── Core operations ──────────────────────────────────────────────

  /**
   * Open a commitment the instant a bid is accepted. Idempotency is the
   * caller's job (a unique commitmentId per bid-accept is trivial if the
   * caller is the market-scheduler).
   */
  open(params: OpenCommitmentParams): Commitment {
    const commitmentId = this.newId();
    const acceptedAt = this.now();
    const deliverableHash = computeGoalHash(params.goal, params.targetFiles ?? []);

    this.store.create({
      commitmentId,
      engineId: params.engineId,
      taskId: params.taskId,
      deliverableHash,
      deadlineAt: params.deadlineAt,
      acceptedAt,
    });

    this.bus?.emit('commitment:created', {
      commitmentId,
      engineId: params.engineId,
      taskId: params.taskId,
      deliverableHash,
      deadlineAt: params.deadlineAt,
      acceptedAt,
    });

    return this.store.get(commitmentId)!;
  }

  /**
   * Close a commitment with a resolution kind + evidence. Returns false if
   * the commitment is already resolved or unknown — callers should treat
   * that as a bug (it means the ledger is out of sync with the caller).
   */
  resolve(params: ResolveCommitmentParams): boolean {
    const existing = this.store.get(params.commitmentId);
    if (!existing) return false;
    if (existing.resolvedAt !== null) return false;

    const resolvedAt = this.now();
    const ok = this.store.resolve({
      commitmentId: params.commitmentId,
      kind: params.kind,
      evidence: params.evidence,
      resolvedAt,
    });
    if (!ok) return false;

    this.bus?.emit('commitment:resolved', {
      commitmentId: params.commitmentId,
      engineId: existing.engineId,
      taskId: existing.taskId,
      kind: params.kind,
      evidence: params.evidence,
      resolvedAt,
      latencyMs: resolvedAt - existing.acceptedAt,
    });
    return true;
  }

  /**
   * Resolve every open commitment for a task. Called from the trace:record
   * subscriber — a trace covers one task outcome, so all commitments for
   * that task close together. Returns the list of commitments that were
   * actually resolved by this call.
   */
  resolveForTask(
    taskId: string,
    kind: CommitmentResolution,
    evidence: string,
  ): readonly Commitment[] {
    const open = this.store.findOpenByTask(taskId);
    const resolved: Commitment[] = [];
    for (const c of open) {
      if (this.resolve({ commitmentId: c.commitmentId, kind, evidence })) {
        const updated = this.store.get(c.commitmentId);
        if (updated) resolved.push(updated);
      }
    }
    return resolved;
  }

  // ── Query helpers ────────────────────────────────────────────────

  /** Open commitments for an engine — the "accountability backlog". */
  openByEngine(engineId: string): readonly Commitment[] {
    return this.store.findOpenByEngine(engineId);
  }

  /** Open commitments for a task (usually 0 or 1). */
  openByTask(taskId: string): readonly Commitment[] {
    return this.store.findOpenByTask(taskId);
  }

  /** Commitments past their deadline and still open — candidates for reaper. */
  expired(now: number = this.now()): readonly Commitment[] {
    return this.store.findExpired(now);
  }

  /**
   * Mark every expired commitment as `failed` with reason "deadline exceeded".
   * Returns the number of commitments closed.
   */
  reapExpired(now: number = this.now()): number {
    const expired = this.store.findExpired(now);
    let count = 0;
    for (const c of expired) {
      if (
        this.resolve({
          commitmentId: c.commitmentId,
          kind: 'failed',
          evidence: 'deadline exceeded',
        })
      ) {
        count += 1;
      }
    }
    return count;
  }
}
