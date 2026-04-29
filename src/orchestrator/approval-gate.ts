/**
 * Approval Gate — Promise-based human-in-the-loop approval for high-risk tasks.
 *
 * A6: Zero-trust execution — the orchestrator requests human approval before
 * dispatching high-risk operations. The TUI (or API) resolves the promise.
 *
 * Integrates with:
 * - TUI: EmbeddedDataSource resolves approval via keyboard
 * - API: POST /api/v1/tasks/:id/approval (future remote mode)
 */

import type { VinyanBus } from '../core/bus.ts';

export type ApprovalDecision = 'approved' | 'rejected';

export interface PendingApprovalInfo {
  taskId: string;
  riskScore: number;
  reason: string;
  requestedAt: number;
}

interface PendingApproval extends PendingApprovalInfo {
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ApprovalGate {
  private pending = new Map<string, PendingApproval>();
  private bus: VinyanBus;
  private timeoutMs: number;

  constructor(bus: VinyanBus, timeoutMs = 300_000) {
    this.bus = bus;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Request human approval for a task.
   * Emits `task:approval_required` on the bus and waits for a resolution.
   * Auto-rejects after timeoutMs (default: 5 minutes).
   */
  requestApproval(taskId: string, riskScore: number, reason: string): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(taskId);
        resolve('rejected');
      }, this.timeoutMs);

      this.pending.set(taskId, {
        taskId,
        riskScore,
        reason,
        requestedAt: Date.now(),
        resolve,
        timer,
      });

      // Emit event for TUI/listeners to pick up
      this.bus.emit('task:approval_required', { taskId, riskScore, reason });
    });
  }

  /** Resolve a pending approval (called by TUI or API handler). */
  resolve(taskId: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(taskId);
    if (!entry) return false;

    clearTimeout(entry.timer);
    this.pending.delete(taskId);
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

  /** Get all pending approvals with full context (riskScore, reason, requestedAt). */
  getPending(): PendingApprovalInfo[] {
    return [...this.pending.values()].map(({ taskId, riskScore, reason, requestedAt }) => ({
      taskId,
      riskScore,
      reason,
      requestedAt,
    }));
  }

  /** Clear all pending approvals (auto-reject). Used during shutdown. */
  clear(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve('rejected');
    }
    this.pending.clear();
  }
}
