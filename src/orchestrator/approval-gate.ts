/**
 * Approval Gate — Promise-based human-in-the-loop approval for high-risk tasks.
 *
 * A6: Zero-trust execution — the orchestrator requests human approval before
 * dispatching high-risk operations. The TUI (or API) resolves the promise.
 *
 * Integrates with:
 * - TUI: EmbeddedDataSource resolves approval via keyboard
 * - API: POST /api/v1/tasks/:id/approval (future remote mode)
 *
 * R5 (2026-05-01): optional `ApprovalLedgerStore` makes pending /
 * resolved / timed-out / shutdown-rejected approvals durable across
 * process restart. Strengthens A8 (traceability) without changing the
 * promise-based contract — when no store is wired, behavior is
 * byte-identical to the legacy in-memory gate.
 */

import type { VinyanBus } from '../core/bus.ts';
import type { ApprovalLedgerStore } from '../db/approval-ledger-store.ts';

export type ApprovalDecision = 'approved' | 'rejected';

export interface PendingApprovalInfo {
  taskId: string;
  riskScore: number;
  reason: string;
  requestedAt: number;
  /** Ledger-backed extras when an `ApprovalLedgerStore` is wired. */
  approvalKey?: string;
  approvalId?: string;
  profile?: string;
  sessionId?: string;
}

interface PendingApproval extends PendingApprovalInfo {
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ApprovalGateOptions {
  /** Override the default 5-minute timeout. */
  readonly timeoutMs?: number;
  /**
   * Optional durable ledger. When wired, every approval lifecycle event
   * (pending → resolved | timed_out | shutdown_rejected) is persisted
   * before the awaiting promise settles. Replay/restart can read prior
   * pending rows from disk.
   */
  readonly ledger?: ApprovalLedgerStore;
}

export interface RequestApprovalOptions {
  /** Distinct approval slot under the same taskId — default `'default'`. */
  readonly approvalKey?: string;
  /** Profile attribution recorded in the ledger. */
  readonly profile?: string;
  /** Session attribution recorded in the ledger. */
  readonly sessionId?: string;
  /** Optional structured provenance (governance decisionId, evidence). */
  readonly provenance?: Readonly<Record<string, unknown>>;
}

export class ApprovalGate {
  private pending = new Map<string, PendingApproval>();
  private bus: VinyanBus;
  private timeoutMs: number;
  private ledger: ApprovalLedgerStore | undefined;

  /**
   * Backwards-compatible constructor signatures:
   *   - `new ApprovalGate(bus)`                                     (legacy)
   *   - `new ApprovalGate(bus, timeoutMs)`                          (legacy)
   *   - `new ApprovalGate(bus, { timeoutMs?, ledger? })`            (new)
   */
  constructor(bus: VinyanBus, opts?: number | ApprovalGateOptions) {
    this.bus = bus;
    if (typeof opts === 'number') {
      this.timeoutMs = opts;
    } else {
      this.timeoutMs = opts?.timeoutMs ?? 300_000;
      this.ledger = opts?.ledger;
    }
  }

  /**
   * Request human approval for a task.
   * Emits `task:approval_required` on the bus and waits for a resolution.
   * Auto-rejects after timeoutMs (default: 5 minutes).
   *
   * When a ledger is wired, a `pending` row lands BEFORE the bus emit
   * so consumers reading the ledger never observe a pre-pending state.
   * On timeout, the row is updated BEFORE the resolved event fires.
   */
  requestApproval(
    taskId: string,
    riskScore: number,
    reason: string,
    opts: RequestApprovalOptions = {},
  ): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      const approvalKey = opts.approvalKey ?? 'default';
      const requestedAt = Date.now();
      let approvalId: string | undefined;

      // R5: ledger-first. The pending row exists on disk before the bus
      // event, so a UI subscribing only to the ledger never misses an
      // approval. A duplicate-pending response is treated as a soft
      // success (the pre-existing row already represents the intent).
      if (this.ledger) {
        const result = this.ledger.createPending({
          taskId,
          approvalKey,
          riskScore,
          reason,
          ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
          ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
          ...(opts.provenance !== undefined ? { provenance: opts.provenance } : {}),
          now: requestedAt,
        });
        if (result.ok) {
          approvalId = result.record.id;
          this.bus.emit('approval:ledger_pending', {
            approvalId: result.record.id,
            taskId,
            approvalKey,
            riskScore,
            reason,
            requestedAt,
            ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
            ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
          });
        }
        // duplicate_pending: another pending row already exists. We do
        // NOT throw — the caller's intent is "I want approval for this",
        // and the ledger already represents that. Continue with the
        // existing promise-based gate so the caller still awaits.
      }

      const timer = setTimeout(() => {
        // Auto-reject path: drop the entry first so a racing /approval POST
        // sees a 404 instead of double-resolving, then notify listeners
        // (chat clients drop their cached approval card) and finally
        // settle the awaiting promise.
        this.pending.delete(taskId);
        if (this.ledger) {
          const r = this.ledger.timeout(taskId, approvalKey);
          if (r.ok) {
            this.bus.emit('approval:ledger_resolved', {
              approvalId: r.record.id,
              taskId,
              approvalKey,
              status: 'timed_out',
              source: r.record.source,
              decision: 'rejected',
              resolvedAt: r.record.resolvedAt ?? Date.now(),
            });
          }
        }
        this.bus.emit('task:approval_resolved', { taskId, decision: 'rejected', source: 'timeout' });
        resolve('rejected');
      }, this.timeoutMs);

      this.pending.set(taskId, {
        taskId,
        riskScore,
        reason,
        requestedAt,
        approvalKey,
        ...(approvalId ? { approvalId } : {}),
        ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
        ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
        resolve,
        timer,
      });

      // Emit event for TUI/listeners to pick up (legacy compatibility — every
      // existing consumer subscribes to this name).
      this.bus.emit('task:approval_required', { taskId, riskScore, reason });
    });
  }

  /** Resolve a pending approval (called by TUI or API handler). */
  resolve(taskId: string, decision: ApprovalDecision, resolvedBy?: string): boolean {
    const entry = this.pending.get(taskId);
    if (!entry) return false;

    clearTimeout(entry.timer);
    this.pending.delete(taskId);

    // R5: ledger-first. Update the durable row before settling the
    // promise so any reader (including subscribers to ledger_resolved)
    // sees the new status before the dependent task transitions.
    if (this.ledger) {
      const r = this.ledger.resolve({
        taskId,
        ...(entry.approvalKey ? { approvalKey: entry.approvalKey } : {}),
        status: decision === 'approved' ? 'approved' : 'rejected',
        source: 'human',
        decision,
        ...(resolvedBy !== undefined ? { resolvedBy } : {}),
      });
      if (r.ok) {
        this.bus.emit('approval:ledger_resolved', {
          approvalId: r.record.id,
          taskId,
          approvalKey: r.record.approvalKey,
          status: decision === 'approved' ? 'approved' : 'rejected',
          source: r.record.source,
          decision,
          resolvedAt: r.record.resolvedAt ?? Date.now(),
          ...(resolvedBy !== undefined ? { resolvedBy } : {}),
        });
      }
    }

    // Notify cross-tab UIs BEFORE resolving the awaiting promise so the
    // approval card disappears the moment the gate clears, not after the
    // dependent task transitions further. Source = 'human' covers both
    // explicit API calls and TUI keybinds — anything that is not the
    // auto-timeout path.
    this.bus.emit('task:approval_resolved', { taskId, decision, source: 'human' });
    entry.resolve(decision);
    return true;
  }

  /** Check if a task has a pending approval. */
  hasPending(taskId: string): boolean {
    return this.pending.has(taskId);
  }

  /** Get all pending approval task IDs. */
  getPendingIds(): string[] {
    return [...this.pending.keys()];
  }

  /**
   * Get all pending approvals with full context (riskScore, reason,
   * requestedAt). When a ledger is wired, the in-memory pending list
   * is the ground truth for THIS process — restart-orphaned rows live
   * in the ledger and are surfaced separately via `getOrphanedPending`.
   */
  getPending(): PendingApprovalInfo[] {
    return [...this.pending.values()].map(({ taskId, riskScore, reason, requestedAt, approvalKey, approvalId, profile, sessionId }) => ({
      taskId,
      riskScore,
      reason,
      requestedAt,
      ...(approvalKey ? { approvalKey } : {}),
      ...(approvalId ? { approvalId } : {}),
      ...(profile ? { profile } : {}),
      ...(sessionId ? { sessionId } : {}),
    }));
  }

  /**
   * R5: pending approval rows from the ledger that are NOT tracked by
   * this process's in-memory map — i.e., orphans from a prior crashed
   * process. Operators / doctor surface them so a human can decide
   * whether to retry or explicitly reject. The store is the source of
   * truth; this method is read-only.
   *
   * Returns `null` when no ledger is wired.
   */
  getOrphanedPending(): readonly { taskId: string; approvalId: string; approvalKey: string; riskScore: number; reason: string; requestedAt: number }[] | null {
    if (!this.ledger) return null;
    const all = this.ledger.listPending();
    const out: { taskId: string; approvalId: string; approvalKey: string; riskScore: number; reason: string; requestedAt: number }[] = [];
    for (const row of all) {
      if (this.pending.has(row.taskId)) continue;
      out.push({
        taskId: row.taskId,
        approvalId: row.id,
        approvalKey: row.approvalKey,
        riskScore: row.riskScore,
        reason: row.reason,
        requestedAt: row.requestedAt,
      });
    }
    return out;
  }

  /**
   * Mark prior parent-task pending approvals as `superseded` because a
   * retry / child task has taken over. Operators (or the orchestrator's
   * retry harness) call this after the new task is enqueued so the UI
   * does not keep showing a stale approval card.
   *
   * Returns the count of rows transitioned. No-op when no ledger.
   */
  supersedeForRetry(parentTaskId: string, childTaskId: string): number {
    if (!this.ledger) return 0;
    const count = this.ledger.markSupersededForRetry(parentTaskId, childTaskId);
    if (count > 0) {
      this.bus.emit('approval:ledger_superseded', {
        parentTaskId,
        childTaskId,
        count,
      });
    }
    return count;
  }

  /** Clear all pending approvals (auto-reject). Used during shutdown. */
  clear(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      this.bus.emit('task:approval_resolved', {
        taskId: entry.taskId,
        decision: 'rejected',
        source: 'shutdown',
      });
      entry.resolve('rejected');
    }
    this.pending.clear();
    // R5: also reject any ledger row that may have been orphaned during
    // shutdown. Synchronous — by design we never strand pending rows
    // across a clean shutdown.
    if (this.ledger) {
      const count = this.ledger.shutdownRejectOpen();
      if (count > 0) {
        this.bus.emit('approval:ledger_resolved', {
          approvalId: 'batch:shutdown',
          taskId: 'batch:shutdown',
          approvalKey: 'batch',
          status: 'shutdown_rejected',
          source: 'shutdown',
          decision: 'rejected',
          resolvedAt: Date.now(),
          batchCount: count,
        });
      }
    }
  }
}
