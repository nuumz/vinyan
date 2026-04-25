/**
 * TaskFactsRegistry — dispatch-scoped store for transient task facts.
 *
 * The CommitmentBridge needs `goal`, `targetFiles`, and `deadlineAt` the
 * moment a `market:auction_completed` event fires. Those facts only
 * exist in `TaskInput` and the runtime budget; they are not durable.
 *
 * This registry is registered at `executeTask()` entry and unregistered
 * in its finally block, keeping facts in memory exactly as long as the
 * task is in flight. No SQLite persistence — commitments themselves are
 * the durable record.
 *
 * A3-compliant: pure data store, no decisions.
 */

import type { TaskFacts } from './commitment-bridge.ts';

export class TaskFactsRegistry {
  private readonly facts = new Map<string, TaskFacts>();

  register(taskId: string, facts: TaskFacts): void {
    this.facts.set(taskId, facts);
  }

  resolve(taskId: string): TaskFacts | null {
    return this.facts.get(taskId) ?? null;
  }

  unregister(taskId: string): void {
    this.facts.delete(taskId);
  }

  /** Test/diagnostic helper. */
  size(): number {
    return this.facts.size;
  }
}
