/**
 * WriteQueue — Generic write-behind queue for µs hot-path persistence.
 *
 * Enqueue returns synchronously (µs), background timer flushes batches
 * to the provided callback on a configurable interval.
 *
 * Axiom: A3 (Deterministic Governance) — decision path stays µs; persistence is async.
 * Axiom: A4 (Content-Addressed Truth) — facts reach durable storage via flush.
 *
 * Crash safety: SQLite WAL provides recovery. Lost writes between flushes
 * are re-derivable from the next task execution.
 */

export interface WriteQueueConfig {
  /** Flush interval in milliseconds (default: 100ms) */
  flushIntervalMs?: number;
  /** Max items per batch (default: 50) */
  maxBatchSize?: number;
}

export class WriteQueue<T> {
  private queue: T[] = [];
  private readonly onFlush: (batch: readonly T[]) => void | Promise<void>;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(onFlush: (batch: readonly T[]) => void | Promise<void>, config?: WriteQueueConfig) {
    this.onFlush = onFlush;
    this.flushIntervalMs = config?.flushIntervalMs ?? 100;
    this.maxBatchSize = config?.maxBatchSize ?? 50;
  }

  /** Enqueue an item — synchronous, µs cost. */
  enqueue(item: T): void {
    this.queue.push(item);

    // Auto-flush if batch is full
    if (this.queue.length >= this.maxBatchSize) {
      void this.flushOnce();
    }
  }

  /** Number of items pending in queue. */
  get pending(): number {
    return this.queue.length;
  }

  /** Start the periodic flush timer. Idempotent. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.flushOnce(), this.flushIntervalMs);
  }

  /** Stop the periodic flush timer. Does NOT flush remaining items — call flush() first. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Flush all pending items. Returns when complete. Safe for shutdown. */
  async flush(): Promise<void> {
    while (this.queue.length > 0) {
      await this.flushOnce();
    }
  }

  /** Flush one batch (up to maxBatchSize). */
  private async flushOnce(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;

    this.flushing = true;
    try {
      const batch = this.queue.splice(0, this.maxBatchSize);
      await this.onFlush(batch);
    } finally {
      this.flushing = false;
    }
  }
}
