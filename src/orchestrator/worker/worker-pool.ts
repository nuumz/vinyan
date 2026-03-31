/**
 * Worker Pool — dispatches tasks to LLM via in-process call or subprocess.
 *
 * L0: No LLM — returns empty result immediately.
 * L1+: Selects provider from registry, assembles prompt, calls LLM.
 * Subprocess mode follows oracle/runner.ts pattern (Bun.spawn + timeout + Zod validation).
 *
 * Source of truth: vinyan-tdd.md §16.3 (Worker lifecycle), §17 (Generator Engine)
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { commitArtifacts } from "./artifact-commit.ts";
import type {
  TaskInput,
  PerceptualHierarchy,
  WorkingMemoryState,
  TaskDAG,
  RoutingDecision,
  WorkerInput,
  WorkerOutput,
  IsolationLevel,
  LLMResponse,
} from "../types.ts";
import type { WorkerPool } from "../core-loop.ts";
import { WorkerInputSchema, WorkerOutputSchema } from "../protocol.ts";
import type { LLMProviderRegistry } from "../llm/provider-registry.ts";
import { assemblePrompt } from "../llm/prompt-assembler.ts";

export interface WorkerPoolConfig {
  registry: LLMProviderRegistry;
  workspace: string;
  /** Use subprocess for L1+ dispatch (default: false — in-process). */
  useSubprocess?: boolean;
  /** Override worker entry script path. */
  workerEntryPath?: string;
}

export class WorkerPoolImpl implements WorkerPool {
  private registry: LLMProviderRegistry;
  private workspace: string;
  private useSubprocess: boolean;
  private workerEntryPath: string;

  constructor(config: WorkerPoolConfig) {
    this.registry = config.registry;
    this.workspace = config.workspace;
    this.useSubprocess = config.useSubprocess ?? false;
    this.workerEntryPath =
      config.workerEntryPath ?? resolve(import.meta.dir, "worker-entry.ts");
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
        proposedToolCalls: [] as import("../types.ts").ToolCall[],
        tokensConsumed: 0,
        duration_ms: Math.round(performance.now() - startTime),
      };
    }

    const workerInput = this.buildWorkerInput(input, perception, memory, plan, routing);

    // L2/L3: container dispatch when isolation level = 2
    if (workerInput.isolationLevel === 2) {
      const output = await this.dispatchContainer(workerInput, routing);
      return this.toWorkerResult(output, startTime);
    }

    const output = this.useSubprocess
      ? await this.dispatchSubprocess(workerInput, routing)
      : await this.dispatchInProcess(workerInput, routing);

    return this.toWorkerResult(output, startTime);
  }

  private buildWorkerInput(
    input: TaskInput,
    perception: PerceptualHierarchy,
    memory: WorkingMemoryState,
    plan: TaskDAG | undefined,
    routing: RoutingDecision,
  ): WorkerInput {
    return {
      taskId: input.id,
      goal: input.goal,
      routingLevel: routing.level as Exclude<typeof routing.level, 0>,
      perception,
      workingMemory: memory,
      ...(plan ? { plan } : {}),
      budget: {
        maxTokens: routing.budgetTokens,
        timeoutMs: routing.latencyBudget_ms,
      },
      allowedPaths: input.targetFiles?.map(f => f.replace(/\/[^/]+$/, "/")) ?? ["src/"],
      isolationLevel: routingToIsolation(routing.level),
    };
  }

  // ── In-process dispatch (default) ───────────────────────────────────

  private async dispatchInProcess(
    workerInput: WorkerInput,
    routing: RoutingDecision,
  ): Promise<WorkerOutput> {
    const provider = this.registry.selectForRoutingLevel(routing.level);
    if (!provider) {
      return emptyOutput(workerInput.taskId);
    }

    const { systemPrompt, userPrompt } = assemblePrompt(
      workerInput.goal,
      workerInput.perception,
      workerInput.workingMemory,
      workerInput.plan,
    );

    const startTime = performance.now();

    // Race: LLM call vs timeout
    const timeoutMs = workerInput.budget.timeoutMs;
    const timeoutPromise = new Promise<"timeout">(r => setTimeout(() => r("timeout"), timeoutMs));
    const llmPromise = provider.generate({
      systemPrompt,
      userPrompt,
      maxTokens: workerInput.budget.maxTokens,
    }).catch((): "error" => "error");

    const result = await Promise.race([llmPromise, timeoutPromise]);
    if (result === "timeout" || result === "error") {
      return emptyOutput(workerInput.taskId);
    }

    const duration_ms = Math.round(performance.now() - startTime);
    return parseWorkerOutput(workerInput.taskId, result as LLMResponse, duration_ms);
  }

  // ── Subprocess dispatch (production path) ───────────────────────────

  private async dispatchSubprocess(
    workerInput: WorkerInput,
    routing: RoutingDecision,
  ): Promise<WorkerOutput> {
    const proc = Bun.spawn(["bun", "run", this.workerEntryPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const validated = WorkerInputSchema.parse(workerInput);
    proc.stdin.write(JSON.stringify(validated) + "\n");
    proc.stdin.end();

    const timeoutMs = routing.latencyBudget_ms;
    const timeoutPromise = new Promise<"timeout">(r => setTimeout(() => r("timeout"), timeoutMs));

    const processPromise = (async () => {
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      return { stdout, exitCode };
    })();

    const result = await Promise.race([processPromise, timeoutPromise]);

    if (result === "timeout") {
      proc.kill();
      return emptyOutput(workerInput.taskId);
    }

    if (result.exitCode !== 0) {
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

  private async dispatchContainer(
    workerInput: WorkerInput,
    routing: RoutingDecision,
  ): Promise<WorkerOutput> {
    const taskId = workerInput.taskId;

    // Create temp dirs for overlay and IPC
    const overlayDir = join(tmpdir(), `vinyan-overlay-${taskId}`);
    const ipcDir = join(tmpdir(), `vinyan-ipc-${taskId}`);
    mkdirSync(join(ipcDir, "artifacts"), { recursive: true });
    mkdirSync(overlayDir, { recursive: true });

    // Write intent to IPC
    writeFileSync(join(ipcDir, "intent.json"), JSON.stringify(workerInput));

    const containerImage = "vinyan-sandbox:latest";
    const args = [
      "docker", "run", "--rm",
      "--user", "1000:1000",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--network=none",
      "--pids-limit=256",
      "--memory=1g",
      "-v", `${this.workspace}:/workspace:ro`,
      "-v", `${overlayDir}:/overlay:rw`,
      "-v", `${ipcDir}:/ipc:rw`,
      containerImage,
    ];

    const timeoutMs = routing.latencyBudget_ms;
    let containerId: string | undefined;

    try {
      const proc = Bun.spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
      });

      const timeoutPromise = new Promise<"timeout">(r => setTimeout(() => r("timeout"), timeoutMs));
      const processPromise = (async () => {
        const exitCode = await proc.exited;
        return { exitCode };
      })();

      const result = await Promise.race([processPromise, timeoutPromise]);

      if (result === "timeout") {
        proc.kill();
        return emptyOutput(taskId);
      }

      if (result.exitCode !== 0) {
        return emptyOutput(taskId);
      }

      // Read result from IPC
      const resultPath = join(ipcDir, "result.json");
      if (!existsSync(resultPath)) {
        return emptyOutput(taskId);
      }

      const raw = JSON.parse(readFileSync(resultPath, "utf-8"));
      const output = WorkerOutputSchema.parse(raw);

      // Apply artifacts to workspace using Artifact Commit Protocol
      if (output.proposedMutations.length > 0) {
        const artifacts = output.proposedMutations.map(m => ({
          path: m.file,
          content: m.content,
        }));
        const commitResult = commitArtifacts(this.workspace, artifacts);
        // Filter out rejected mutations
        output.proposedMutations = output.proposedMutations.filter(m =>
          commitResult.applied.includes(m.file),
        );
      }

      return output;
    } finally {
      // Cleanup temp dirs — zero-cost rollback
      try { rmSync(overlayDir, { recursive: true, force: true }); } catch {}
      try { rmSync(ipcDir, { recursive: true, force: true }); } catch {}
    }
  }

  // ── Result conversion ───────────────────────────────────────────────

  private toWorkerResult(output: WorkerOutput, startTime: number) {
    const mutations = output.proposedMutations.map(m => ({
      file: m.file,
      content: m.content,
      diff: this.computeDiff(m.file, m.content),
      explanation: m.explanation,
    }));

    return {
      mutations,
      proposedToolCalls: output.proposedToolCalls,
      tokensConsumed: output.tokensConsumed,
      duration_ms: Math.round(performance.now() - startTime),
    };
  }

  private computeDiff(file: string, newContent: string): string {
    const absolutePath = resolve(this.workspace, file);
    try {
      const original = existsSync(absolutePath)
        ? readFileSync(absolutePath, "utf-8")
        : "";
      return createUnifiedDiff(file, original, newContent);
    } catch {
      return createUnifiedDiff(file, "", newContent);
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function routingToIsolation(level: RoutingDecision["level"]): IsolationLevel {
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
    duration_ms: 0,
  };
}

/** Strip markdown code block wrappers (```json ... ```) from LLM output. */
function stripCodeBlock(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  return match ? match[1]! : trimmed;
}

function parseWorkerOutput(
  taskId: string,
  response: LLMResponse,
  duration_ms: number,
): WorkerOutput {
  const tokens = response.tokensUsed.input + response.tokensUsed.output;
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
      duration_ms,
    };
    const validated = WorkerOutputSchema.safeParse(candidate);
    if (validated.success) return validated.data;
    return emptyOutput(taskId, tokens);
  } catch {
    return emptyOutput(taskId, tokens);
  }
}

/** Minimal unified diff — full file replacement. */
export function createUnifiedDiff(file: string, original: string, modified: string): string {
  if (original === modified) return "";

  const origLines = original ? original.split("\n") : [];
  const modLines = modified ? modified.split("\n") : [];

  const lines: string[] = [`--- a/${file}`, `+++ b/${file}`];

  if (original === "") {
    lines.push(`@@ -0,0 +1,${modLines.length} @@`);
    for (const l of modLines) lines.push(`+${l}`);
  } else if (modified === "") {
    lines.push(`@@ -1,${origLines.length} +0,0 @@`);
    for (const l of origLines) lines.push(`-${l}`);
  } else {
    lines.push(`@@ -1,${origLines.length} +1,${modLines.length} @@`);
    for (const l of origLines) lines.push(`-${l}`);
    for (const l of modLines) lines.push(`+${l}`);
  }

  return lines.join("\n");
}
