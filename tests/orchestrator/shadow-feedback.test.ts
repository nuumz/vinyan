import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createBus, type VinyanBus } from '../../src/core/bus.ts';
import { SHADOW_SCHEMA_SQL } from '../../src/db/shadow-schema.ts';
import { ShadowStore } from '../../src/db/shadow-store.ts';
import { TRACE_SCHEMA_SQL } from '../../src/db/trace-schema.ts';
import { TraceStore } from '../../src/db/trace-store.ts';
import { ShadowRunner } from '../../src/orchestrator/shadow-runner.ts';
import type { ExecutionTrace, ShadowValidationResult } from '../../src/orchestrator/types.ts';

let db: Database;
let shadowStore: ShadowStore;
let traceStore: TraceStore;
let bus: VinyanBus;
let tempDir: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SHADOW_SCHEMA_SQL);
  db.exec(TRACE_SCHEMA_SQL);
  shadowStore = new ShadowStore(db);
  traceStore = new TraceStore(db);
  bus = createBus();
  tempDir = mkdtempSync(join(tmpdir(), 'vinyan-shadow-fb-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeTrace(taskId: string): ExecutionTrace {
  return {
    id: `trace-${taskId}`,
    taskId,
    timestamp: Date.now(),
    routingLevel: 2,
    approach: 'test-approach',
    oracleVerdicts: { type: true },
    modelUsed: 'mock',
    tokensConsumed: 100,
    durationMs: 500,
    outcome: 'success',
    affectedFiles: ['a.ts'],
  };
}

describe('Shadow Feedback Loop (H3)', () => {
  test('processNext returns result after enqueue', async () => {
    const runner = new ShadowRunner({
      shadowStore,
      workspace: tempDir,
      testCommand: 'echo ok',
      timeoutMs: 5000,
    });

    runner.enqueue('task-1', [{ file: 'a.ts', content: 'a' }]);
    const result = await runner.processNext();

    expect(result).not.toBeNull();
    expect(result!.taskId).toBe('task-1');
    expect(result!.testsPassed).toBe(true);
  });

  test('shadow:complete event emitted via bus on success', async () => {
    const runner = new ShadowRunner({
      shadowStore,
      workspace: tempDir,
      testCommand: 'echo ok',
      timeoutMs: 5000,
    });

    let emitted: any = null;
    bus.on('shadow:complete', (payload) => {
      emitted = payload;
    });

    const job = runner.enqueue('task-1', [{ file: 'a.ts', content: 'a' }]);

    // Simulate what core-loop does: fire-and-forget processNext
    const result = await runner.processNext();
    if (result) {
      bus.emit('shadow:complete', { job, result });
    }

    expect(emitted).not.toBeNull();
    expect(emitted.result.taskId).toBe('task-1');
    expect(emitted.result.testsPassed).toBe(true);
  });

  test('shadow:failed event emitted on error', () => {
    let emitted: any = null;
    bus.on('shadow:failed', (payload) => {
      emitted = payload;
    });

    const job = {
      id: 's-fail',
      taskId: 'task-fail',
      status: 'pending' as const,
      enqueuedAt: Date.now(),
      retryCount: 0,
      maxRetries: 0,
    };

    bus.emit('shadow:failed', { job, error: 'test error' });

    expect(emitted).not.toBeNull();
    expect(emitted.error).toBe('test error');
  });

  test('updateShadowValidation updates trace in store', () => {
    // Insert a trace first
    traceStore.insert(makeTrace('task-1'));

    const mockResult: ShadowValidationResult = {
      taskId: 'task-1',
      testsPassed: true,
      durationMs: 1234,
      timestamp: Date.now(),
    };

    traceStore.updateShadowValidation('task-1', mockResult);

    // Query and verify
    const traces = traceStore.findRecent(1);
    expect(traces).toHaveLength(1);
    expect(traces[0]!.shadowValidation).toBeDefined();
    expect(traces[0]!.shadowValidation!.testsPassed).toBe(true);
    expect(traces[0]!.validationDepth).toBe('structural_and_tests');
  });

  test('bus listener wires shadow:complete to trace store update', () => {
    // Insert trace
    traceStore.insert(makeTrace('task-2'));

    // Wire listener like factory does
    bus.on('shadow:complete', ({ result }) => {
      traceStore.updateShadowValidation(result.taskId, result);
    });

    // Emit shadow:complete
    const mockResult: ShadowValidationResult = {
      taskId: 'task-2',
      testsPassed: false,
      durationMs: 999,
      timestamp: Date.now(),
    };
    bus.emit('shadow:complete', {
      job: {
        id: 's-1',
        taskId: 'task-2',
        status: 'done' as const,
        enqueuedAt: Date.now(),
        retryCount: 0,
        maxRetries: 1,
      },
      result: mockResult,
    });

    // Verify trace was updated
    const traces = traceStore.findRecent(1);
    expect(traces[0]!.shadowValidation!.testsPassed).toBe(false);
  });
});
