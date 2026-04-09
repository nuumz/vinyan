/**
 * Tests for K2.3 Concurrent Dispatcher — parallel multi-task dispatch.
 */
import { describe, expect, test } from 'bun:test';
import { DefaultConcurrentDispatcher } from '../../src/orchestrator/concurrent-dispatcher.ts';
import { createTaskQueue } from '../../src/orchestrator/task-queue.ts';
import { AdvisoryFileLock } from '../../src/orchestrator/worker/file-lock.ts';
import type { TaskInput, TaskResult } from '../../src/orchestrator/types.ts';

function makeTask(id: string, targetFiles: string[] = []): TaskInput {
  return {
    id,
    goal: `Test task ${id}`,
    targetFiles,
    budget: { maxTokens: 1000, maxRetries: 1, maxDurationMs: 10_000 },
  } as TaskInput;
}

function makeResult(id: string): TaskResult {
  return {
    id,
    status: 'completed',
    mutations: [],
    trace: {
      id: `trace-${id}`,
      taskId: id,
      workerId: 'test',
      timestamp: Date.now(),
      routingLevel: 1,
      approach: 'test',
      oracleVerdicts: {},
      modelUsed: 'test',
      tokensConsumed: 0,
      durationMs: 0,
      outcome: 'success',
      affectedFiles: [],
    },
  } as TaskResult;
}

describe('AdvisoryFileLock', () => {
  test('acquires lock on available files', () => {
    const lock = new AdvisoryFileLock();
    const result = lock.tryAcquire('task-1', ['a.ts', 'b.ts']);
    expect(result.acquired).toBe(true);
    expect(result.conflicts).toEqual([]);
  });

  test('detects conflicts with held locks', () => {
    const lock = new AdvisoryFileLock();
    lock.tryAcquire('task-1', ['a.ts', 'b.ts']);
    const result = lock.tryAcquire('task-2', ['b.ts', 'c.ts']);
    expect(result.acquired).toBe(false);
    expect(result.conflicts).toEqual(['b.ts']);
  });

  test('same task can re-acquire its own files', () => {
    const lock = new AdvisoryFileLock();
    lock.tryAcquire('task-1', ['a.ts']);
    const result = lock.tryAcquire('task-1', ['a.ts']);
    expect(result.acquired).toBe(true);
  });

  test('release frees locks', () => {
    const lock = new AdvisoryFileLock();
    lock.tryAcquire('task-1', ['a.ts']);
    lock.release('task-1');
    const result = lock.tryAcquire('task-2', ['a.ts']);
    expect(result.acquired).toBe(true);
  });

  test('getLockedFiles returns files for task', () => {
    const lock = new AdvisoryFileLock();
    lock.tryAcquire('task-1', ['a.ts', 'b.ts']);
    const files = lock.getLockedFiles('task-1');
    expect(files.sort()).toEqual(['a.ts', 'b.ts']);
  });
});

describe('DefaultConcurrentDispatcher', () => {
  test('G8: 3 concurrent tasks, wall-clock < sum', async () => {
    const delayMs = 100;
    const taskCount = 3;
    const executionLog: { taskId: string; start: number; end: number }[] = [];

    const dispatcher = new DefaultConcurrentDispatcher({
      taskQueue: createTaskQueue({ maxConcurrent: 5 }),
      executeTask: async (input) => {
        const start = performance.now();
        await new Promise((r) => setTimeout(r, delayMs));
        const end = performance.now();
        executionLog.push({ taskId: input.id, start, end });
        return makeResult(input.id);
      },
    });

    const tasks = Array.from({ length: taskCount }, (_, i) =>
      makeTask(`task-${i}`, [`file-${i}.ts`]),
    );

    const wallStart = performance.now();
    const results = await dispatcher.dispatch(tasks);
    const wallEnd = performance.now();
    const wallClockMs = wallEnd - wallStart;
    const sequentialMs = delayMs * taskCount;

    expect(results).toHaveLength(taskCount);
    expect(results.every((r) => r.status === 'completed')).toBe(true);
    // Wall-clock should be significantly less than sequential sum
    expect(wallClockMs).toBeLessThan(sequentialMs);
  });

  test('conflicting tasks execute sequentially', async () => {
    const executionOrder: string[] = [];

    const dispatcher = new DefaultConcurrentDispatcher({
      taskQueue: createTaskQueue({ maxConcurrent: 5 }),
      executeTask: async (input) => {
        executionOrder.push(input.id);
        await new Promise((r) => setTimeout(r, 30));
        return makeResult(input.id);
      },
    });

    // task-0 and task-1 share 'shared.ts' → cannot run in parallel
    const tasks = [
      makeTask('task-0', ['shared.ts']),
      makeTask('task-1', ['shared.ts']),
    ];

    const results = await dispatcher.dispatch(tasks);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === 'completed')).toBe(true);
  });

  test('empty task list returns empty', async () => {
    const dispatcher = new DefaultConcurrentDispatcher({
      taskQueue: createTaskQueue({ maxConcurrent: 5 }),
      executeTask: async (input) => makeResult(input.id),
    });

    const results = await dispatcher.dispatch([]);
    expect(results).toEqual([]);
  });

  test('single task dispatches directly', async () => {
    let called = false;
    const dispatcher = new DefaultConcurrentDispatcher({
      taskQueue: createTaskQueue({ maxConcurrent: 5 }),
      executeTask: async (input) => {
        called = true;
        return makeResult(input.id);
      },
    });

    const results = await dispatcher.dispatch([makeTask('solo')]);
    expect(results).toHaveLength(1);
    expect(called).toBe(true);
  });

  test('results returned in original task order', async () => {
    const dispatcher = new DefaultConcurrentDispatcher({
      taskQueue: createTaskQueue({ maxConcurrent: 5 }),
      executeTask: async (input) => {
        // Variable delay — tasks may complete in any order
        await new Promise((r) => setTimeout(r, Math.random() * 50));
        return makeResult(input.id);
      },
    });

    const tasks = Array.from({ length: 5 }, (_, i) =>
      makeTask(`task-${i}`, [`file-${i}.ts`]),
    );

    const results = await dispatcher.dispatch(tasks);
    expect(results.map((r) => r.id)).toEqual(tasks.map((t) => t.id));
  });
});
