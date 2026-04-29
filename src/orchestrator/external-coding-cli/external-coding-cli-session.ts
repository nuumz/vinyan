/**
 * Session — long-lived object that owns: state machine, runner handle,
 * approval bridge, hook bridge, parsed events.
 *
 * The controller creates one session per task. The session owns the
 * lifecycle and surfaces events on the bus.
 */
import type { VinyanBus } from '../../core/bus.ts';
import type { CodingCliApprovalBridge } from './external-coding-cli-approval-bridge.ts';
import type { HookBridge } from './external-coding-cli-hook-bridge.ts';
import {
  type CodingCliRunner,
  type InteractiveSessionHandle,
  type RunnerEvents,
} from './external-coding-cli-runner.ts';
import { CodingCliStateMachine } from './external-coding-cli-state-machine.ts';
import type {
  CodingCliApprovalRequest,
  CodingCliCapabilities,
  CodingCliEventBase,
  CodingCliParsedEvent,
  CodingCliProviderAdapter,
  CodingCliResult,
  CodingCliSessionState,
  CodingCliTask,
  HookEvent,
} from './types.ts';

export interface SessionDeps {
  bus: VinyanBus;
  adapter: CodingCliProviderAdapter;
  runner: CodingCliRunner;
  approvalBridge: CodingCliApprovalBridge;
  hookBridge: HookBridge;
}

export interface SessionTimings {
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  lastOutputAt: number | null;
  lastHookAt: number | null;
}

export class CodingCliSession {
  readonly id: string;
  readonly task: CodingCliTask;
  readonly adapterId: string;
  readonly capabilities: CodingCliCapabilities;
  private readonly deps: SessionDeps;
  private readonly stateMachine: CodingCliStateMachine;
  private interactiveHandle: InteractiveSessionHandle | null = null;
  private providerSessionId: string | null = null;
  private pid: number | null = null;
  private finalResult: CodingCliResult | null = null;
  private filesChanged = new Set<string>();
  private commandsRequested: string[] = [];
  private timings: SessionTimings;

  constructor(id: string, task: CodingCliTask, deps: SessionDeps) {
    this.id = id;
    this.task = task;
    this.deps = deps;
    this.adapterId = deps.adapter.id;
    this.capabilities = deps.adapter.getCapabilities();
    this.stateMachine = new CodingCliStateMachine();
    this.timings = {
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
      lastOutputAt: null,
      lastHookAt: null,
    };
  }

  state(): CodingCliSessionState {
    return this.stateMachine.state();
  }

  history() {
    return this.stateMachine.getHistory();
  }

  result(): CodingCliResult | null {
    return this.finalResult;
  }

  changedFiles(): string[] {
    return [...this.filesChanged];
  }

  commands(): string[] {
    return [...this.commandsRequested];
  }

  pidOrNull(): number | null {
    return this.pid;
  }

  providerSessionIdOrNull(): string | null {
    return this.providerSessionId;
  }

  timingsSnapshot(): SessionTimings {
    return { ...this.timings };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  emitCreated(binaryPath: string, binaryVersion: string | null): void {
    this.deps.bus.emit('coding-cli:session_created', {
      ...this.eventBase(),
      cwd: this.task.cwd,
      binaryPath,
      binaryVersion,
      capabilities: this.capabilities,
    });
  }

  async runHeadless(): Promise<{
    result: CodingCliResult | null;
    stdout: string;
    stderr: string;
    exitCode: number | null;
  }> {
    this.transition('starting', 'headless run');
    this.timings.startedAt = Date.now();
    this.deps.bus.emit('coding-cli:session_started', {
      ...this.eventBase(),
      pid: null,
      command: 'headless',
    });
    this.transition('ready', 'process spawned');
    this.transition('running', 'first prompt');
    let outcome:
      | { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; result: CodingCliResult | null; durationMs: number }
      | null = null;
    try {
      outcome = await this.deps.runner.runHeadless(this.task, this.runnerEvents());
    } catch (err) {
      this.transition('failed', `runtime error: ${(err as Error).message}`);
      this.timings.endedAt = Date.now();
      return { result: null, stdout: '', stderr: (err as Error).message, exitCode: null };
    }
    if (outcome.result) {
      this.finalResult = outcome.result;
      this.deps.bus.emit('coding-cli:result_reported', {
        ...this.eventBase(),
        claim: outcome.result,
      });
    }
    this.timings.endedAt = Date.now();
    return { result: outcome.result, stdout: outcome.stdout, stderr: outcome.stderr, exitCode: outcome.exitCode };
  }

  startInteractive(): InteractiveSessionHandle {
    if (this.interactiveHandle) {
      throw new Error(`session ${this.id} already started`);
    }
    this.transition('starting', 'interactive');
    this.timings.startedAt = Date.now();
    const handle = this.deps.runner.startInteractive(this.task, this.runnerEvents());
    this.interactiveHandle = handle;
    this.pid = handle.pid();
    this.deps.bus.emit('coding-cli:session_started', {
      ...this.eventBase(),
      pid: this.pid,
      command: 'interactive',
    });
    this.transition('ready', 'process spawned');
    this.transition('running', 'awaiting input');
    return handle;
  }

  async sendMessage(text: string): Promise<boolean> {
    if (!this.interactiveHandle) return false;
    const ok = await this.interactiveHandle.send(text);
    if (ok) {
      this.deps.bus.emit('coding-cli:message_sent', {
        ...this.eventBase(),
        preview: text.slice(0, 240),
        bytes: text.length,
        followup: true,
      });
    }
    return ok;
  }

  async respondToApproval(
    request: CodingCliApprovalRequest,
    decision: 'approved' | 'rejected',
  ): Promise<boolean> {
    if (!this.interactiveHandle) return false;
    return this.interactiveHandle.respondToApproval(request, decision);
  }

  async cancel(reason?: string): Promise<void> {
    if (this.interactiveHandle) {
      await this.interactiveHandle.cancel(reason);
    }
    if (!this.stateMachine.isTerminal()) {
      this.transition('cancelled', reason ?? 'user-cancelled');
    }
    this.deps.bus.emit('coding-cli:cancelled', {
      ...this.eventBase(),
      cancelledBy: 'user',
      reason,
    });
    this.timings.endedAt = Date.now();
  }

  finalize(state: CodingCliSessionState, reason?: string): void {
    if (this.stateMachine.isTerminal()) return;
    this.transition(state, reason);
    this.timings.endedAt = Date.now();
    if (state === 'completed') {
      this.deps.bus.emit('coding-cli:completed', {
        ...this.eventBase(),
        finalStatus: 'completed',
        summary: this.finalResult?.summary ?? '',
      });
    } else if (state === 'failed' || state === 'crashed' || state === 'timed-out') {
      this.deps.bus.emit('coding-cli:failed', {
        ...this.eventBase(),
        reason: reason ?? state,
        errorClass:
          state === 'crashed' ? 'cli_crash' : state === 'timed-out' ? 'timeout' : 'unknown',
      });
    }
  }

  ingestNativeHookEvents(): HookEvent[] {
    const events = this.deps.hookBridge.drainNative();
    for (const evt of events) {
      this.timings.lastHookAt = evt.timestamp;
      this.handleHookEvent(evt);
    }
    return events;
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  private runnerEvents(): RunnerEvents {
    return {
      onProcessSpawned: (pid) => {
        this.pid = pid;
      },
      onParsedEvent: (evt) => this.handleParsedEvent(evt),
      onProviderSessionId: (id) => this.recordProviderSession(id),
      onStalled: (idleMs) => this.handleStalled(idleMs),
      onTimeout: () => this.handleTimeout(),
      onStateChange: (state, reason) => this.transition(state, reason),
      onApprovalDetected: async (request) => {
        const resolution = await this.deps.approvalBridge.request(
          {
            taskId: this.task.taskId,
            sessionId: this.task.sessionId,
            codingCliSessionId: this.id,
            providerId: this.deps.adapter.id,
            state: this.state(),
          },
          request,
        );
        if (this.interactiveHandle) {
          await this.interactiveHandle.respondToApproval(request, resolution.decision);
        }
        return resolution.decision;
      },
    };
  }

  private handleParsedEvent(evt: CodingCliParsedEvent): void {
    const base = this.eventBase();
    this.timings.lastOutputAt = base.ts;
    switch (evt.kind) {
      case 'output_delta':
        this.deps.bus.emit('coding-cli:output_delta', {
          ...base,
          text: evt.text,
          channel: evt.channel,
        });
        break;
      case 'tool_started':
        this.deps.bus.emit('coding-cli:tool_started', {
          ...base,
          toolName: evt.toolName,
          summary: evt.summary,
          safeInput: evt.safeInput,
        });
        break;
      case 'tool_completed':
        this.deps.bus.emit('coding-cli:tool_completed', {
          ...base,
          toolName: evt.toolName,
          ok: evt.ok,
          durationMs: evt.durationMs ?? 0,
          errorMessage: evt.errorMessage,
          safeResult: evt.safeResult,
        });
        break;
      case 'file_changed':
        this.filesChanged.add(evt.path);
        this.deps.bus.emit('coding-cli:file_changed', {
          ...base,
          path: evt.path,
          changeType: evt.changeType,
          bytes: evt.bytes,
        });
        break;
      case 'command_requested':
        this.commandsRequested.push(evt.command);
        this.deps.bus.emit('coding-cli:command_requested', {
          ...base,
          command: evt.command,
          reason: evt.reason,
        });
        break;
      case 'command_completed':
        this.deps.bus.emit('coding-cli:command_completed', {
          ...base,
          command: evt.command,
          exitCode: evt.exitCode,
          durationMs: evt.durationMs,
          outputPreview: evt.outputPreview,
        });
        break;
      case 'state':
        break;
      case 'checkpoint':
        this.deps.bus.emit('coding-cli:checkpoint', {
          ...base,
          label: evt.label,
          detail: evt.detail,
        });
        break;
      case 'decision':
        this.deps.bus.emit('coding-cli:decision_recorded', {
          ...base,
          decision: evt.decision,
          rationale: evt.rationale,
          alternatives: evt.alternatives,
        });
        break;
      case 'result':
        this.finalResult = evt.result;
        this.deps.bus.emit('coding-cli:result_reported', {
          ...base,
          claim: evt.result,
        });
        break;
      case 'approval_required':
        break;
      case 'provider_session':
        this.recordProviderSession(evt.providerSessionId);
        break;
    }
  }

  private handleHookEvent(evt: HookEvent): void {
    const base = this.eventBase();
    if (evt.toolName && evt.eventType === 'tool_started') {
      this.deps.bus.emit('coding-cli:tool_started', {
        ...base,
        toolName: evt.toolName,
        summary: evt.eventType,
        safeInput:
          typeof evt.toolInput === 'object' && evt.toolInput !== null
            ? (evt.toolInput as Record<string, unknown>)
            : undefined,
      });
    } else if (evt.toolName && evt.eventType === 'tool_completed') {
      this.deps.bus.emit('coding-cli:tool_completed', {
        ...base,
        toolName: evt.toolName,
        ok: true,
        durationMs: 0,
        safeResult:
          typeof evt.toolResult === 'object' && evt.toolResult !== null
            ? (evt.toolResult as Record<string, unknown>)
            : undefined,
      });
    }
    if (evt.files && evt.files.length > 0) {
      for (const f of evt.files) {
        this.filesChanged.add(f);
        this.deps.bus.emit('coding-cli:file_changed', {
          ...base,
          path: f,
          changeType: 'modified',
        });
      }
    }
  }

  private handleStalled(idleMs: number): void {
    if (this.stateMachine.canTransition('stalled')) {
      this.transition('stalled', `idle ${idleMs}ms`);
    }
    this.deps.bus.emit('coding-cli:stalled', {
      ...this.eventBase(),
      idleMs,
      lastSignalAt: this.timings.lastOutputAt ?? this.timings.startedAt ?? Date.now(),
    });
  }

  private handleTimeout(): void {
    if (!this.stateMachine.isTerminal()) {
      this.transition('timed-out', 'wall-clock deadline');
    }
  }

  private recordProviderSession(id: string): void {
    if (this.providerSessionId === id) return;
    this.providerSessionId = id;
  }

  private transition(state: CodingCliSessionState, reason?: string): void {
    if (this.stateMachine.state() === state) return;
    if (!this.stateMachine.canTransition(state)) return;
    const prev = this.stateMachine.state();
    this.stateMachine.transition(state, reason);
    this.deps.bus.emit('coding-cli:state_changed', {
      ...this.eventBase(),
      prevState: prev,
      reason,
    });
  }

  private eventBase(): CodingCliEventBase {
    return {
      taskId: this.task.taskId,
      sessionId: this.task.sessionId,
      codingCliSessionId: this.id,
      providerId: this.deps.adapter.id,
      providerSessionId: this.providerSessionId ?? undefined,
      state: this.state(),
      ts: Date.now(),
      correlationId: this.task.correlationId,
    };
  }
}
