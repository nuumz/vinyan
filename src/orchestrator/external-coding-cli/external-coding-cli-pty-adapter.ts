/**
 * Process adapter — pipe-based subprocess wrapper.
 *
 * **No PTY. By design.** Bun is native-dep-free and the only providers we
 * ship can be driven without a TTY:
 *
 *   - Claude Code: `--print --input-format=stream-json --output-format=stream-json`
 *     is the canonical machine driver — `isatty()` is irrelevant on this
 *     path, and the JSON protocol is more reliable than scraping ANSI.
 *   - GitHub Copilot: `gh copilot -p "prompt"` is headless by design.
 *
 * **Falsifiable trigger to revisit:** if we ever add a provider whose
 * `interactive: true` capability cannot be served by a stream-json-style
 * protocol (i.e. `streamProtocol: false`), the controller's routing must
 * REJECT it rather than fall through to this pipe wrapper. The check
 * lives at {@link ExternalCodingCliController.pickProvider} and
 * {@link ExternalCodingCliController.createSession}. We do not paper over
 * the gap with a fake PTY; pretending a TTY-only CLI works over pipes
 * leads to silent stalls (CLIs that block on `isatty(stdin)` checks).
 *
 * If that day ever comes, the upgrade is a NEW process backend
 * (`PtyProcess` next to `PipeProcess`), gated by a config flag, not a
 * monkey-patch of this file. The existing tests + state machine + bridges
 * stay untouched.
 *
 * Stylistic note: `FORCE_COLOR`/`NO_COLOR` are forwarded by the adapters'
 * env allowlists so users who DO want colored output through pipes can
 * opt in without the controller setting it as a default.
 */
import type { Subprocess } from 'bun';
import { spawn } from 'bun';

export interface PipeProcessOptions {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Idle deadline before stalled detection. Default 2 minutes. */
  idleTimeoutMs?: number;
  /** Hard wall-clock deadline. Default 15 minutes. */
  timeoutMs?: number;
  /** Cap on captured output. Default 4 MiB per stream. */
  maxOutputBytes?: number;
}

export interface PipeProcessEvents {
  onStdout?(text: string): void;
  onStderr?(text: string): void;
  onExit?(exitCode: number | null, signal: NodeJS.Signals | null): void;
  onStalled?(idleMs: number): void;
  onTimeout?(): void;
}

export type PipeProcessLifecycle =
  | 'pending'
  | 'running'
  | 'exited'
  | 'killed'
  | 'stalled'
  | 'timed-out';

export class PipeProcess {
  private subprocess: Subprocess | null = null;
  private lifecycle: PipeProcessLifecycle = 'pending';
  private capturedStdout = '';
  private capturedStderr = '';
  private capturedBytes = 0;
  private readonly maxOutputBytes: number;
  private readonly idleTimeoutMs: number;
  private readonly timeoutMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private wallTimer: ReturnType<typeof setTimeout> | null = null;
  private exitDeferred: { promise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; resolve: (v: { code: number | null; signal: NodeJS.Signals | null }) => void };
  private stdinClosed = false;

  constructor(
    private readonly opts: PipeProcessOptions,
    private readonly events: PipeProcessEvents = {},
  ) {
    this.maxOutputBytes = opts.maxOutputBytes ?? 4 * 1024 * 1024;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 2 * 60 * 1000;
    this.timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000;
    let resolveFn: (v: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
    const promise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => {
      resolveFn = r;
    });
    this.exitDeferred = { promise, resolve: resolveFn };
  }

  /** Start the process. Throws synchronously if Bun.spawn fails. */
  start(): void {
    if (this.subprocess) throw new Error('PipeProcess already started');
    this.subprocess = spawn({
      cmd: [this.opts.bin, ...this.opts.args],
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      onExit: (_proc, exitCode, signalCode) =>
        this.handleExit(exitCode, signalCode === null ? null : (typeof signalCode === 'number' ? null : (signalCode as NodeJS.Signals))),
    });
    this.lifecycle = 'running';
    this.startReaders();
    this.armIdleTimer();
    this.armWallTimer();
  }

  pid(): number | null {
    return this.subprocess?.pid ?? null;
  }

  state(): PipeProcessLifecycle {
    return this.lifecycle;
  }

  stdout(): string {
    return this.capturedStdout;
  }

  stderr(): string {
    return this.capturedStderr;
  }

  /** Send bytes to stdin. Returns false when the process has exited. */
  async write(bytes: string): Promise<boolean> {
    if (!this.subprocess || this.lifecycle !== 'running') return false;
    if (this.stdinClosed) return false;
    const stdin = this.subprocess.stdin as { write?: (data: string) => unknown; flush?: () => Promise<void> } | undefined;
    if (!stdin || typeof stdin.write !== 'function') return false;
    try {
      stdin.write(bytes);
      if (typeof stdin.flush === 'function') await stdin.flush();
      this.armIdleTimer();
      return true;
    } catch {
      return false;
    }
  }

  closeStdin(): void {
    if (!this.subprocess || this.stdinClosed) return;
    this.stdinClosed = true;
    const stdin = this.subprocess.stdin as { end?: () => unknown } | undefined;
    try {
      stdin?.end?.();
    } catch {
      // Best-effort.
    }
  }

  /** Send a kill signal. Default SIGTERM. */
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (!this.subprocess) return false;
    try {
      this.subprocess.kill(signal);
      this.lifecycle = 'killed';
      return true;
    } catch {
      return false;
    }
  }

  /** Resolves when the process exits. Idempotent. */
  async wait(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (!this.subprocess) {
      return { code: null, signal: null };
    }
    return this.exitDeferred.promise;
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private async startReaders(): Promise<void> {
    if (!this.subprocess) return;
    const stdoutStream = this.subprocess.stdout as ReadableStream<Uint8Array>;
    const stderrStream = this.subprocess.stderr as ReadableStream<Uint8Array>;
    if (stdoutStream && typeof stdoutStream.getReader === 'function') {
      void this.pumpStream(stdoutStream, 'stdout');
    }
    if (stderrStream && typeof stderrStream.getReader === 'function') {
      void this.pumpStream(stderrStream, 'stderr');
    }
  }

  private async pumpStream(stream: ReadableStream<Uint8Array>, channel: 'stdout' | 'stderr'): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: false });
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const text = decoder.decode(chunk.value, { stream: true });
        if (!text) continue;
        this.armIdleTimer();
        this.capturedBytes += text.length;
        if (channel === 'stdout') {
          this.capturedStdout = appendCapped(this.capturedStdout, text, this.maxOutputBytes);
          this.events.onStdout?.(text);
        } else {
          this.capturedStderr = appendCapped(this.capturedStderr, text, this.maxOutputBytes);
          this.events.onStderr?.(text);
        }
      }
    } catch {
      // Stream torn down — exit handler will fire shortly.
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.lifecycle !== 'running') return;
      this.lifecycle = 'stalled';
      this.events.onStalled?.(this.idleTimeoutMs);
    }, this.idleTimeoutMs);
  }

  private armWallTimer(): void {
    if (this.wallTimer) clearTimeout(this.wallTimer);
    this.wallTimer = setTimeout(() => {
      if (this.lifecycle !== 'running' && this.lifecycle !== 'stalled') return;
      this.lifecycle = 'timed-out';
      this.events.onTimeout?.();
      this.kill('SIGKILL');
    }, this.timeoutMs);
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.wallTimer) clearTimeout(this.wallTimer);
    if (this.lifecycle !== 'killed' && this.lifecycle !== 'timed-out') {
      this.lifecycle = 'exited';
    }
    this.events.onExit?.(code, signal);
    this.exitDeferred.resolve({ code, signal });
  }
}

function appendCapped(existing: string, addition: string, maxBytes: number): string {
  if (existing.length + addition.length <= maxBytes) return existing + addition;
  // Drop from head, keep the tail (recent activity is most useful).
  const combined = existing + addition;
  return combined.slice(combined.length - maxBytes);
}
