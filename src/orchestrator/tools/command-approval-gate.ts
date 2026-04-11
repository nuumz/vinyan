/**
 * Command Approval Gate — interactive approval for shell commands not in allowlist.
 *
 * When a shell command is blocked because it's not in the allowlist (but is
 * otherwise safe — no metacharacters, no bypass patterns), this gate asks
 * the user to approve it before execution.
 *
 * A3 compliant: deterministic — same approval decision → same outcome.
 * A6 compliant: zero-trust — user is the final authority for unknown commands.
 */

import type { VinyanBus } from '../../core/bus.ts';

export type CommandDecision = 'approved' | 'rejected';

interface PendingCommand {
  requestId: string;
  command: string;
  resolve: (decision: CommandDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CommandApprovalGate {
  private pending = new Map<string, PendingCommand>();
  private bus: VinyanBus;
  private timeoutMs: number;

  constructor(bus: VinyanBus, timeoutMs = 30_000) {
    this.bus = bus;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Request user approval for a shell command not in the allowlist.
   * Emits `tool:approval_required` on the bus and waits for resolution.
   * Auto-rejects after timeoutMs (default: 30s).
   */
  requestApproval(command: string, reason: string): Promise<CommandDecision> {
    const requestId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    return new Promise<CommandDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve('rejected');
      }, this.timeoutMs);

      this.pending.set(requestId, { requestId, command, resolve, timer });
      this.bus.emit('tool:approval_required', { requestId, command, reason });
    });
  }

  /** Resolve a pending command approval (called by CLI or TUI handler). */
  resolve(requestId: string, decision: CommandDecision): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;

    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve(decision);
    return true;
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
