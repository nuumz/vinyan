/**
 * LocalSubprocBackend — verifies the subprocess lifecycle (spawn → stdin/stdout
 * IPC → teardown) using an injected spawnImpl so tests never touch a real
 * child process.
 */
import { describe, expect, test } from 'bun:test';
import type { BackendSpawnSpec, WorkerInput } from '../../../src/runtime/backend.ts';
import {
  LocalSubprocBackend,
  type SpawnImpl,
  type SpawnedProcess,
} from '../../../src/runtime/backends/local-subproc.ts';

interface FakeProcessOptions {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly exitDelayMs?: number;
  readonly throwOnWrite?: boolean;
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

interface FakeProcess extends SpawnedProcess {
  readonly stdinWrites: string[];
  readonly flags: { stdinEnded: boolean; killed: boolean };
}

function makeFakeProcess(opts: FakeProcessOptions = {}): FakeProcess {
  const stdinWrites: string[] = [];
  const flags = { stdinEnded: false, killed: false };
  const exitDelay = opts.exitDelayMs ?? 0;
  const exitCode = opts.exitCode ?? 0;
  const proc: FakeProcess = {
    stdin: {
      write(data: string): number {
        if (opts.throwOnWrite) throw new Error('EPIPE');
        stdinWrites.push(data);
        return data.length;
      },
      end() {
        flags.stdinEnded = true;
      },
    },
    stdout: streamOf(opts.stdout ?? ''),
    stderr: streamOf(opts.stderr ?? ''),
    exited: new Promise<number>((r) => setTimeout(() => r(exitCode), exitDelay)),
    kill() {
      flags.killed = true;
    },
    stdinWrites,
    flags,
  };
  return proc;
}

function makeSpec(overrides?: Partial<BackendSpawnSpec>): BackendSpawnSpec {
  return {
    taskId: 't-sub-1',
    routingLevel: 1,
    workspace: { host: '/tmp/workspace', readonly: false },
    networkPolicy: 'deny-all',
    resourceLimits: { cpuMs: 1000, memMB: 128, fdMax: 64 },
    log: () => {},
    ...overrides,
  };
}

describe('LocalSubprocBackend', () => {
  test('identity fields match spec', () => {
    const backend = new LocalSubprocBackend({
      workerEntryPath: '/fake/worker.ts',
      spawnImpl: (() => makeFakeProcess()) as unknown as SpawnImpl,
    });
    expect(backend.id).toBe('local-subproc');
    expect(backend.isolationLevel).toBe(1);
    expect(backend.supportsHibernation).toBe(false);
    expect(backend.trustTier).toBe('heuristic');
  });

  test('spawn calls spawnImpl with bun + worker entry path', async () => {
    const calls: Array<{ cmd: string[]; env?: Record<string, string | undefined> }> = [];
    const spawnImpl: SpawnImpl = (cmd, opts) => {
      calls.push({ cmd, env: opts.env });
      return makeFakeProcess();
    };
    const backend = new LocalSubprocBackend({
      workerEntryPath: '/path/to/worker.ts',
      spawnImpl,
    });
    await backend.spawn(makeSpec());
    expect(calls.length).toBe(1);
    expect(calls[0]!.cmd).toEqual(['bun', 'run', '/path/to/worker.ts']);
  });

  test('spawn threads llmProxySocket into env', async () => {
    const calls: Array<{ env?: Record<string, string | undefined> }> = [];
    const spawnImpl: SpawnImpl = (_cmd, opts) => {
      calls.push({ env: opts.env });
      return makeFakeProcess();
    };
    const backend = new LocalSubprocBackend({
      workerEntryPath: '/w.ts',
      spawnImpl,
    });
    await backend.spawn(
      makeSpec({ credentials: { llmProxySocket: '/tmp/proxy.sock' } }),
    );
    expect(calls[0]!.env?.VINYAN_LLM_PROXY_SOCKET).toBe('/tmp/proxy.sock');
  });

  test('execute writes payload to stdin and reads stdout JSON', async () => {
    const fake = makeFakeProcess({ stdout: `${JSON.stringify({ taskId: 't-sub-1', result: 'done' })}\n` });
    const spawnImpl: SpawnImpl = () => fake;
    const backend = new LocalSubprocBackend({ workerEntryPath: '/w.ts', spawnImpl });
    const handle = await backend.spawn(makeSpec());
    const input: WorkerInput = {
      taskId: 't-sub-1',
      prompt: 'p',
      payload: { hello: 'world' },
    };
    const out = await backend.execute(handle, input);
    expect(out.ok).toBe(true);
    expect(fake.stdinWrites.length).toBe(1);
    expect(JSON.parse(fake.stdinWrites[0]!.trim())).toEqual({ hello: 'world' });
    expect(fake.flags.stdinEnded).toBe(true);
    const output = out.output as { result: string };
    expect(output.result).toBe('done');
    expect(out.exitCode).toBe(0);
  });

  test('execute surfaces non-zero exit code as ok:false', async () => {
    const fake = makeFakeProcess({ stdout: '', stderr: 'boom', exitCode: 2 });
    const backend = new LocalSubprocBackend({
      workerEntryPath: '/w.ts',
      spawnImpl: () => fake,
    });
    const handle = await backend.spawn(makeSpec());
    const out = await backend.execute(handle, { taskId: 't', prompt: 'p' });
    expect(out.ok).toBe(false);
    expect(out.exitCode).toBe(2);
    expect(out.error).toBe('boom');
  });

  test('execute returns ok:false when stdout is not parseable JSON', async () => {
    const fake = makeFakeProcess({ stdout: 'not-json\n', exitCode: 0 });
    const backend = new LocalSubprocBackend({
      workerEntryPath: '/w.ts',
      spawnImpl: () => fake,
    });
    const handle = await backend.spawn(makeSpec());
    const out = await backend.execute(handle, { taskId: 't', prompt: 'p' });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/failed to parse worker stdout/);
  });

  test('execute ignores delta lines and returns last JSON object', async () => {
    const stdout = [
      JSON.stringify({ type: 'delta', taskId: 't', text: 'streaming' }),
      JSON.stringify({ taskId: 't', result: 'final' }),
    ].join('\n') + '\n';
    const fake = makeFakeProcess({ stdout, exitCode: 0 });
    const backend = new LocalSubprocBackend({
      workerEntryPath: '/w.ts',
      spawnImpl: () => fake,
    });
    const handle = await backend.spawn(makeSpec());
    const out = await backend.execute(handle, { taskId: 't', prompt: 'p' });
    expect(out.ok).toBe(true);
    const output = out.output as { result: string };
    expect(output.result).toBe('final');
  });

  test('stdin write failure kills process and returns ok:false', async () => {
    const fake = makeFakeProcess({ throwOnWrite: true });
    const backend = new LocalSubprocBackend({
      workerEntryPath: '/w.ts',
      spawnImpl: () => fake,
    });
    const handle = await backend.spawn(makeSpec());
    const out = await backend.execute(handle, { taskId: 't', prompt: 'p' });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/stdin write failed/);
    expect(fake.flags.killed).toBe(true);
  });

  test('teardown kills the process', async () => {
    const fake = makeFakeProcess();
    const backend = new LocalSubprocBackend({
      workerEntryPath: '/w.ts',
      spawnImpl: () => fake,
    });
    const handle = await backend.spawn(makeSpec());
    await backend.teardown(handle);
    expect(fake.flags.killed).toBe(true);
  });
});
