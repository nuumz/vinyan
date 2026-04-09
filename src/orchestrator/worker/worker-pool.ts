/**
 * Worker Pool — dispatches tasks to LLM via in-process call or subprocess.
 *
 * L0: No LLM — returns empty result immediately.
 * L1+: Selects provider from registry, assembles prompt, calls LLM.
 * Subprocess mode follows oracle/runner.ts pattern (Bun.spawn + timeout + Zod validation).
 *
 * Source of truth: spec/tdd.md §16.3 (Worker lifecycle), §17 (Generator Engine)
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

/** Prefer pre-bundled JS worker if available (eliminates ~3.7s TS compilation per spawn). */
function resolveWorkerEntryPath(): string {
  const bundled = resolve(import.meta.dir, '../../../dist/worker-entry.js');
  if (existsSync(bundled)) return bundled;
  return resolve(import.meta.dir, 'worker-entry.ts');
}
import type { WorkerPool } from '../core-loop.ts';
import type { VinyanBus } from '../../core/bus.ts';
import type { AgentLoopDeps } from './agent-loop.ts';
import { assemblePrompt } from '../llm/prompt-assembler.ts';
import { loadInstructionMemory } from '../llm/instruction-loader.ts';
import { buildTaskUnderstanding } from '../understanding/task-understanding.ts';
import { LLMReasoningEngine, ReasoningEngineRegistry } from '../llm/llm-reasoning-engine.ts';
import { LLMProviderRegistry } from '../llm/provider-registry.ts';
import { WorkerInputSchema, WorkerOutputSchema } from '../protocol.ts';
import {
  type IsolationLevel,
  type PerceptualHierarchy,
  type PerceptionRole,
  PromptTooLargeError,
  type REResponse,
  type RoutingDecision,
  type TaskDAG,
  type TaskInput,
  type WorkerInput,
  type WorkerOutput,
  type WorkingMemoryState,
} from '../types.ts';

/** WorkerOutput extended with cache token metrics from LLM response (in-process path only). */
type WorkerOutputWithCache = WorkerOutput & {
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Extensible Thinking: thinking tokens used (from REResponse.tokensUsed.thinkingTokens or char-length proxy). */
  thinkingTokensUsed?: number;
  /** Raw thinking content from the LLM response. */
  thinking?: string;
};

export interface WorkerPoolConfig {
  /**
   * Legacy LLM provider registry. Optional when `engineRegistry` is provided.
   * Used by the subprocess dispatch path (L2/L3), which is LLM-only by design.
   * In-process dispatch prefers `engineRegistry` when both are present.
   */
  registry?: LLMProviderRegistry;
  workspace: string;
  /** Use subprocess for L1+ dispatch (default: false — in-process). */
  useSubprocess?: boolean;
  /** Override worker entry script path. */
  workerEntryPath?: string;
  /** Unix socket path for LLM proxy (A6: credential isolation). */
  proxySocketPath?: string;
  /** Agent loop deps for Phase 6.3+ agentic dispatch. */
  agentLoopDeps?: Partial<AgentLoopDeps>;
  /** Max concurrent sessions per routing level. */
  maxConcurrentSessions?: { l1?: number; l2?: number; l3?: number };
  /**
   * RE-agnostic engine registry. If provided, in-process dispatch uses this
   * instead of wrapping `registry`. Enables non-LLM Reasoning Engines (AGI, symbolic, etc.)
   * to be registered and dispatched without changing the core loop.
   */
  engineRegistry?: ReasoningEngineRegistry;
  /** Enable warm worker pool for subprocess dispatch (default: true when useSubprocess=true). */
  useWarmPool?: boolean;
  /** Number of warm workers to maintain (default: 2). */
  warmPoolSize?: number;
  /** Event bus for warm pool observability metrics. */
  bus?: VinyanBus;
}

// ── Semaphore ─────────────────────────────────────────────────────────

export class Semaphore {
  private current = 0;
  private queue: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    await new Promise<void>(resolve => this.queue.push(resolve));
    this.current++;
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) next();
  }

  get activeCount(): number { return this.current; }
}

// ── Line Reader (for warm worker stdout) ──────────────────────────────

/**
 * Async line reader that consumes a ReadableStream and yields lines on demand.
 * Runs an internal pump loop; callers await `readLine()` which resolves when
 * a complete '\n'-terminated line is available.
 */
export class LineReader {
  private lines: string[] = [];
  private waiting: ((line: string | null) => void) | null = null;
  private done = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.pump(stream);
  }

  private async pump(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n');
        buffer = parts.pop()!;
        for (const part of parts) {
          if (part.trim()) this.emit(part.trim());
        }
      }
      if (buffer.trim()) this.emit(buffer.trim());
    } finally {
      this.done = true;
      if (this.waiting) {
        this.waiting(null);
        this.waiting = null;
      }
    }
  }

  private emit(line: string) {
    if (this.waiting) {
      const r = this.waiting;
      this.waiting = null;
      r(line);
    } else {
      this.lines.push(line);
    }
  }

  readLine(): Promise<string | null> {
    if (this.lines.length > 0) return Promise.resolve(this.lines.shift()!);
    if (this.done) return Promise.resolve(null);
    return new Promise((r) => { this.waiting = r; });
  }
}

// ── Warm Worker Pool ──────────────────────────────────────────────────

interface WarmWorker {
  proc: ReturnType<typeof Bun.spawn>;
  stdin: { write(data: string): number; end(): void; flush(): void };
  reader: LineReader;
  busy: boolean;
  taskCount: number;
  consecutiveErrors: number;
}

/** Max consecutive errors before a warm worker is killed and replaced. */
const WARM_WORKER_ERROR_THRESHOLD = 3;

export class WarmWorkerPool {
  private workers: WarmWorker[] = [];
  private _readyPromise: Promise<void>;

  constructor(
    private workerEntryPath: string,
    private env: Record<string, string | undefined>,
    private poolSize: number,
    private bus?: VinyanBus,
  ) {
    // Eager background init — start spawning immediately, don't block first acquire
    this._readyPromise = Promise.all(
      Array.from({ length: this.poolSize }, () => this.spawnWorker()),
    ).then(() => {});
  }

  /** Wait until all initial workers are ready. Used by tests only — production code never awaits this. */
  waitForReady(): Promise<void> {
    return this._readyPromise;
  }

  private async spawnWorker(): Promise<WarmWorker | null> {
    try {
      const proc = Bun.spawn(['bun', 'run', this.workerEntryPath, '--warm'], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: this.env,
      });

      const reader = new LineReader(proc.stdout as ReadableStream<Uint8Array>);

      // Wait for ready signal (first line)
      const readyLine = await Promise.race([
        reader.readLine(),
        new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
      ]);

      if (!readyLine) {
        proc.kill();
        return null;
      }

      try {
        const ready = JSON.parse(readyLine);
        if (!ready?.ready) {
          proc.kill();
          return null;
        }
      } catch {
        proc.kill();
        return null;
      }

      const stdin = proc.stdin as unknown as WarmWorker['stdin'];
      const worker: WarmWorker = { proc, stdin, reader, busy: false, taskCount: 0, consecutiveErrors: 0 };
      this.workers.push(worker);

      // Monitor process exit → remove from pool
      proc.exited.then(() => {
        const idx = this.workers.indexOf(worker);
        if (idx !== -1) this.workers.splice(idx, 1);
      });

      return worker;
    } catch {
      return null;
    }
  }

  async acquire(): Promise<WarmWorker | null> {
    // Non-blocking: return idle worker if any are ready, null → cold fallback
    const idle = this.workers.find((w) => !w.busy);
    if (idle) {
      idle.busy = true;
      return idle;
    }
    return null;
  }

  release(worker: WarmWorker): void {
    worker.busy = false;
    worker.taskCount++;
    worker.consecutiveErrors = 0;
  }

  /** Kill a worker and remove it from the pool. Replacement spawns lazily on next acquire. */
  kill(worker: WarmWorker, reason?: 'timeout' | 'stdin_error' | 'parse_error'): void {
    if (reason) {
      this.bus?.emit('warmpool:worker_replaced', { reason, taskCount: worker.taskCount });
    }
    worker.busy = true; // prevent reuse
    const idx = this.workers.indexOf(worker);
    if (idx !== -1) this.workers.splice(idx, 1);
    try { worker.proc.kill(); } catch { /* already dead */ }
    // Spawn replacement in background
    this.spawnWorker();
  }

  shutdown(): void {
    for (const w of this.workers) {
      try { w.stdin.end(); } catch { /* ignore */ }
      try { w.proc.kill(); } catch { /* ignore */ }
    }
    this.workers = [];
  }

  get idleCount(): number {
    return this.workers.filter((w) => !w.busy).length;
  }

  get size(): number {
    return this.workers.length;
  }
}

export class WorkerPoolImpl implements WorkerPool {
  private registry: LLMProviderRegistry;
  private engineRegistry: ReasoningEngineRegistry;
  private workspace: string;
  private useSubprocess: boolean;
  private workerEntryPath: string;
  private proxySocketPath?: string;
  private dockerAvailable: boolean | null = null;
  private _agentLoopDeps: AgentLoopDeps | null = null;
  private semaphores: Record<number, Semaphore>;
  private warmPool: WarmWorkerPool | null = null;
  private warmPoolConfig: { enabled: boolean; poolSize: number } = { enabled: false, poolSize: 2 };
  private bus?: VinyanBus;

  constructor(config: WorkerPoolConfig) {
    this.registry = config.registry ?? new LLMProviderRegistry();
    // Build RE registry: use provided one or wrap legacy LLM registry for backward compat
    this.engineRegistry = config.engineRegistry ?? ReasoningEngineRegistry.fromLLMRegistry(this.registry);
    this.workspace = config.workspace;
    this.useSubprocess = config.useSubprocess ?? true;
    this.proxySocketPath = config.proxySocketPath;
    if (!this.useSubprocess) {
      console.warn('[vinyan] WARNING: In-process worker mode is not A6-compliant. Use for testing only.');
    }
    this.workerEntryPath = config.workerEntryPath ?? resolveWorkerEntryPath();
    this.bus = config.bus;
    this.semaphores = {
      1: new Semaphore(config.maxConcurrentSessions?.l1 ?? 5),
      2: new Semaphore(config.maxConcurrentSessions?.l2 ?? 3),
      3: new Semaphore(config.maxConcurrentSessions?.l3 ?? 1),
    };

    // Defer warm pool creation — only spawn workers when first L2+ dispatch needs it.
    // L1 tasks always use in-process dispatch, so warm pool startup would waste CPU.
    this.warmPoolConfig = {
      enabled: config.useWarmPool ?? this.useSubprocess,
      poolSize: config.warmPoolSize ?? 2,
    };
  }

  /** Lazily create warm pool on first subprocess dispatch (L2+). */
  private ensureWarmPool(): WarmWorkerPool | null {
    if (this.warmPool) return this.warmPool;
    if (!this.warmPoolConfig.enabled) return null;
    const warmEnv = buildWorkerEnv(
      { level: 2, model: null, budgetTokens: 0, latencyBudgetMs: 0 },
      this.proxySocketPath,
    );
    this.warmPool = new WarmWorkerPool(
      this.workerEntryPath,
      warmEnv,
      this.warmPoolConfig.poolSize,
      this.bus,
    );
    return this.warmPool;
  }

  async dispatch(
    input: TaskInput,
    perception: PerceptualHierarchy,
    memory: WorkingMemoryState,
    plan: TaskDAG | undefined,
    routing: RoutingDecision,
    understanding?: import('../types.ts').SemanticTaskUnderstanding,
    contract?: import('../../core/agent-contract.ts').AgentContract,
    conversationHistory?: import('../types.ts').ConversationEntry[],
  ) {
    const startTime = performance.now();

    // L0: no LLM needed
    if (routing.level === 0) {
      return {
        mutations: [] as Array<{ file: string; content: string; diff: string; explanation: string }>,
        proposedToolCalls: [] as import('../types.ts').ToolCall[],
        tokensConsumed: 0,
        durationMs: Math.round(performance.now() - startTime),
      };
    }

    const workerInput = this.buildWorkerInput(input, perception, memory, plan, routing, understanding);
    // Carry conversation history for prompt assembly (not serialized into WorkerInput)
    const _conversationHistory = conversationHistory;

    // L2/L3: container dispatch when isolation level = 2
    // Skip container dispatch when useSubprocess=false (testing mode) — fall back to in-process
    if (workerInput.isolationLevel === 2 && this.useSubprocess) {
      // Pre-flight: check Docker availability (cached after first check)
      if (this.dockerAvailable === null) {
        this.dockerAvailable = this.checkDockerAvailable();
      }
      if (!this.dockerAvailable) {
        console.warn(
          '[vinyan] A6 WARNING: Docker unavailable — falling back to subprocess isolation. L2/L3 container isolation degraded.',
        );
        // Fall through to subprocess dispatch below
      } else {
        const output = await this.dispatchContainer(workerInput, routing);
        return this.toWorkerResult(output, startTime);
      }
    }

    // L1 single-shot: in-process always (subprocess overhead > 500ms defeats < 2s budget)
    // L2+ subprocess: isolation for file-mutating tasks.
    // DESIGN CONSTRAINT: subprocess path is LLM-only — worker-entry.ts reconstructs an
    // LLMProviderRegistry from env vars and cannot serialize/deserialize custom RE types.
    // If the selected engine is non-LLM, fall back to in-process dispatch with a warning.
    const selectedEngine = routing.workerId
      ? this.engineRegistry.selectById(routing.workerId)
      : this.engineRegistry.selectForRoutingLevel(routing.level);
    const isLLMEngine = !selectedEngine || selectedEngine.engineType === 'llm';
    const useSubprocessForTask = this.useSubprocess && routing.level >= 2 && isLLMEngine;
    if (!isLLMEngine && routing.level >= 2) {
      console.warn(
        `[vinyan] RE dispatch: engine '${selectedEngine?.id}' (type: ${selectedEngine?.engineType}) is non-LLM — subprocess isolation unavailable. Dispatching in-process (isolation degraded).`,
      );
    }
    const output = useSubprocessForTask
      ? await this.dispatchSubprocess(workerInput, routing)
      : await this.dispatchInProcess(workerInput, routing, _conversationHistory);

    return this.toWorkerResult(output, startTime);
  }

  async withSessionLimit<T>(level: number, fn: () => Promise<T>): Promise<T> {
    const sem = this.semaphores[level];
    if (!sem) return fn(); // L0 has no limit
    await sem.acquire();
    try {
      return await fn();
    } finally {
      sem.release();
    }
  }

  private buildWorkerInput(
    input: TaskInput,
    perception: PerceptualHierarchy,
    memory: WorkingMemoryState,
    plan: TaskDAG | undefined,
    routing: RoutingDecision,
    understanding?: import('../types.ts').TaskUnderstanding,
  ): WorkerInput {
    // EO #2: Prune context by role before building input
    const { perception: prunedPerception, memory: prunedMemory } = pruneForRole(
      perception, memory, 'generator', routing.level,
    );
    return {
      taskId: input.id,
      goal: input.goal,
      taskType: input.taskType,
      routingLevel: routing.level as Exclude<typeof routing.level, 0>,
      perception: prunedPerception,
      workingMemory: prunedMemory,
      ...(plan ? { plan } : {}),
      budget: {
        maxTokens: routing.budgetTokens,
        timeoutMs: routing.latencyBudgetMs,
      },
      allowedPaths: input.targetFiles?.map((f) => f.replace(/\/[^/]+$/, '/')) ?? ['src/'],
      isolationLevel: routingToIsolation(routing.level),
      ...(routing.workerId ? { workerId: routing.workerId } : {}),
      understanding: understanding ?? buildTaskUnderstanding(input),
    };
  }

  // ── In-process dispatch (default) ───────────────────────────────────

  private async dispatchInProcess(workerInput: WorkerInput, routing: RoutingDecision, conversationHistory?: import('../types.ts').ConversationEntry[]): Promise<WorkerOutput> {
    // PH4.4: Use workerId to select engine if available, fallback to tier-based
    const engine = routing.workerId
      ? (this.engineRegistry.selectById(routing.workerId) ?? this.engineRegistry.selectForRoutingLevel(routing.level))
      : this.engineRegistry.selectForRoutingLevel(routing.level);
    if (!engine) {
      return emptyOutput(workerInput.taskId);
    }

    const instructions = loadInstructionMemory(this.workspace);
    const { systemPrompt, userPrompt, systemCacheControl, instructionCacheControl } = assemblePrompt(
      workerInput.goal,
      workerInput.perception,
      workerInput.workingMemory,
      workerInput.plan,
      workerInput.taskType,
      instructions,
      workerInput.understanding, // Gap 9A: pass TaskUnderstanding for enriched prompt sections
      routing.level, // R2 (§5): gate tool descriptions out of L0-L1 prompts
      conversationHistory,
    );

    const startTime = performance.now();

    // Race: RE execute vs timeout
    const timeoutMs = workerInput.budget.timeoutMs;
    const timeoutPromise = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs));
    // Temperature: reasoning tasks use 0.3 for variance control, code tasks use 0.2 for precision
    const temperature = workerInput.taskType === 'reasoning' ? 0.3 : 0.2;
    let lastErrorMsg = '';
    const rePromise = engine
      .execute({
        systemPrompt,
        userPrompt,
        maxTokens: workerInput.budget.maxTokens,
        temperature,
        providerOptions: {
          ...(routing.thinkingConfig ? { thinking: routing.thinkingConfig } : {}),
          cacheControl: systemCacheControl ?? { type: 'ephemeral' as const },
          ...(instructionCacheControl ? { instructionCacheControl } : {}),
        },
      })
      .catch((err): 'error' => {
        // Rethrow PromptTooLargeError for caller-level recovery
        if (err instanceof PromptTooLargeError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        lastErrorMsg = msg;
        console.error(`[vinyan] In-process LLM call failed (${engine.id}): ${msg}`);
        return 'error';
      });

    const result = await Promise.race([rePromise, timeoutPromise]);
    if (result === 'timeout') {
      console.error(`[vinyan] In-process LLM call timed out (${engine.id}, ${timeoutMs}ms)`);
      return emptyOutput(workerInput.taskId);
    }
    if (result === 'error') {
      const output = emptyOutput(workerInput.taskId);
      if (isNonRetryableError(lastErrorMsg)) {
        output.nonRetryableError = lastErrorMsg;
      }
      return output;
    }

    const durationMs = Math.round(performance.now() - startTime);
    return parseWorkerOutputFromRE(workerInput.taskId, result as REResponse, durationMs);
  }

  // ── Subprocess dispatch (production path) ───────────────────────────

  private async dispatchSubprocess(workerInput: WorkerInput, routing: RoutingDecision): Promise<WorkerOutput> {
    // Lazily init warm pool on first L2+ dispatch
    const pool = this.ensureWarmPool();
    if (pool) {
      const warm = await pool.acquire();
      if (warm) {
        this.bus?.emit('warmpool:hit', { taskId: workerInput.taskId });
        return this.dispatchWarm(warm, workerInput, routing);
      }
      this.bus?.emit('warmpool:miss', { taskId: workerInput.taskId, reason: 'all_busy' });
    }

    // Cold spawn fallback
    return this.dispatchColdSubprocess(workerInput, routing);
  }

  private async dispatchWarm(worker: WarmWorker, workerInput: WorkerInput, routing: RoutingDecision): Promise<WorkerOutput> {
    const validated = WorkerInputSchema.parse(workerInput);

    try {
      worker.stdin.write(`${JSON.stringify(validated)}\n`);
    } catch {
      // stdin broken — worker died. Kill and fall back to cold spawn.
      this.warmPool!.kill(worker, 'stdin_error');
      return this.dispatchColdSubprocess(workerInput, routing);
    }

    const timeoutMs = routing.latencyBudgetMs;
    const linePromise = worker.reader.readLine();
    const timeoutPromise = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs));

    const line = await Promise.race([linePromise, timeoutPromise]);

    if (line === null) {
      // Timeout or worker died — kill and replace
      this.bus?.emit('warmpool:timeout', {
        taskId: workerInput.taskId,
        workerTaskCount: worker.taskCount,
        timeoutMs,
      });
      this.warmPool!.kill(worker, 'timeout');
      return emptyOutput(workerInput.taskId);
    }

    try {
      const raw = JSON.parse(line);
      const output = WorkerOutputSchema.parse(raw);
      // Success — release worker back to pool for reuse
      this.warmPool!.release(worker);
      return output;
    } catch {
      // Parse failure — track consecutive errors, kill after threshold
      worker.consecutiveErrors++;
      if (worker.consecutiveErrors >= WARM_WORKER_ERROR_THRESHOLD) {
        this.warmPool!.kill(worker, 'parse_error');
      } else {
        this.warmPool!.release(worker);
      }
      return emptyOutput(workerInput.taskId);
    }
  }

  private async dispatchColdSubprocess(workerInput: WorkerInput, routing: RoutingDecision): Promise<WorkerOutput> {
    const proc = Bun.spawn(['bun', 'run', this.workerEntryPath], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: buildWorkerEnv(routing, this.proxySocketPath),
    });

    const validated = WorkerInputSchema.parse(workerInput);
    proc.stdin.write(`${JSON.stringify(validated)}\n`);
    proc.stdin.end();

    const timeoutMs = routing.latencyBudgetMs;
    const timeoutPromise = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs));

    const processPromise = (async () => {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      return { stdout, stderr, exitCode };
    })();

    const result = await Promise.race([processPromise, timeoutPromise]);

    if (result === 'timeout') {
      proc.kill();
      return emptyOutput(workerInput.taskId);
    }

    if (result.exitCode !== 0) {
      if (result.stderr) {
        console.error(`[vinyan] Worker subprocess error: ${result.stderr.slice(0, 500)}`);
      }
      return emptyOutput(workerInput.taskId);
    }

    try {
      const raw = JSON.parse(result.stdout.trim());
      return WorkerOutputSchema.parse(raw);
    } catch {
      return emptyOutput(workerInput.taskId);
    }
  }

  // ── Container dispatch (L2/L3 — Docker isolation) ──────────────────

  private async dispatchContainer(workerInput: WorkerInput, routing: RoutingDecision): Promise<WorkerOutput> {
    const taskId = workerInput.taskId;

    // Create temp dirs for overlay and IPC
    const overlayDir = join(tmpdir(), `vinyan-overlay-${taskId}`);
    const ipcDir = join(tmpdir(), `vinyan-ipc-${taskId}`);
    mkdirSync(join(ipcDir, 'artifacts'), { recursive: true });
    mkdirSync(overlayDir, { recursive: true });

    // Write intent to IPC
    writeFileSync(join(ipcDir, 'intent.json'), JSON.stringify(workerInput));

    const containerImage = 'vinyan-sandbox:latest';
    const args = [
      'docker',
      'run',
      '--rm',
      '--user',
      '65532:65532',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--network=none',
      '--pids-limit=256',
      '--memory=1g',
      // PH4.4: Pass workerId to container so it can select the right provider
      ...(routing.workerId ? ['-e', `VINYAN_WORKER_ID=${routing.workerId}`] : []),
      '-v',
      `${this.workspace}:/workspace:ro`,
      '-v',
      `${overlayDir}:/overlay:rw`,
      '-v',
      `${ipcDir}:/ipc:rw`,
      containerImage,
    ];

    const timeoutMs = routing.latencyBudgetMs;
    try {
      const proc = Bun.spawn(args, {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const timeoutPromise = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs));
      const processPromise = (async () => {
        const exitCode = await proc.exited;
        return { exitCode };
      })();

      const result = await Promise.race([processPromise, timeoutPromise]);

      if (result === 'timeout') {
        proc.kill();
        return emptyOutput(taskId);
      }

      if (result.exitCode !== 0) {
        return emptyOutput(taskId);
      }

      // Read result from IPC
      const resultPath = join(ipcDir, 'result.json');
      if (!existsSync(resultPath)) {
        return emptyOutput(taskId);
      }

      const raw = JSON.parse(readFileSync(resultPath, 'utf-8'));
      const output = WorkerOutputSchema.parse(raw);

      // A6: Do NOT commit artifacts here — return them as proposed mutations.
      // The core-loop will commit only AFTER oracle verification passes.
      return output;
    } finally {
      // Cleanup temp dirs — zero-cost rollback
      try {
        rmSync(overlayDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(ipcDir, { recursive: true, force: true });
      } catch {}
    }
  }

  // ── Result conversion ───────────────────────────────────────────────

  private toWorkerResult(output: WorkerOutputWithCache, startTime: number) {
    const mutations = output.proposedMutations.map((m) => ({
      file: m.file,
      content: m.content,
      diff: this.computeDiff(m.file, m.content),
      explanation: m.explanation,
    }));

    return {
      mutations,
      proposedToolCalls: output.proposedToolCalls,
      tokensConsumed: output.tokensConsumed,
      cacheReadTokens: output.cacheReadTokens,
      cacheCreationTokens: output.cacheCreationTokens,
      thinkingTokensUsed: output.thinkingTokensUsed,
      thinking: output.thinking,
      durationMs: Math.round(performance.now() - startTime),
      proposedContent: output.proposedContent,
      nonRetryableError: output.nonRetryableError,
    };
  }

  private computeDiff(file: string, newContent: string): string {
    const absolutePath = resolve(this.workspace, file);
    try {
      const original = existsSync(absolutePath) ? readFileSync(absolutePath, 'utf-8') : '';
      return createUnifiedDiff(file, original, newContent);
    } catch {
      return createUnifiedDiff(file, '', newContent);
    }
  }

  /** Check if Docker is available on this system. Result is cached. */
  private checkDockerAvailable(): boolean {
    try {
      const result = Bun.spawnSync(['docker', 'info'], { stdout: 'pipe', stderr: 'pipe' });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  /** Set agent loop deps for Phase 6.3+ agentic dispatch. */
  setAgentLoopDeps(deps: AgentLoopDeps): void {
    this._agentLoopDeps = deps;
  }

  /** Returns agent loop deps if configured, null otherwise. */
  getAgentLoopDeps(): AgentLoopDeps | null {
    return this._agentLoopDeps;
  }

  /** Shutdown warm pool — kill all warm workers. Call before discarding the pool. */
  shutdown(): void {
    this.warmPool?.shutdown();
  }
}

// ── Environment ─────────────────────────────────────────────────────────

/** Minimal env allowlist for worker subprocesses — prevents leaking credentials. */
const WORKER_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TERM', 'BUN_INSTALL', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS'];

/** Known provider env var names — only the relevant key is forwarded. */
const PROVIDER_ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY',
  'OPENROUTER_FAST_MODEL', 'OPENROUTER_BALANCED_MODEL', 'OPENROUTER_POWERFUL_MODEL',
];

function buildWorkerEnv(routing: RoutingDecision, proxySocketPath?: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of WORKER_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (proxySocketPath) {
    // A6: proxy mode — worker uses socket to request LLM calls, no raw API keys
    env.VINYAN_LLM_PROXY_SOCKET = proxySocketPath;
  } else {
    // Legacy mode — forward API keys directly (backward compatible)
    for (const key of PROVIDER_ENV_KEYS) {
      if (process.env[key]) env[key] = process.env[key];
    }
  }
  if (routing.workerId) {
    env.VINYAN_WORKER_ID = routing.workerId;
  }
  return env;
}

// ── Helpers ─────────────────────────────────────────────────────────────

// ── EO #2: Epistemic Information Barriers ─────────────────────────────

/**
 * EO #2: Epistemic Information Barriers — prune context by role.
 * A1: Generator must not see detailed oracle verdict text (prevents self-evaluation loop).
 * Critic sees full perception but not prior attempts (avoids bias).
 */
export function pruneForRole(
  perception: PerceptualHierarchy,
  memory: WorkingMemoryState,
  role: PerceptionRole,
  routingLevel: number,
): { perception: PerceptualHierarchy; memory: WorkingMemoryState } {
  if (role === 'generator') {
    // Strip detailed oracleVerdict text — keep directional signals only
    const prunedMemory: WorkingMemoryState = {
      ...memory,
      failedApproaches: memory.failedApproaches.map(fa => ({
        ...fa,
        oracleVerdict: fa.failureOracle
          ? `Failed: ${fa.failureOracle} oracle`
          : 'Failed: verification',
      })),
    };

    // L0/L1: only direct dependencies (skip transitive, causal edges)
    if (routingLevel <= 1) {
      const prunedPerception: PerceptualHierarchy = {
        ...perception,
        dependencyCone: {
          ...perception.dependencyCone,
          transitiveImporters: undefined,
          affectedTestFiles: undefined,
        },
        diagnostics: {
          lintWarnings: [],
          typeErrors: perception.diagnostics.typeErrors,
          failingTests: [],
        },
        causalEdges: undefined,
      };
      return { perception: prunedPerception, memory: prunedMemory };
    }
    return { perception, memory: prunedMemory };
  }

  if (role === 'critic') {
    // Critic gets full perception but NO prior attempts (avoid bias from past failures)
    return {
      perception,
      memory: {
        ...memory,
        priorAttempts: undefined,
      },
    };
  }

  // 'testgen' — full access (needs to understand what to test)
  return { perception, memory };
}

function routingToIsolation(level: RoutingDecision['level']): IsolationLevel {
  if (level === 0) return 0;
  if (level === 1) return 1;
  return 2;
}

/** HTTP status codes that indicate permanent auth/config failures — retrying won't help. */
const NON_RETRYABLE_PATTERNS = [
  /\b40[13]\b/,          // 401 Unauthorized, 403 Forbidden
  /invalid.api.key/i,
  /user not found/i,
  /authentication/i,
  /permission denied/i,
];

function isNonRetryableError(msg: string): boolean {
  return NON_RETRYABLE_PATTERNS.some(p => p.test(msg));
}

function emptyOutput(taskId: string, tokens = 0): WorkerOutput {
  return {
    taskId,
    proposedMutations: [],
    proposedToolCalls: [],
    uncertainties: [],
    tokensConsumed: tokens,
    durationMs: 0,
  };
}

/** Strip markdown code block wrappers (```json ... ```) from LLM output. */
function stripCodeBlock(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  return match ? match[1]! : trimmed;
}

/** Parse WorkerOutput from a RE-agnostic REResponse (primary dispatch path). */
function parseWorkerOutputFromRE(taskId: string, response: REResponse, durationMs: number): WorkerOutputWithCache {
  const tokens = response.tokensUsed.input + response.tokensUsed.output;
  const cacheReadTokens = response.tokensUsed.cacheRead;
  const cacheCreationTokens = response.tokensUsed.cacheCreation;
  // Extensible Thinking: capture thinking token usage (explicit field or char-length proxy)
  const thinkingTokensUsed = response.tokensUsed.thinkingTokens
    ?? (response.thinking ? Math.ceil(response.thinking.length / 4) : undefined);
  try {
    const cleaned = stripCodeBlock(response.content);
    const parsed = JSON.parse(cleaned);
    const candidate = {
      taskId,
      proposedMutations: parsed.proposedMutations ?? [],
      proposedToolCalls: parsed.proposedToolCalls ?? response.toolCalls ?? [],
      uncertainties: parsed.uncertainties ?? [],
      tokensConsumed: tokens,
      durationMs,
    };
    const validated = WorkerOutputSchema.safeParse(candidate);
    if (validated.success) return { ...validated.data, cacheReadTokens, cacheCreationTokens, thinkingTokensUsed, thinking: response.thinking };
    return { ...emptyOutput(taskId, tokens), proposedContent: response.content, cacheReadTokens, cacheCreationTokens, thinkingTokensUsed, thinking: response.thinking };
  } catch {
    if (response.content?.trim()) {
      return { ...emptyOutput(taskId, tokens), proposedContent: response.content, cacheReadTokens, cacheCreationTokens, thinkingTokensUsed, thinking: response.thinking };
    }
    return { ...emptyOutput(taskId, tokens), cacheReadTokens, cacheCreationTokens, thinkingTokensUsed, thinking: response.thinking };
  }
}

/** Minimal unified diff — full file replacement. */
export function createUnifiedDiff(file: string, original: string, modified: string): string {
  if (original === modified) return '';

  const origLines = original ? original.split('\n') : [];
  const modLines = modified ? modified.split('\n') : [];

  const lines: string[] = [`--- a/${file}`, `+++ b/${file}`];

  if (original === '') {
    lines.push(`@@ -0,0 +1,${modLines.length} @@`);
    for (const l of modLines) lines.push(`+${l}`);
  } else if (modified === '') {
    lines.push(`@@ -1,${origLines.length} +0,0 @@`);
    for (const l of origLines) lines.push(`-${l}`);
  } else {
    lines.push(`@@ -1,${origLines.length} +1,${modLines.length} @@`);
    for (const l of origLines) lines.push(`-${l}`);
    for (const l of modLines) lines.push(`+${l}`);
  }

  return lines.join('\n');
}
