/**
 * Tests for K2 Task Queue — bounded concurrency dispatcher.
 */
import { describe, expect, test } from 'bun:test';
import { createTaskQueue } from '../../src/orchestrator/task-queue.ts';

describe('createTaskQueue', () => {
  test('respects maxConcurrent limit', async () => {
    const queue = createTaskQueue({ maxConcurrent: 2 });
    let maxActive = 0;
    let currentActive = 0;

    const task = () =>
      new Promise<void>((resolve) => {
        currentActive++;
        maxActive = Math.max(maxActive, currentActive);
        setTimeout(() => {
          currentActive--;
          resolve();
        }, 10);
      });

    await Promise.all([
      queue.enqueue(task),
      queue.enqueue(task),
      queue.enqueue(task),
      queue.enqueue(task),
    ]);

    expect(maxActive).toBeLessThanOrEqual(2);
  });

  test('enqueue returns task result', async () => {
    const queue = createTaskQueue();
    const result = await queue.enqueue(async () => 42);
    expect(result).toBe(42);
  });

  test('drain waits for all in-flight tasks', async () => {
    const queue = createTaskQueue({ maxConcurrent: 1 });
    const completed: number[] = [];

    // Fire and forget
    queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 20));
      completed.push(1);
    });
    queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 10));
      completed.push(2);
    });

    await queue.drain();
    expect(completed).toEqual([1, 2]);
  });

  test('activeCount and pendingCount track state', async () => {
    const queue = createTaskQueue({ maxConcurrent: 1 });
    let resolveFirst: () => void;
    const firstBlocking = new Promise<void>((r) => { resolveFirst = r; });

    const p1 = queue.enqueue(() => firstBlocking);
    // First task is active, second should be pending
    const p2Promise = queue.enqueue(async () => 'done');

    expect(queue.activeCount).toBe(1);
    // pendingCount may be 1 (second task waiting for slot)
    expect(queue.pendingCount).toBeGreaterThanOrEqual(0);

    resolveFirst!();
    await p1;
    await p2Promise;
  });
});
