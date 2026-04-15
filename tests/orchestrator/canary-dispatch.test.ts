/**
 * Book-integration Wave 4.1: canary-first batch dispatch tests.
 */
import { describe, expect, test } from 'bun:test';
import {
  CANARY_ABORTED_NOTE_PREFIX,
  DefaultConcurrentDispatcher,
} from '../../src/orchestrator/concurrent-dispatcher.ts';
import { createTaskQueue } from '../../src/orchestrator/task-queue.ts';
import type { TaskInput, TaskResult } from '../../src/orchestrator/types.ts';

function makeTask(id: string, targetFiles: string[] = []): TaskInput {
  return {
    id,
    source: 'cli',
    goal: `Test ${id}`,
    taskType: 'code',
    targetFiles,
    budget: { maxTokens: 1000, maxRetries: 1, maxDurationMs: 10_000 },
  } as TaskInput;
}

function makeCompletedResult(id: string): TaskResult {
  return {
    id,
    status: 'completed',
    mutations: [],
    trace: {
      id: `trace-${id}`,
      taskId: id,
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

function makeFailedResult(id: string): TaskResult {
  return {
    id,
    status: 'failed',
    mutations: [],
    trace: {
      id: `trace-${id}`,
      taskId: id,
      timestamp: Date.now(),
      routingLevel: 1,
      approach: 'test',
      oracleVerdicts: {},
      modelUsed: 'test',
      tokensConsumed: 0,
      durationMs: 0,
      outcome: 'failure',
      affectedFiles: [],
    },
  } as TaskResult;
}

describe('W4.1 canary-first batch dispatch', () => {
  test('canary passes → full batch runs normally', async () => {
    const executionOrder: string[] = [];
    const dispatcher = new DefaultConcurrentDispatcher({
      taskQueue: createTaskQueue({ maxConcurrent: 5 }),
      executeTask: async (input) => {
        executionOrder.push(input.id);
        return makeCompletedResult(input.id);
      },
    });

    const tasks = [makeTask('t1', ['a.ts']), makeTask('t2', ['b.ts']), makeTask('t3', ['c.ts'])];
    const results = await dispatcher.dispatch(tasks, { canaryFirst: true });

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === 'completed')).toBe(true);
    // Canary runs first
    expect(executionOrder[0]).toBe('t1');
    // All tasks executed
    expect(executionOrder.sort()).toEqual(['t1', 't2', 't3']);
  });

  test('canary fails → remaining tasks get synthetic canary-aborted results', async () => {
    const executed: string[] = [];
    const dispatcher = new DefaultConcurrentDispatcher({
      taskQueue: createTaskQueue({ maxConcurrent: 5 }),
      executeTask: async (input) => {
        executed.push(input.id);
        if (input.id === 't1') return makeFailedResult('t1');
        return makeCompletedResult(input.id);
      },
    });

    const tasks = [makeTask('t1', ['a.ts']), makeTask('t2', ['b.ts']), makeTask('t3', ['c.ts'])];
    const results = await dispatcher.dispatch(tasks, { canaryFirst: true });

    // Only the canary ran
    expect(executed).toEqual(['t1']);

    // Results returned in input order
    expect(results).toHaveLength(3);
    expect(results[0]!.id).toBe('t1');
    expect(results[0]!.status).toBe('failed');
    // t2 and t3 are synthetic aborts
    expect(results[1]!.status).toBe('failed');
    expect(results[1]!.notes?.[0]).toContain(CANARY_ABORTED_NOTE_PREFIX);
    expect(results[2]!.status).toBe('failed');
    expect(results[2]!.notes?.[0]).toContain(CANARY_ABORTED_NOTE_PREFIX);
  });

  test('canary uncertain → treated as failure, batch aborted', async () => {
    const dispatcher = new DefaultConcurrentDispatcher({
      taskQueue: createTaskQueue({ maxConcurrent: 5 }),
      executeTask: async (input) => {
        if (input.id === 't1') {
          const r = makeFailedResult('t1');
          (r as { status: TaskResult['status'] }).status = 'uncertain';
          return r;
        }
        return makeCompletedResult(input.id);
      },
    });

    const tasks = [makeTask('t1', ['a.ts']), makeTask('t2', ['b.ts'])];
    const results = await dispatcher.dispatch(tasks, { canaryFirst: true });
    expect(results[0]!.status).toBe('uncertain');
    expect(results[1]!.status).toBe('failed');
    expect(results[1]!.notes?.[0]).toContain('status=uncertain');
  });

  test('default dispatch (no options) is unchanged', async () => {
    const executed = new Set<string>();
    const dispatcher = new DefaultConcurrentDispatcher({
      taskQueue: createTaskQueue({ maxConcurrent: 5 }),
      executeTask: async (input) => {
        executed.add(input.id);
        return makeCompletedResult(input.id);
      },
    });

    const tasks = [makeTask('t1', ['a.ts']), makeTask('t2', ['b.ts']), makeTask('t3', ['c.ts'])];
    const results = await dispatcher.dispatch(tasks);
    expect(results).toHaveLength(3);
    expect(executed).toEqual(new Set(['t1', 't2', 't3']));
  });

  test('canary picker prefers file-free task over singleton group', async () => {
    const executionOrder: string[] = [];
    const dispatcher = new DefaultConcurrentDispatcher({
      taskQueue: createTaskQueue({ maxConcurrent: 5 }),
      executeTask: async (input) => {
        executionOrder.push(input.id);
        return makeCompletedResult(input.id);
      },
    });

    // t1 has files, t2 is file-free, t3 has files — t2 should be the canary
    // because the picker prefers file-free tasks.
    const tasks = [makeTask('t1', ['a.ts']), makeTask('t2', []), makeTask('t3', ['c.ts'])];
    await dispatcher.dispatch(tasks, { canaryFirst: true });
    expect(executionOrder[0]).toBe('t2');
  });

  test('canary picker falls back to singleton group when no file-free task', async () => {
    const executionOrder: string[] = [];
    const dispatcher = new DefaultConcurrentDispatcher({
      taskQueue: createTaskQueue({ maxConcurrent: 5 }),
      executeTask: async (input) => {
        executionOrder.push(input.id);
        return makeCompletedResult(input.id);
      },
    });

    // t1 and t2 share a file (multi-member group); t3 is a singleton.
    // Canary should be t3 because t1/t2 are in a multi-member group.
    const tasks = [makeTask('t1', ['shared.ts']), makeTask('t2', ['shared.ts']), makeTask('t3', ['alone.ts'])];
    await dispatcher.dispatch(tasks, { canaryFirst: true });
    expect(executionOrder[0]).toBe('t3');
  });

  // ── Deep-audit #3: synthetic aborted trace metadata ────────────
  test("Deep-audit #3: aborted result traces carry taskTypeSignature='canary-aborted'", async () => {
    const dispatcher = new DefaultConcurrentDispatcher({
      taskQueue: createTaskQueue({ maxConcurrent: 5 }),
      executeTask: async (input) => {
        if (input.id === 't1') return makeFailedResult('t1');
        return makeCompletedResult(input.id);
      },
    });

    const tasks = [makeTask('t1', ['a.ts']), makeTask('t2', ['b.ts']), makeTask('t3', ['c.ts'])];
    const results = await dispatcher.dispatch(tasks, { canaryFirst: true });

    // t2 and t3 are synthetic aborts
    expect(results[1]!.trace.taskTypeSignature).toBe('canary-aborted');
    expect(results[2]!.trace.taskTypeSignature).toBe('canary-aborted');
    expect(results[1]!.trace.approach).toBe('canary-aborted');
    expect(results[2]!.trace.approach).toBe('canary-aborted');
    // And the synthetic traces are distinguishable from real ones
    // via their unique id shape
    expect(results[1]!.trace.id).toMatch(/^canary-aborted-/);
    expect(results[2]!.trace.id).toMatch(/^canary-aborted-/);
  });
});
