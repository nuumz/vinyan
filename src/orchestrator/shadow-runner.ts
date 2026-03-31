/**
 * Shadow Runner — async post-commit validation for L2+ tasks.
 *
 * Online path returns fast with structural oracle verification only.
 * Shadow runner picks up pending jobs and runs full test suite in background.
 *
 * Crash-safety invariant (A6): ShadowJob is INSERT'd BEFORE online TaskResult returns.
 * On failure: flag for human review — do NOT auto-revert.
 *
 * Source of truth: vinyan-tdd.md §12B (Shadow Execution), Phase 2.2
 */
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { resolve, dirname, join } from "path";
import { tmpdir } from "os";
import type { ShadowJob, ShadowValidationResult } from "./types.ts";
import type { ShadowStore, ShadowJobWithMutations } from "../db/shadow-store.ts";

export interface ShadowRunnerConfig {
  shadowStore: ShadowStore;
  workspace: string;
  /** Test command to run in container (default: "bun test") */
  testCommand?: string;
  /** Timeout for shadow validation in ms (default: 300_000 = 5 min) */
  timeoutMs?: number;
}

export class ShadowRunner {
  private store: ShadowStore;
  private workspace: string;
  private testCommand: string;
  private timeoutMs: number;

  constructor(config: ShadowRunnerConfig) {
    this.store = config.shadowStore;
    this.workspace = config.workspace;
    this.testCommand = config.testCommand ?? "bun test";
    this.timeoutMs = config.timeoutMs ?? 300_000;
  }

  /**
   * Enqueue a shadow job BEFORE returning online response.
   * This is the crash-safety invariant (A6) — the job is persisted
   * so it can be recovered on restart.
   */
  enqueue(
    taskId: string,
    mutations: Array<{ file: string; content: string }>,
  ): ShadowJob & { mutations: Array<{ file: string; content: string }> } {
    const job = {
      id: `shadow-${taskId}-${Date.now()}`,
      taskId,
      status: "pending" as const,
      enqueuedAt: Date.now(),
      retryCount: 0,
      maxRetries: 1,
      mutations,
    };
    this.store.insert(job);
    return job;
  }

  /**
   * Process the next pending shadow job.
   * Returns the validation result, or null if no pending jobs.
   */
  async processNext(): Promise<ShadowValidationResult | null> {
    const pending = this.store.findPending();
    if (pending.length === 0) return null;

    const job = pending[0]!;
    this.store.updateStatus(job.id, "running");

    try {
      const result = await this.runValidation(job);
      this.store.updateStatus(job.id, "done", result);
      return result;
    } catch (err) {
      if (job.retryCount < job.maxRetries) {
        this.store.incrementRetry(job.id);
        this.store.updateStatus(job.id, "pending");
      } else {
        const failResult: ShadowValidationResult = {
          taskId: job.taskId,
          testsPassed: false,
          duration_ms: 0,
          timestamp: Date.now(),
        };
        this.store.updateStatus(job.id, "failed", failResult);
      }
      return null;
    }
  }

  /**
   * Recover pending/running jobs after restart.
   * Resets 'running' jobs back to 'pending' so they can be re-processed.
   * Returns number of recovered jobs.
   */
  recover(): number {
    const stale = this.store.findByStatus("running");
    for (const job of stale) {
      this.store.updateStatus(job.id, "pending");
    }
    return stale.length;
  }

  /**
   * Run the actual validation — test suite execution in a sandbox.
   * Copies workspace to a temp directory, applies proposed mutations,
   * then runs the test suite against the mutated state.
   */
  private async runValidation(
    job: ShadowJobWithMutations,
  ): Promise<ShadowValidationResult> {
    const startTime = performance.now();

    // Create isolated sandbox with mutations applied
    const sandboxDir = await this.createSandbox(job.mutations ?? []);

    try {
      const proc = Bun.spawn(["sh", "-c", this.testCommand], {
        cwd: sandboxDir,
        stdout: "pipe",
        stderr: "pipe",
      });

      const timeoutPromise = new Promise<"timeout">(r =>
        setTimeout(() => r("timeout"), this.timeoutMs),
      );

      const processPromise = (async () => {
        const stdout = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;
        return { stdout, exitCode };
      })();

      const raceResult = await Promise.race([processPromise, timeoutPromise]);
      const duration_ms = Math.round(performance.now() - startTime);

      if (raceResult === "timeout") {
        proc.kill();
        return {
          taskId: job.taskId,
          testsPassed: false,
          duration_ms,
          timestamp: Date.now(),
        };
      }

      const testsPassed = raceResult.exitCode === 0;
      const testResults = parseTestOutput(raceResult.stdout);

      return {
        taskId: job.taskId,
        testsPassed,
        testResults,
        duration_ms,
        timestamp: Date.now(),
      };
    } finally {
      // Clean up sandbox
      try { rmSync(sandboxDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
  }

  /**
   * Create an isolated workspace copy with proposed mutations applied.
   * Uses cp -r for simplicity; Phase 3 can use overlay FS or Docker.
   */
  private async createSandbox(
    mutations: Array<{ file: string; content: string }>,
  ): Promise<string> {
    const sandboxDir = join(tmpdir(), `vinyan-shadow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

    // Copy workspace to sandbox
    const cp = Bun.spawn(["cp", "-r", this.workspace, sandboxDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await cp.exited;

    // Apply proposed mutations over the copy
    for (const m of mutations) {
      const targetPath = resolve(sandboxDir, m.file);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, m.content);
    }

    return sandboxDir;
  }
}

/**
 * Best-effort parse of bun test output for test counts.
 * Looks for patterns like "N pass" and "N fail".
 */
function parseTestOutput(
  stdout: string,
): { total: number; passed: number; failed: number; skipped: number } | undefined {
  const passMatch = stdout.match(/(\d+)\s+pass/);
  const failMatch = stdout.match(/(\d+)\s+fail/);

  if (!passMatch && !failMatch) return undefined;

  const passed = passMatch ? parseInt(passMatch[1]!, 10) : 0;
  const failed = failMatch ? parseInt(failMatch[1]!, 10) : 0;

  return {
    total: passed + failed,
    passed,
    failed,
    skipped: 0,
  };
}
