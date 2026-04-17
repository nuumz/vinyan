/**
 * Sandbox Manager — L3 container isolation for speculative-tier workers.
 *
 * Manages Docker container lifecycle for isolated task execution.
 * Security: non-root user, drop all capabilities, no network, PID/memory limits.
 *
 * A6: Zero-trust execution — workers propose, Orchestrator disposes.
 * I17: Speculative-tier workers require L2+ isolation (full enforcement).
 *
 * Source of truth: spec/tdd.md §11, docker/vinyan-sandbox.Dockerfile
 */

import type { VinyanBus } from '../../core/bus.ts';

// ── Types ───────────────────────────────────────────────────────

export interface SandboxConfig {
  /** Docker image to use (default: vinyan-sandbox:latest). */
  image?: string;
  /** Timeout for container execution in ms (default: 120_000). */
  timeoutMs?: number;
  /** Memory limit (default: '512m'). */
  memoryLimit?: string;
  /** PID limit (default: 100). */
  pidsLimit?: number;
  /** Workspace path to bind mount read-only. */
  workspacePath: string;
  /** Event bus for sandbox lifecycle events. */
  bus?: VinyanBus;
  /** Custom spawn function for testing (default: Bun.spawn). */
  spawnFn?: typeof Bun.spawn;
}

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

interface RunningContainer {
  containerId: string;
  taskId: string;
  startedAt: number;
  timeoutMs: number;
}

const DEFAULT_IMAGE = 'vinyan-sandbox:latest';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MEMORY_LIMIT = '512m';
const DEFAULT_PIDS_LIMIT = 100;

export class SandboxManager {
  private config: SandboxConfig;
  private running = new Map<string, RunningContainer>();
  private image: string;
  private timeoutMs: number;
  private memoryLimit: string;
  private pidsLimit: number;
  private spawnFn: typeof Bun.spawn;

  constructor(config: SandboxConfig) {
    this.config = config;
    this.image = config.image ?? DEFAULT_IMAGE;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.memoryLimit = config.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
    this.pidsLimit = config.pidsLimit ?? DEFAULT_PIDS_LIMIT;
    this.spawnFn = config.spawnFn ?? Bun.spawn;
  }

  /**
   * Execute a task in an isolated sandbox container.
   * Container security:
   *   - Non-root user (uid 1000)
   *   - Drop ALL capabilities
   *   - No new privileges
   *   - No network access
   *   - PID and memory limits
   *   - Read-only workspace mount
   */
  async execute(taskId: string, command: string[]): Promise<SandboxResult> {
    const containerId = `vinyan-sandbox-${taskId}-${Date.now()}`;
    const startedAt = Date.now();

    this.running.set(containerId, {
      containerId,
      taskId,
      startedAt,
      timeoutMs: this.timeoutMs,
    });

    this.config.bus?.emit('sandbox:created', { containerId, taskId });

    const args = [
      'docker',
      'run',
      '--rm',
      '--name',
      containerId,
      '--user',
      '1000:1000',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--network',
      'none',
      '--memory',
      this.memoryLimit,
      '--pids-limit',
      String(this.pidsLimit),
      '-v',
      `${this.config.workspacePath}:/workspace:ro`,
      '--tmpfs',
      '/overlay:rw,noexec,nosuid,size=100m',
      '--tmpfs',
      '/ipc:rw,noexec,nosuid,size=10m',
      this.image,
      ...command,
    ];

    try {
      const proc = this.spawnFn(args, {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      // Timeout enforcement
      const timeoutPromise = new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), this.timeoutMs);
      });

      const exitPromise = proc.exited.then((code) => ({ code }));
      const race = await Promise.race([exitPromise, timeoutPromise]);

      if (race === 'timeout') {
        await this.forceStop(containerId);
        const durationMs = Date.now() - startedAt;
        this.running.delete(containerId);

        this.config.bus?.emit('sandbox:timeout', {
          containerId,
          taskId,
          timeoutMs: this.timeoutMs,
        });

        return {
          exitCode: -1,
          stdout: '',
          stderr: `Container timed out after ${this.timeoutMs}ms`,
          durationMs,
          timedOut: true,
        };
      }

      const exitCode = (race as { code: number }).code;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const durationMs = Date.now() - startedAt;

      this.running.delete(containerId);

      this.config.bus?.emit('sandbox:completed', {
        containerId,
        taskId,
        exitCode,
        durationMs,
      });

      return { exitCode, stdout, stderr, durationMs, timedOut: false };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      this.running.delete(containerId);

      const errorMsg = error instanceof Error ? error.message : String(error);
      this.config.bus?.emit('sandbox:error', {
        containerId,
        taskId,
        error: errorMsg,
      });

      return {
        exitCode: -1,
        stdout: '',
        stderr: errorMsg,
        durationMs,
        timedOut: false,
      };
    }
  }

  /** Force stop a running container. */
  async forceStop(containerId: string): Promise<void> {
    try {
      const proc = this.spawnFn(['docker', 'kill', containerId], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await proc.exited;
    } catch {
      // Best effort — container may already be stopped
    }
    this.running.delete(containerId);
  }

  /** Get all currently running containers. */
  getRunning(): RunningContainer[] {
    return Array.from(this.running.values());
  }

  /** Check if any containers are running. */
  isRunning(): boolean {
    return this.running.size > 0;
  }

  /** Stop all running containers. */
  async stopAll(): Promise<void> {
    const promises = Array.from(this.running.keys()).map((id) => this.forceStop(id));
    await Promise.all(promises);
  }
}
