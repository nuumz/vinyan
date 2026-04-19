/**
 * CommitmentBridge — wires the CommitmentLedger to the bus.
 *
 * Two subscriptions:
 *   1. `market:auction_completed` → open a commitment for the winner.
 *   2. `trace:record`            → resolve the commitment based on outcome.
 *
 * The bridge is intentionally thin so the ledger has zero coupling to bus
 * event shapes. Lifecycle is `start()` / `stop()` — callers own it.
 *
 * Callers must supply a `taskResolver` that maps taskId → (goal, targetFiles,
 * deadlineAt). In production this is the task store; in tests it is a stub.
 */

import type { VinyanBus } from '../../core/bus.ts';
import type { CommitmentLedger } from './commitment-ledger.ts';

export interface TaskFacts {
  readonly goal: string;
  readonly targetFiles?: readonly string[];
  readonly deadlineAt: number;
}

export interface CommitmentBridgeConfig {
  readonly ledger: CommitmentLedger;
  readonly bus: VinyanBus;
  /** Resolve facts needed to open a commitment given a taskId. */
  readonly taskResolver: (taskId: string) => TaskFacts | null;
  /**
   * Optional evidence summarizer from the trace. Default: JSON stringify of
   * oracleVerdicts (or `failureReason` when outcome != success).
   */
  readonly summarizeEvidence?: (trace: import('../types.ts').ExecutionTrace) => string;
}

export class CommitmentBridge {
  private readonly ledger: CommitmentLedger;
  private readonly bus: VinyanBus;
  private readonly resolveTask: (taskId: string) => TaskFacts | null;
  private readonly summarize: (t: import('../types.ts').ExecutionTrace) => string;
  private unsubAuction: (() => void) | null = null;
  private unsubTrace: (() => void) | null = null;

  constructor(config: CommitmentBridgeConfig) {
    this.ledger = config.ledger;
    this.bus = config.bus;
    this.resolveTask = config.taskResolver;
    this.summarize = config.summarizeEvidence ?? defaultEvidence;
  }

  start(): void {
    if (this.unsubAuction || this.unsubTrace) return; // already running

    this.unsubAuction = this.bus.on('market:auction_completed', (payload) => {
      // Keyed by the REAL taskId (auctionId has format "auc-<taskId>-<ts>"
      // and is NOT interchangeable). The bridge uses payload.taskId so the
      // commitment it opens can be resolved by the `trace:record` handler,
      // which sees trace.taskId (never auctionId).
      const taskId = payload.taskId;
      const facts = this.resolveTask(taskId);
      if (!facts) return;
      // Idempotency: a single task may trigger multiple auctions (escalation,
      // retry). Opening a second commitment for the same taskId would make
      // both resolve on the first trace:record, double-crediting the winner.
      if (this.ledger.openByTask(taskId).length > 0) return;
      try {
        this.ledger.open({
          engineId: payload.winnerId,
          taskId,
          goal: facts.goal,
          targetFiles: facts.targetFiles ?? [],
          deadlineAt: facts.deadlineAt,
        });
      } catch (err) {
        console.warn('[vinyan] commitment-bridge: open failed:', (err as Error).message);
      }
    });

    this.unsubTrace = this.bus.on('trace:record', ({ trace }) => {
      const open = this.ledger.openByTask(trace.taskId);
      if (open.length === 0) return;

      const kind =
        trace.outcome === 'success'
          ? 'delivered'
          : trace.outcome === 'escalated'
            ? 'transferred'
            : 'failed';
      this.ledger.resolveForTask(trace.taskId, kind, this.summarize(trace));
    });
  }

  stop(): void {
    this.unsubAuction?.();
    this.unsubTrace?.();
    this.unsubAuction = null;
    this.unsubTrace = null;
  }
}

function defaultEvidence(trace: import('../types.ts').ExecutionTrace): string {
  if (trace.outcome === 'success') {
    return JSON.stringify({ verdicts: trace.oracleVerdicts });
  }
  return trace.failureReason ?? `outcome=${trace.outcome}`;
}
