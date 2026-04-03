import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'path';
import { LineReader, WarmWorkerPool } from '../../../src/orchestrator/worker/worker-pool.ts';

// ── LineReader ────────────────────────────────────────────────────────

describe('LineReader', () => {
  test('reads lines from a stream', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('line1\nline2\n'));
        controller.close();
      },
    });

    const reader = new LineReader(stream);
    expect(await reader.readLine()).toBe('line1');
    expect(await reader.readLine()).toBe('line2');
    expect(await reader.readLine()).toBe(null);
  });

  test('handles partial chunks across reads', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('hel'));
        controller.enqueue(encoder.encode('lo\nworld\n'));
        controller.close();
      },
    });

    const reader = new LineReader(stream);
    expect(await reader.readLine()).toBe('hello');
    expect(await reader.readLine()).toBe('world');
    expect(await reader.readLine()).toBe(null);
  });

  test('handles trailing content without newline', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('first\nsecond'));
        controller.close();
      },
    });

    const reader = new LineReader(stream);
    expect(await reader.readLine()).toBe('first');
    expect(await reader.readLine()).toBe('second');
    expect(await reader.readLine()).toBe(null);
  });

  test('skips empty lines', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('a\n\n\nb\n'));
        controller.close();
      },
    });

    const reader = new LineReader(stream);
    expect(await reader.readLine()).toBe('a');
    expect(await reader.readLine()).toBe('b');
    expect(await reader.readLine()).toBe(null);
  });
});

// ── WarmWorkerPool ────────────────────────────────────────────────────

describe('WarmWorkerPool', () => {
  // Use a simple echo script as the warm worker for testing
  const echoWorkerPath = resolve(import.meta.dir, 'fixtures/echo-warm-worker.ts');
  let pool: WarmWorkerPool;

  afterEach(() => {
    pool?.shutdown();
  });

  test('acquire returns a warm worker', async () => {
    pool = new WarmWorkerPool(echoWorkerPath, { PATH: process.env.PATH }, 1);
    const worker = await pool.acquire();
    expect(worker).not.toBeNull();
    expect(worker!.busy).toBe(true);
  });

  test('acquire returns null when all workers are busy', async () => {
    pool = new WarmWorkerPool(echoWorkerPath, { PATH: process.env.PATH }, 1);
    const w1 = await pool.acquire();
    expect(w1).not.toBeNull();
    const w2 = await pool.acquire();
    expect(w2).toBeNull();
  });

  test('release makes worker available again', async () => {
    pool = new WarmWorkerPool(echoWorkerPath, { PATH: process.env.PATH }, 1);
    const w1 = await pool.acquire();
    expect(w1).not.toBeNull();
    pool.release(w1!);
    const w2 = await pool.acquire();
    expect(w2).not.toBeNull();
    expect(w2).toBe(w1); // same worker reused
  });

  test('warm worker processes task and returns response', async () => {
    pool = new WarmWorkerPool(echoWorkerPath, { PATH: process.env.PATH }, 1);
    const worker = await pool.acquire();
    expect(worker).not.toBeNull();

    // Send a task (echo worker returns input as-is)
    const task = { taskId: 'test-1', data: 'hello' };
    worker!.stdin.write(`${JSON.stringify(task)}\n`);

    const response = await worker!.reader.readLine();
    expect(response).not.toBeNull();
    const parsed = JSON.parse(response!);
    expect(parsed.taskId).toBe('test-1');

    pool.release(worker!);
  });

  test('consecutive tasks on same warm worker', async () => {
    pool = new WarmWorkerPool(echoWorkerPath, { PATH: process.env.PATH }, 1);
    const worker = await pool.acquire();
    expect(worker).not.toBeNull();

    // First task
    worker!.stdin.write(`${JSON.stringify({ taskId: 't-1' })}\n`);
    const r1 = await worker!.reader.readLine();
    expect(JSON.parse(r1!).taskId).toBe('t-1');
    pool.release(worker!);

    // Second task (reuse same worker)
    const w2 = await pool.acquire();
    expect(w2).toBe(worker);
    w2!.stdin.write(`${JSON.stringify({ taskId: 't-2' })}\n`);
    const r2 = await w2!.reader.readLine();
    expect(JSON.parse(r2!).taskId).toBe('t-2');
    pool.release(w2!);
  });

  test('shutdown kills all workers', async () => {
    pool = new WarmWorkerPool(echoWorkerPath, { PATH: process.env.PATH }, 2);
    await pool.acquire(); // trigger initialization
    expect(pool.size).toBe(2);
    pool.shutdown();
    expect(pool.size).toBe(0);
  });

  test('kill removes worker and spawns replacement', async () => {
    pool = new WarmWorkerPool(echoWorkerPath, { PATH: process.env.PATH }, 1);
    const worker = await pool.acquire();
    expect(worker).not.toBeNull();
    pool.kill(worker!);
    // After kill + replacement spawn, pool should eventually have a worker again
    // Give replacement time to spawn
    await new Promise((r) => setTimeout(r, 500));
    expect(pool.size).toBe(1);
  });
});

// ── Warm Worker Integration — real worker-entry.ts ────────────────────

function makeWorkerInput(taskId: string): object {
  return {
    taskId,
    goal: 'test task',
    taskType: 'code',
    routingLevel: 1,
    perception: {
      taskTarget: { file: 'src/test.ts', description: 'test' },
      dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
      diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
      verifiedFacts: [],
      runtime: { nodeVersion: 'v18', os: 'darwin', availableTools: [] },
    },
    workingMemory: { failedApproaches: [], activeHypotheses: [], unresolvedUncertainties: [], scopedFacts: [] },
    budget: { maxTokens: 1000, timeoutMs: 5000 },
    allowedPaths: ['src/'],
    isolationLevel: 1,
  };
}

describe('Warm Worker Integration — real worker-entry.ts', () => {
  const workerPath = resolve(import.meta.dir, '../../../src/orchestrator/worker/worker-entry.ts');
  let proc: ReturnType<typeof Bun.spawn> | null = null;

  afterEach(() => {
    if (proc) {
      try {
        proc.kill();
      } catch (_) {
        /* already dead */
      }
      proc = null;
    }
  });

  function spawnWarmWorker() {
    proc = Bun.spawn(['bun', 'run', workerPath, '--warm'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PATH: process.env.PATH },
    });
    return proc;
  }

  test('warm worker-entry.ts sends ready signal', async () => {
    const worker = spawnWarmWorker();
    const reader = new LineReader(worker.stdout as ReadableStream<Uint8Array>);

    const readyLine = await reader.readLine();
    expect(readyLine).not.toBeNull();
    const ready = JSON.parse(readyLine!);
    expect(ready).toEqual({ ready: true });
  }, 15_000);

  test('warm worker-entry.ts processes WorkerInput and returns WorkerOutput', async () => {
    const worker = spawnWarmWorker();
    const reader = new LineReader(worker.stdout as ReadableStream<Uint8Array>);

    // Wait for ready
    const readyLine = await reader.readLine();
    expect(JSON.parse(readyLine!)).toEqual({ ready: true });

    // Send a task
    const input = makeWorkerInput('integration-1');
    worker.stdin.write(`${JSON.stringify(input)}\n`);
    worker.stdin.flush();

    const outputLine = await reader.readLine();
    expect(outputLine).not.toBeNull();
    const output = JSON.parse(outputLine!);

    expect(output.taskId).toBe('integration-1');
    expect(Array.isArray(output.proposedMutations)).toBe(true);
    expect(Array.isArray(output.proposedToolCalls)).toBe(true);
    expect(Array.isArray(output.uncertainties)).toBe(true);
    expect(typeof output.tokensConsumed).toBe('number');
    expect(typeof output.durationMs).toBe('number');
  }, 15_000);

  test('warm worker-entry.ts handles consecutive tasks', async () => {
    const worker = spawnWarmWorker();
    const reader = new LineReader(worker.stdout as ReadableStream<Uint8Array>);

    // Wait for ready
    await reader.readLine();

    // First task
    worker.stdin.write(`${JSON.stringify(makeWorkerInput('seq-1'))}\n`);
    worker.stdin.flush();
    const out1 = JSON.parse((await reader.readLine())!);
    expect(out1.taskId).toBe('seq-1');

    // Second task
    worker.stdin.write(`${JSON.stringify(makeWorkerInput('seq-2'))}\n`);
    worker.stdin.flush();
    const out2 = JSON.parse((await reader.readLine())!);
    expect(out2.taskId).toBe('seq-2');
  }, 15_000);

  test('warm worker-entry.ts handles invalid JSON gracefully', async () => {
    const worker = spawnWarmWorker();
    const reader = new LineReader(worker.stdout as ReadableStream<Uint8Array>);

    // Wait for ready
    await reader.readLine();

    // Send garbage
    worker.stdin.write('not valid json at all\n');
    worker.stdin.flush();

    const errorLine = await reader.readLine();
    expect(errorLine).not.toBeNull();
    const errorOutput = JSON.parse(errorLine!);
    expect(errorOutput.taskId).toBe('unknown');
    expect(errorOutput.uncertainties.length).toBeGreaterThan(0);

    // Verify worker is still alive — send a valid task
    worker.stdin.write(`${JSON.stringify(makeWorkerInput('after-error'))}\n`);
    worker.stdin.flush();
    const validOutput = JSON.parse((await reader.readLine())!);
    expect(validOutput.taskId).toBe('after-error');
  }, 15_000);
});
