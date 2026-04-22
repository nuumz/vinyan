/**
 * LocalSubprocBackend — spawns worker-entry.ts as a child process and talks
 * to it over JSON-line IPC on stdin/stdout. Mirrors the cold-subprocess path
 * in src/orchestrator/worker/worker-pool.ts so the pre-refactor behavior is
 * preserved bit-for-bit when a caller routes L1 through this backend.
 *
 * MVP scope: the backend is fully implemented (spawn / execute / teardown)
 * and tested standalone, but worker-pool does NOT yet delegate L1 to it.
 * The only live delegation wired up by this MVP is L0 → LocalInprocBackend.
 * Full L1 migration through the backend abstraction is a follow-up PR.
 *
 * IPC contract (matches worker-entry.ts):
 *   - stdin:  one JSON line containing whatever the caller put in
 *             WorkerInput.payload (typically a WorkerInputSchema-validated
 *             object). The backend is payload-agnostic — it does not re-
 *             validate the schema. Callers are responsible for handing in a
 *             worker-entry-compatible payload.
 *   - stdout: optional `{"type":"delta", ... }` lines, then one JSON line
 *             that the caller parses as the worker output.
 *
 * A6 note: isolationLevel=1. Subprocess isolation without container = trust
 * tier 'heuristic' (process boundary stops accidents, not adversaries).
 */

import type {
  BackendHandle,
  BackendSpawnSpec,
  HealthReport,
  IsolationLevel,
  WorkerBackend,
  WorkerInput,
  WorkerOutput,
} from '../backend.ts';

/** Subprocess object shape that both real Bun.spawn and test mocks implement. */
export interface SpawnedProcess {
  readonly stdin: {
    write(data: string): number | void;
    end(): void;
  };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(): void;
}

/** Injectable spawn function — lets tests replace Bun.spawn without patching globals. */
export type SpawnImpl = (
  cmd: string[],
  opts: { stdin: 'pipe'; stdout: 'pipe'; stderr: 'pipe'; env?: Record<string, string | undefined> },
) => SpawnedProcess;

export interface LocalSubprocBackendOptions {
  /** Absolute path to the worker entry script (ts or bundled js). */
  readonly workerEntryPath: string;
  /** Extra bun args. Default: none. */
  readonly bunArgs?: readonly string[];
  /** Clock injection for deterministic tests. */
  readonly clock?: () => number;
  /** Spawn injection for tests. Defaults to Bun.spawn. */
  readonly spawnImpl?: SpawnImpl;
  /** Env passthrough allowlist. When absent, a minimal default is used. */
  readonly env?: Record<string, string | undefined>;
}

interface SubprocHandleState {
  readonly proc: SpawnedProcess;
}

const DEFAULT_BUN_ARGS: readonly string[] = [];

export class LocalSubprocBackend implements WorkerBackend {
  readonly id = 'local-subproc' as const;
  readonly isolationLevel: IsolationLevel = 1;
  readonly supportsHibernation = false;
  readonly trustTier = 'heuristic' as const;

  private readonly workerEntryPath: string;
  private readonly bunArgs: readonly string[];
  private readonly clock: () => number;
  private readonly spawnImpl: SpawnImpl;
  private readonly env?: Record<string, string | undefined>;

  constructor(opts: LocalSubprocBackendOptions) {
    this.workerEntryPath = opts.workerEntryPath;
    this.bunArgs = opts.bunArgs ?? DEFAULT_BUN_ARGS;
    this.clock = opts.clock ?? (() => performance.now());
    // Use the provided spawn impl when present; otherwise fall back to Bun.spawn
    // via a narrow cast so the interface stays process-type-agnostic.
    this.spawnImpl =
      opts.spawnImpl ??
      ((cmd, o) => Bun.spawn(cmd, o) as unknown as SpawnedProcess);
    this.env = opts.env;
  }

  async spawn(spec: BackendSpawnSpec): Promise<BackendHandle> {
    const cmd = ['bun', 'run', ...this.bunArgs, this.workerEntryPath];
    const env = this.buildEnv(spec);
    const proc = this.spawnImpl(cmd, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env });
    const internal: SubprocHandleState = { proc };
    return {
      backendId: this.id,
      spawnSpec: spec,
      spawnedAt: this.clock(),
      internal,
    };
  }

  async execute(handle: BackendHandle, input: WorkerInput): Promise<WorkerOutput> {
    const state = handle.internal as SubprocHandleState;
    const proc = state.proc;
    const start = this.clock();

    // Payload → stdin as a single JSON line. The caller owns the shape
    // (must match worker-entry.ts expectations). If no payload, fall back
    // to a minimal envelope containing taskId + prompt — useful for smoke
    // tests and for backends that embed their own worker scripts.
    const payload = input.payload ?? { taskId: input.taskId, prompt: input.prompt };
    try {
      proc.stdin.write(`${JSON.stringify(payload)}\n`);
      proc.stdin.end();
    } catch (err) {
      // stdin broken before the child could accept the line.
      const msg = err instanceof Error ? err.message : String(err);
      try {
        proc.kill();
      } catch {
        /* already dead */
      }
      return {
        ok: false,
        error: `stdin write failed: ${msg}`,
        durationMs: Math.round(this.clock() - start),
      };
    }

    const timeoutMs = input.budget?.timeMs ?? 0;
    const stdoutPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();
    const exitPromise = proc.exited;

    const collect = Promise.all([stdoutPromise, stderrPromise, exitPromise]);
    const raced = timeoutMs > 0
      ? await Promise.race([
          collect,
          new Promise<'timeout'>((r) => {
            const t = setTimeout(() => r('timeout'), timeoutMs);
            (t as { unref?: () => void }).unref?.();
          }),
        ])
      : await collect;

    if (raced === 'timeout') {
      try {
        proc.kill();
      } catch {
        /* already dead */
      }
      return {
        ok: false,
        error: `subprocess timed out after ${timeoutMs}ms`,
        durationMs: Math.round(this.clock() - start),
      };
    }

    const [stdout, stderr, exitCode] = raced;
    const durationMs = Math.round(this.clock() - start);

    if (exitCode !== 0) {
      return {
        ok: false,
        error: stderr.trim() || `subprocess exited with code ${exitCode}`,
        durationMs,
        exitCode,
      };
    }

    // Parse the final JSON line. Earlier lines may be `{type:"delta",...}`
    // streaming chunks — we ignore them here (streaming forwarding is a
    // worker-pool concern and kept there for MVP scope). The last valid
    // JSON object wins, matching dispatchColdSubprocess semantics.
    const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    let parsed: unknown = undefined;
    let parseError = false;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === 'object' && (obj as { type?: unknown }).type === 'delta') continue;
        parsed = obj;
      } catch {
        parseError = true;
      }
    }

    if (parsed === undefined) {
      return {
        ok: false,
        error: parseError ? 'failed to parse worker stdout as JSON' : 'worker produced no output',
        durationMs,
        exitCode,
      };
    }

    return {
      ok: true,
      output: parsed,
      durationMs,
      exitCode,
    };
  }

  async teardown(handle: BackendHandle): Promise<void> {
    const state = handle.internal as SubprocHandleState;
    try {
      state.proc.kill();
    } catch {
      /* already dead */
    }
  }

  async healthProbe(handle: BackendHandle): Promise<HealthReport> {
    const state = handle.internal as SubprocHandleState;
    const start = this.clock();
    // The subprocess is healthy iff .exited is still pending. We race a
    // zero-delay promise so this is non-blocking.
    const result = await Promise.race([
      state.proc.exited.then((code): { exited: true; code: number } => ({ exited: true, code })),
      new Promise<{ exited: false }>((r) => {
        const t = setTimeout(() => r({ exited: false }), 0);
        (t as { unref?: () => void }).unref?.();
      }),
    ]);
    const latencyMs = Math.round(this.clock() - start);
    if (result.exited) {
      return { ok: false, latencyMs, notes: `process exited with code ${result.code}` };
    }
    return { ok: true, latencyMs };
  }

  private buildEnv(spec: BackendSpawnSpec): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...(this.env ?? {}) };
    const proxy = spec.credentials?.llmProxySocket;
    if (proxy) {
      env.VINYAN_LLM_PROXY_SOCKET = proxy;
    }
    return env;
  }
}
