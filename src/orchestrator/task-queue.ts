/**
 * Task Queue — K2 bounded-concurrency task dispatcher.
 *
 * Provides a simple semaphore-based queue that limits concurrent task execution.
 * This prevents resource exhaustion when multiple tasks arrive simultaneously
 * and ensures predictable throughput.
 *
 * Reuses the Semaphore pattern from worker-pool.ts but at the task level.
 */

export interface TaskQueueConfig {
  /** Maximum concurrent tasks (default: 5). */
  maxConcurrent?: number;
}

export interface TaskQueue {
  /** Enqueue a task function. Resolves when the task completes. */
  enqueue<T>(fn: () => Promise<T>): Promise<T>;
  /** Number of tasks currently executing. */
  readonly activeCount: number;
  /** Number of tasks waiting in the queue. */
  readonly pendingCount: number;
  /** Drain: wait for all in-flight tasks to complete. */
  drain(): Promise<void>;
}

/**
 * Create a bounded-concurrency task queue.
 */
export function createTaskQueue(config: TaskQueueConfig = {}): TaskQueue {
  const maxConcurrent = config.maxConcurrent ?? 5;
  let active = 0;
  const waiting: Array<() => void> = [];
  const inFlight = new Set<Promise<unknown>>();

  async function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    // Wait for a slot
    if (active >= maxConcurrent) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active++;

    const promise = fn().finally(() => {
      active--;
      inFlight.delete(promise);
      const next = waiting.shift();
      if (next) next();
    });
    inFlight.add(promise);

    return promise;
  }

  async function drain(): Promise<void> {
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }
  }

  return {
    enqueue,
    get activeCount() { return active; },
    get pendingCount() { return waiting.length; },
    drain,
  };
}
