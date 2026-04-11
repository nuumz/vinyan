/**
 * Concurrent Dispatcher — K2.3 parallel multi-task dispatch.
 *
 * Dispatches multiple tasks concurrently through the core loop,
 * using file locks to prevent write conflicts and TaskQueue for
 * bounded concurrency.
 *
 * A3 compliant: all scheduling decisions are deterministic/rule-based.
 * A6 compliant: each task gets its own AgentContract.
 */
import type { TaskQueue } from './task-queue.ts';
import { AdvisoryFileLock } from './worker/file-lock.ts';
import type { TaskInput, TaskResult } from './types.ts';
import type { VinyanBus } from '../core/bus.ts';

export interface ConcurrentDispatcherConfig {
  taskQueue: TaskQueue;
  executeTask: (input: TaskInput) => Promise<TaskResult>;
  bus?: VinyanBus;
}

export interface ConcurrentDispatcher {
  dispatch(tasks: TaskInput[]): Promise<TaskResult[]>;
  getActiveCount(): number;
}

export class DefaultConcurrentDispatcher implements ConcurrentDispatcher {
  private taskQueue: TaskQueue;
  private executeTask: (input: TaskInput) => Promise<TaskResult>;
  private fileLock = new AdvisoryFileLock();
  private bus?: VinyanBus;

  constructor(config: ConcurrentDispatcherConfig) {
    this.taskQueue = config.taskQueue;
    this.executeTask = config.executeTask;
    this.bus = config.bus;
  }

  /**
   * Dispatch tasks concurrently. Non-conflicting tasks run in parallel;
   * tasks with file conflicts wait and run in subsequent rounds.
   */
  async dispatch(tasks: TaskInput[]): Promise<TaskResult[]> {
    if (tasks.length === 0) return [];
    if (tasks.length === 1) return [await this.executeSingle(tasks[0]!)];

    const results = new Map<string, TaskResult>();
    const remaining = [...tasks];

    // Iterative rounds: each round dispatches non-conflicting tasks in parallel
    while (remaining.length > 0) {
      const batch: TaskInput[] = [];
      const deferred: TaskInput[] = [];

      for (const task of remaining) {
        if (results.has(task.id)) continue;
        const files = task.targetFiles ?? [];
        const lockResult = this.fileLock.tryAcquire(task.id, files);
        if (lockResult.acquired) {
          batch.push(task);
        } else {
          deferred.push(task);
        }
      }

      // Safety: if no tasks could acquire locks (circular dep), force first one
      if (batch.length === 0 && deferred.length > 0) {
        batch.push(deferred.shift()!);
        const forced = batch[0]!;
        this.fileLock.tryAcquire(forced.id, forced.targetFiles ?? []);
      }

      // Execute batch in parallel via TaskQueue
      const promises = batch.map((task) =>
        this.taskQueue.enqueue(async () => {
          try {
            const result = await this.executeTask(task);
            results.set(task.id, result);
          } finally {
            this.fileLock.release(task.id);
          }
        }),
      );
      await Promise.allSettled(promises);

      // Next round: only tasks not yet completed
      remaining.length = 0;
      for (const task of deferred) {
        if (!results.has(task.id)) {
          remaining.push(task);
        }
      }
    }

    // Return results in original task order
    return tasks.map((t) => results.get(t.id)!);
  }

  getActiveCount(): number {
    return this.taskQueue.activeCount;
  }

  private async executeSingle(task: TaskInput): Promise<TaskResult> {
    const files = task.targetFiles ?? [];
    this.fileLock.tryAcquire(task.id, files);
    try {
      return await this.executeTask(task);
    } finally {
      this.fileLock.release(task.id);
    }
  }
}
