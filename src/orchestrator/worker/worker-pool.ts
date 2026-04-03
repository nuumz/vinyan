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
import type { WorkerPool } from '../core-loop.ts';
import type { AgentLoopDeps } from './agent-loop.ts';
import { assemblePrompt } from '../llm/prompt-assembler.ts';
import { LLMReasoningEngine, ReasoningEngineRegistry } from '../llm/llm-reasoning-engine.ts';
import type { LLMProviderRegistry } from '../llm/provider-registry.ts';
import { WorkerInputSchema, WorkerOutputSchema } from '../protocol.ts';
import type {
  IsolationLevel,
  LLMResponse,
  PerceptualHierarchy,
  PerceptionRole,
  REResponse,
  RoutingDecision,
  TaskDAG,
  TaskInput,
  WorkerInput,
  WorkerOutput,
  WorkingMemoryState,
} from '../types.ts';

/** WorkerOutput extended with cache token metrics from LLM response (in-process path only). */
type WorkerOutputWithCache = WorkerOutput & {
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
};

export interface WorkerPoolConfig {
  registry: LLMProviderRegistry;
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

  constructor(config: WorkerPoolConfig) {
    this.registry = config.registry;
    // Build RE registry: use provided one or wrap legacy LLM registry for backward compat
    this.engineRegistry = config.engineRegistry ?? ReasoningEngineRegistry.fromLLMRegistry(config.registry);
    this.workspace = config.workspace;
    this.useSubprocess = config.useSubprocess ?? true;
    this.proxySocketPath = config.proxySocketPath;
    if (!this.useSubprocess) {
      console.warn('[vinyan] WARNING: In-process worker mode is not A6-compliant. Use for testing only.');
    }
    this.workerEntryPath = config.workerEntryPath ?? resolve(import.meta.dir, 'worker-entry.ts');
    this.semaphores = {
      1: new Semaphore(config.maxConcurrentSessions?.l1 ?? 5),
      2: new Semaphore(config.maxConcurrentSessions?.l2 ?? 3),
      3: new Semaphore(config.maxConcurrentSessions?.l3 ?? 1),
    };
  }

  async dispatch(
    input: TaskInput,
    perception: PerceptualHierarchy,
    memory: WorkingMemoryState,
    plan: TaskDAG | undefined,
    routing: RoutingDecision,
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

    const workerInput = this.buildWorkerInput(input, perception, memory, plan, routing);

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
    // L2+ subprocess: isolation for file-mutating tasks
    const output = (this.useSubprocess && routing.level >= 2)
      ? await this.dispatchSubprocess(workerInput, routing)
      : await this.dispatchInProcess(workerInput, routing);

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
    };
  }

  // ── In-process dispatch (default) ───────────────────────────────────

  private async dispatchInProcess(workerInput: WorkerInput, routing: RoutingDecision): Promise<WorkerOutput> {
    // PH4.4: Use workerId to select engine if available, fallback to tier-based
    const engine = routing.workerId
      ? (this.engineRegistry.selectById(routing.workerId) ?? this.engineRegistry.selectForRoutingLevel(routing.level))
      : this.engineRegistry.selectForRoutingLevel(routing.level);
    if (!engine) {
      return emptyOutput(workerInput.taskId);
    }

    const { systemPrompt, userPrompt } = assemblePrompt(
      workerInput.goal,
      workerInput.perception,
      workerInput.workingMemory,
      workerInput.plan,
      workerInput.taskType,
    );

    const startTime = performance.now();

    // Race: RE execute vs timeout
    const timeoutMs = workerInput.budget.timeoutMs;
    const timeoutPromise = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs));
    const rePromise = engine
      .execute({
        systemPrompt,
        userPrompt,
        maxTokens: workerInput.budget.maxTokens,
        providerOptions: {
          ...(routing.thinkingConfig ? { thinking: routing.thinkingConfig } : {}),
          cacheControl: { type: 'ephemeral' as const },
        },
      })
      .catch((): 'error' => 'error');

    const result = await Promise.race([rePromise, timeoutPromise]);
    if (result === 'timeout' || result === 'error') {
      return emptyOutput(workerInput.taskId);
    }

    const durationMs = Math.round(performance.now() - startTime);
    return parseWorkerOutputFromRE(workerInput.taskId, result as REResponse, durationMs);
  }

  // ── Subprocess dispatch (production path) ───────────────────────────

  private async dispatchSubprocess(workerInput: WorkerInput, routing: RoutingDecision): Promise<WorkerOutput> {
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
      durationMs: Math.round(performance.now() - startTime),
      proposedContent: output.proposedContent,
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
    if (validated.success) return { ...validated.data, cacheReadTokens, cacheCreationTokens };
    return { ...emptyOutput(taskId, tokens), proposedContent: response.content, cacheReadTokens, cacheCreationTokens };
  } catch {
    if (response.content?.trim()) {
      return { ...emptyOutput(taskId, tokens), proposedContent: response.content, cacheReadTokens, cacheCreationTokens };
    }
    return { ...emptyOutput(taskId, tokens), cacheReadTokens, cacheCreationTokens };
  }
}

function parseWorkerOutput(taskId: string, response: LLMResponse, durationMs: number): WorkerOutputWithCache {
  const tokens = response.tokensUsed.input + response.tokensUsed.output;
  const cacheReadTokens = response.tokensUsed.cacheRead;
  const cacheCreationTokens = response.tokensUsed.cacheCreation;
  try {
    const cleaned = stripCodeBlock(response.content);
    const parsed = JSON.parse(cleaned);
    // Validate through Zod schema (prevents malformed field types from reaching pipeline)
    const candidate = {
      taskId,
      proposedMutations: parsed.proposedMutations ?? [],
      proposedToolCalls: parsed.proposedToolCalls ?? response.toolCalls ?? [],
      uncertainties: parsed.uncertainties ?? [],
      tokensConsumed: tokens,
      durationMs,
    };
    const validated = WorkerOutputSchema.safeParse(candidate);
    if (validated.success) return { ...validated.data, cacheReadTokens, cacheCreationTokens };
    // Non-JSON response (e.g. conversational answer) — return as proposedContent
    return { ...emptyOutput(taskId, tokens), proposedContent: response.content, cacheReadTokens, cacheCreationTokens };
  } catch {
    // Non-JSON response (e.g. conversational answer) — return as proposedContent
    if (response.content?.trim()) {
      return { ...emptyOutput(taskId, tokens), proposedContent: response.content, cacheReadTokens, cacheCreationTokens };
    }
    return { ...emptyOutput(taskId, tokens), cacheReadTokens, cacheCreationTokens };
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
