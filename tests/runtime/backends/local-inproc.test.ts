/**
 * LocalInprocBackend — verifies in-process dispatch calls the ReasoningEngine
 * and returns a WorkerOutput shaped from the RE response. Timings asserted
 * against injected clock.
 */
import { describe, expect, test } from 'bun:test';
import type { RERequest, REResponse, ReasoningEngine } from '../../../src/orchestrator/types.ts';
import type { BackendSpawnSpec, WorkerInput } from '../../../src/runtime/backend.ts';
import { LocalInprocBackend } from '../../../src/runtime/backends/local-inproc.ts';

interface RecordedCall {
  readonly req: RERequest;
}

function makeEngine(
  response: Partial<REResponse> & { content?: string } = {},
  opts?: { latencyClockSteps?: number[]; throwErr?: Error },
): { engine: ReasoningEngine; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const engine: ReasoningEngine = {
    id: 'mock-engine',
    engineType: 'llm',
    capabilities: ['code-generation'],
    async execute(req: RERequest): Promise<REResponse> {
      calls.push({ req });
      if (opts?.throwErr) throw opts.throwErr;
      return {
        content: response.content ?? 'ok',
        toolCalls: response.toolCalls ?? [],
        tokensUsed: response.tokensUsed ?? { input: 10, output: 5 },
        engineId: 'mock-engine',
        terminationReason: response.terminationReason ?? 'completed',
        thinking: response.thinking,
      };
    },
  };
  return { engine, calls };
}

function makeSpec(taskId = 't-1'): BackendSpawnSpec {
  return {
    taskId,
    routingLevel: 0,
    workspace: { host: '/tmp/workspace', readonly: true },
    networkPolicy: 'deny-all',
    resourceLimits: { cpuMs: 0, memMB: 0, fdMax: 0 },
    log: () => {},
  };
}

describe('LocalInprocBackend', () => {
  test('identity fields match spec', () => {
    const { engine } = makeEngine();
    const backend = new LocalInprocBackend({ reasoningEngine: engine });
    expect(backend.id).toBe('local-inproc');
    expect(backend.isolationLevel).toBe(0);
    expect(backend.supportsHibernation).toBe(false);
    expect(backend.trustTier).toBe('deterministic');
  });

  test('spawn returns a handle with correct backendId and clock-based spawnedAt', async () => {
    const { engine } = makeEngine();
    const backend = new LocalInprocBackend({ reasoningEngine: engine, clock: () => 100 });
    const handle = await backend.spawn(makeSpec());
    expect(handle.backendId).toBe('local-inproc');
    expect(handle.spawnedAt).toBe(100);
    expect(handle.spawnSpec.taskId).toBe('t-1');
  });

  test('execute forwards prompt to the engine', async () => {
    const { engine, calls } = makeEngine();
    const backend = new LocalInprocBackend({ reasoningEngine: engine });
    const handle = await backend.spawn(makeSpec());
    const input: WorkerInput = { taskId: 't-1', prompt: 'solve x', budget: { tokens: 1000, timeMs: 0 } };
    await backend.execute(handle, input);
    expect(calls.length).toBe(1);
    expect(calls[0]!.req.userPrompt).toBe('solve x');
    expect(calls[0]!.req.maxTokens).toBe(1000);
  });

  test('execute wraps RE response into WorkerOutput.output with content + toolCalls', async () => {
    const { engine } = makeEngine({ content: 'hello world' });
    const backend = new LocalInprocBackend({ reasoningEngine: engine });
    const handle = await backend.spawn(makeSpec());
    const out = await backend.execute(handle, { taskId: 't-1', prompt: '' });
    expect(out.ok).toBe(true);
    const output = out.output as { content: string; engineId: string };
    expect(output.content).toBe('hello world');
    expect(output.engineId).toBe('mock-engine');
    expect(out.tokensUsed).toBe(15); // 10 + 5
    expect(out.exitCode).toBeUndefined();
  });

  test('execute.durationMs reflects clock diff', async () => {
    const { engine } = makeEngine();
    const ticks = [0, 42]; // spawn=0, execute start=0 (re-read), execute end=42
    let i = 0;
    // clock reads at: spawn, execute start, execute end -> 3 reads total.
    // We want execute start=0, end=42 → durationMs=42.
    const sequence = [0, 0, 42];
    const backend = new LocalInprocBackend({
      reasoningEngine: engine,
      clock: () => sequence[Math.min(i++, sequence.length - 1)] ?? 0,
    });
    const handle = await backend.spawn(makeSpec());
    const out = await backend.execute(handle, { taskId: 't-1', prompt: '' });
    expect(out.durationMs).toBe(42);
    void ticks;
  });

  test('execute returns ok:false when engine throws', async () => {
    const { engine } = makeEngine({}, { throwErr: new Error('engine blew up') });
    const backend = new LocalInprocBackend({ reasoningEngine: engine });
    const handle = await backend.spawn(makeSpec());
    const out = await backend.execute(handle, { taskId: 't-1', prompt: '' });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('engine blew up');
  });

  test('teardown is a no-op (resolves without throwing)', async () => {
    const { engine } = makeEngine();
    const backend = new LocalInprocBackend({ reasoningEngine: engine });
    const handle = await backend.spawn(makeSpec());
    await backend.teardown(handle);
  });

  test('healthProbe reports ok with near-zero latency', async () => {
    const { engine } = makeEngine();
    const backend = new LocalInprocBackend({ reasoningEngine: engine });
    const handle = await backend.spawn(makeSpec());
    const health = await backend.healthProbe(handle);
    expect(health.ok).toBe(true);
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test('concurrent executes do not interfere', async () => {
    const { engine, calls } = makeEngine({ content: 'r' });
    const backend = new LocalInprocBackend({ reasoningEngine: engine });
    const handle = await backend.spawn(makeSpec());
    const [a, b, c] = await Promise.all([
      backend.execute(handle, { taskId: 'a', prompt: 'pa' }),
      backend.execute(handle, { taskId: 'b', prompt: 'pb' }),
      backend.execute(handle, { taskId: 'c', prompt: 'pc' }),
    ]);
    expect(a.ok && b.ok && c.ok).toBe(true);
    expect(calls.length).toBe(3);
    const prompts = calls.map((c) => c.req.userPrompt).sort();
    expect(prompts).toEqual(['pa', 'pb', 'pc']);
  });
});
