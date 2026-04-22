/**
 * LocalInprocBackend — calls a ReasoningEngine directly in the parent process.
 *
 * Use cases:
 *   - L0 tasks (no file mutations by definition — A6 allows zero isolation)
 *   - Tests where subprocess overhead would dominate
 *   - Non-LLM REs that cannot be serialized across the subprocess boundary
 *
 * This backend does NOT spawn a subprocess. It takes a pre-built
 * ReasoningEngine via DI and forwards WorkerInput → RERequest → REResponse.
 * Timings are measured against the injected clock so tests can assert
 * deterministic durationMs values.
 *
 * A6 note: isolationLevel=0 explicitly accepts the zero-sandbox trade-off.
 * L0 tasks are read-only by definition, so there is nothing to sandbox.
 * The warning lives in worker-pool.ts when a caller flips useSubprocess=false
 * for L1+ tasks.
 */

import type { ReasoningEngine, RERequest } from '../../orchestrator/types.ts';
import type {
  BackendHandle,
  BackendSpawnSpec,
  HealthReport,
  IsolationLevel,
  WorkerBackend,
  WorkerInput,
  WorkerOutput,
} from '../backend.ts';

export interface LocalInprocBackendOptions {
  readonly reasoningEngine: ReasoningEngine;
  /** Clock injection for deterministic tests. Defaults to performance.now. */
  readonly clock?: () => number;
}

interface InprocHandleState {
  readonly engine: ReasoningEngine;
}

export class LocalInprocBackend implements WorkerBackend {
  readonly id = 'local-inproc' as const;
  readonly isolationLevel: IsolationLevel = 0;
  readonly supportsHibernation = false;
  readonly trustTier = 'deterministic' as const;

  private readonly engine: ReasoningEngine;
  private readonly clock: () => number;

  constructor(opts: LocalInprocBackendOptions) {
    this.engine = opts.reasoningEngine;
    this.clock = opts.clock ?? (() => performance.now());
  }

  async spawn(spec: BackendSpawnSpec): Promise<BackendHandle> {
    // No subprocess; `internal` carries the engine reference so execute()
    // does not need to reach back through `this` — keeps the handle
    // self-contained and testable.
    const internal: InprocHandleState = { engine: this.engine };
    return {
      backendId: this.id,
      spawnSpec: spec,
      spawnedAt: this.clock(),
      internal,
    };
  }

  async execute(handle: BackendHandle, input: WorkerInput): Promise<WorkerOutput> {
    const state = handle.internal as InprocHandleState;
    const engine = state.engine;
    const start = this.clock();

    // Map WorkerInput → RERequest. The inproc path accepts the prompt as a
    // pre-assembled string (caller is the orchestrator or a test harness).
    // Budget defaults match the legacy worker-pool's emptyOutput path when
    // the caller provides nothing.
    const maxTokens = input.budget?.tokens ?? 0;
    const req: RERequest = {
      systemPrompt: '',
      userPrompt: input.prompt,
      maxTokens,
    };

    try {
      const res = await engine.execute(req);
      const durationMs = Math.round(this.clock() - start);
      const tokensUsed = res.tokensUsed.input + res.tokensUsed.output;
      return {
        ok: true,
        output: {
          content: res.content,
          toolCalls: res.toolCalls,
          terminationReason: res.terminationReason,
          thinking: res.thinking,
          engineId: res.engineId,
        },
        durationMs,
        tokensUsed,
      };
    } catch (err) {
      const durationMs = Math.round(this.clock() - start);
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: msg,
        durationMs,
      };
    }
  }

  async teardown(_handle: BackendHandle): Promise<void> {
    // In-process: nothing to tear down. The engine is owned by the factory
    // and lives for the life of the orchestrator.
  }

  async healthProbe(_handle: BackendHandle): Promise<HealthReport> {
    const start = this.clock();
    // In-process probe is a no-op measurement — engine is always "healthy"
    // from the backend's perspective (if the engine is broken, execute()
    // surfaces the error).
    const latencyMs = Math.round(this.clock() - start);
    return { ok: true, latencyMs, notes: 'inproc: engine reference is always live' };
  }
}
