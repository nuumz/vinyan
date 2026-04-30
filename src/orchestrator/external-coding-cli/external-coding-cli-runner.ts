/**
 * Runner — bridges adapter + process + parsers + bridges into a working
 * session. Two entry points:
 *
 *   - runHeadless: spawn → write initial prompt → wait → parse final result.
 *   - startInteractive: spawn → keep stdin open → fan in messages, fan out
 *     events; resolution arrives via terminal state or explicit cancel.
 *
 * The runner is provider-agnostic: it speaks {@link CodingCliProviderAdapter}
 * only. Adapters keep their quirks (claude-style stream-json, gh-style
 * --allow-tool) inside their own files.
 *
 * Events are passed per-call so a single runner instance can drive
 * multiple sessions concurrently with different listeners.
 */
import { PipeProcess } from './external-coding-cli-pty-adapter.ts';
import { parseFinalResult } from './external-coding-cli-result-parser.ts';
import type {
  CodingCliApprovalRequest,
  CodingCliCommand,
  CodingCliInput,
  CodingCliParsedEvent,
  CodingCliProviderAdapter,
  CodingCliResult,
  CodingCliSessionState,
  CodingCliTask,
  ParseContext,
} from './types.ts';

export interface RunnerEvents {
  onParsedEvent?(event: CodingCliParsedEvent): void;
  onApprovalDetected?(request: CodingCliApprovalRequest): Promise<'approved' | 'rejected'>;
  onProcessSpawned?(pid: number | null): void;
  onProcessExit?(code: number | null, signal: NodeJS.Signals | null): void;
  onStalled?(idleMs: number): void;
  onTimeout?(): void;
  onProviderSessionId?(id: string): void;
  onStateChange?(state: CodingCliSessionState, reason?: string): void;
}

export interface HeadlessRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  result: CodingCliResult | null;
  durationMs: number;
}

export class CodingCliRunner {
  constructor(private readonly adapter: CodingCliProviderAdapter) {}

  async runHeadless(task: CodingCliTask, events: RunnerEvents = {}): Promise<HeadlessRunResult> {
    const cmd = this.adapter.buildHeadlessCommand(task);
    if (!cmd) {
      throw new Error(`provider ${this.adapter.id} cannot run headlessly for task ${task.taskId}`);
    }
    const startedAt = Date.now();
    const ctx: ParseContext = { buffer: '' };
    const initialPrompt = this.adapter.formatInitialPrompt(task);
    const proc = this.spawnAndWire(cmd, ctx, events, {
      idleTimeoutMs: task.idleTimeoutMs,
      timeoutMs: task.timeoutMs,
      maxOutputBytes: task.maxOutputBytes,
    });
    const writeOk = await proc.write(initialPrompt);
    if (!writeOk) {
      proc.kill('SIGTERM');
    }
    proc.closeStdin();
    const exit = await proc.wait();
    const durationMs = Date.now() - startedAt;
    const stdout = proc.stdout();
    const stderr = proc.stderr();
    const result =
      this.adapter.parseFinalResult(stdout) ??
      parseFinalResult(stdout, { expectedProviderId: this.adapter.id });
    events.onProcessExit?.(exit.code, exit.signal);
    return { exitCode: exit.code, signal: exit.signal, stdout, stderr, result, durationMs };
  }

  startInteractive(task: CodingCliTask, events: RunnerEvents = {}): InteractiveSessionHandle {
    const cmd = this.adapter.buildInteractiveCommand(task);
    const ctx: ParseContext = { buffer: '' };
    const proc = this.spawnAndWire(cmd, ctx, events, {
      idleTimeoutMs: task.idleTimeoutMs,
      timeoutMs: task.timeoutMs,
      maxOutputBytes: task.maxOutputBytes,
    });
    return new InteractiveSessionHandle(this.adapter, proc, ctx, task);
  }

  private spawnAndWire(
    cmd: CodingCliCommand,
    ctx: ParseContext,
    events: RunnerEvents,
    timing: { idleTimeoutMs: number; timeoutMs: number; maxOutputBytes: number },
  ): PipeProcess {
    const proc = new PipeProcess(
      {
        bin: cmd.bin,
        args: cmd.args,
        cwd: cmd.cwd,
        env: cmd.env,
        idleTimeoutMs: timing.idleTimeoutMs,
        timeoutMs: timing.timeoutMs,
        maxOutputBytes: timing.maxOutputBytes,
      },
      {
        onStdout: (text) => this.handleChunk(text, 'stdout', ctx, events),
        onStderr: (text) => this.handleChunk(text, 'stderr', ctx, events),
        onExit: (code, signal) => events.onProcessExit?.(code, signal),
        onStalled: (idleMs) => events.onStalled?.(idleMs),
        onTimeout: () => events.onTimeout?.(),
      },
    );
    proc.start();
    events.onProcessSpawned?.(proc.pid());
    return proc;
  }

  private handleChunk(
    chunk: string,
    channel: 'stdout' | 'stderr',
    ctx: ParseContext,
    events: RunnerEvents,
  ): void {
    ctx.buffer += chunk;
    const parsed = this.adapter.parseOutputDelta(chunk, ctx);
    for (const evt of parsed) {
      switch (evt.kind) {
        case 'tool_started':
          ctx.activeToolStartedAt = Date.now();
          events.onParsedEvent?.(evt);
          break;
        case 'tool_completed':
          ctx.activeToolStartedAt = undefined;
          events.onParsedEvent?.(evt);
          break;
        case 'provider_session':
          ctx.providerSessionId = evt.providerSessionId;
          events.onProviderSessionId?.(evt.providerSessionId);
          break;
        case 'state':
          events.onStateChange?.(evt.state, evt.reason);
          break;
        case 'approval_required':
          if (events.onApprovalDetected) {
            void events.onApprovalDetected(evt.raw);
          }
          events.onParsedEvent?.(evt);
          break;
        default:
          events.onParsedEvent?.(evt);
      }
    }
    void channel;
  }
}

export class InteractiveSessionHandle {
  private cancelled = false;

  constructor(
    private readonly adapter: CodingCliProviderAdapter,
    private readonly proc: PipeProcess,
    private readonly ctx: ParseContext,
    private readonly task: CodingCliTask,
  ) {}

  pid(): number | null {
    return this.proc.pid();
  }

  async send(message: string, role: 'initial' | 'followup' = 'followup'): Promise<boolean> {
    const formatted =
      role === 'initial'
        ? this.adapter.formatInitialPrompt(this.task)
        : this.adapter.formatFollowupMessage(message);
    return this.proc.write(formatted);
  }

  async respondToApproval(
    request: CodingCliApprovalRequest,
    decision: 'approved' | 'rejected',
  ): Promise<boolean> {
    const reply: CodingCliInput = this.adapter.respondToApproval(request, decision);
    switch (reply.kind) {
      case 'stdin':
        return this.proc.write(reply.bytes);
      case 'file':
        return false;
      case 'http':
        return false;
      case 'signal':
        return this.proc.kill(reply.signal);
      case 'noop':
        return false;
    }
  }

  async cancel(reason?: string): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    void reason;
    this.proc.kill('SIGTERM');
    setTimeout(() => {
      if (this.proc.state() === 'running') {
        this.proc.kill('SIGKILL');
      }
    }, 5_000);
  }

  async waitForCompletion(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return this.proc.wait();
  }

  bufferSnapshot(): string {
    return this.ctx.buffer;
  }

  stdout(): string {
    return this.proc.stdout();
  }

  stderr(): string {
    return this.proc.stderr();
  }

  state(): string {
    return this.proc.state();
  }
}
