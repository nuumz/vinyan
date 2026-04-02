/**
 * AgentSession — manages the IPC lifecycle of a single worker subprocess.
 *
 * Implements a strict state machine over ndjson stdin/stdout:
 *   INIT → WAITING_FOR_WORKER → WAITING_FOR_ORCHESTRATOR → (loop) → CLOSED
 *
 * Source of truth: spec/tdd.md §16.3 (Worker lifecycle), protocol.ts (Zod schemas)
 */
import type { OrchestratorTurn, TerminateReason, WorkerTurn } from '../protocol.ts';
import { WorkerTurnSchema } from '../protocol.ts';

// ── Types ────────────────────────────────────────────────────────────

export type SessionState = 'INIT' | 'WAITING_FOR_WORKER' | 'WAITING_FOR_ORCHESTRATOR' | 'CLOSED';

/** Duck-typed subprocess handle — matches Bun.spawn() actual output (FileSink, not WritableStream). */
export interface SubprocessHandle {
  stdin: { write(data: string | Uint8Array): number; flush?(): void; end(): void };
  stdout: ReadableStream<Uint8Array>;
  pid: number;
  exited: Promise<number>;
  kill(signal?: number): void;
}

export interface IAgentSession {
  send(turn: OrchestratorTurn): Promise<void>;
  receive(timeoutMs: number): Promise<WorkerTurn | null>;
  close(reason: TerminateReason): Promise<void>;
  drainAndClose(): Promise<void>;
  readonly sessionState: SessionState;
  readonly pid: number;
}

// ── Implementation ───────────────────────────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class AgentSession implements IAgentSession {
  private state: SessionState = 'INIT';
  private reader!: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = '';

  constructor(private readonly proc: SubprocessHandle) {
    // biome-ignore lint: Bun's ReadableStreamDefaultReader has extra `readMany` — duck-type is sufficient
    this.reader = proc.stdout.getReader() as any;
  }

  get sessionState(): SessionState {
    return this.state;
  }

  get pid(): number {
    return this.proc.pid;
  }

  async send(turn: OrchestratorTurn): Promise<void> {
    if (this.state !== 'INIT' && this.state !== 'WAITING_FOR_ORCHESTRATOR') {
      throw new Error(`Invalid state for send: ${this.state}`);
    }
    const line = `${JSON.stringify(turn)}\n`;
    this.proc.stdin.write(encoder.encode(line));
    this.state = 'WAITING_FOR_WORKER';
  }

  async receive(timeoutMs: number): Promise<WorkerTurn | null> {
    if (this.state !== 'WAITING_FOR_WORKER') {
      throw new Error(`Invalid state for receive: ${this.state}`);
    }

    const line = await Promise.race([this.readNextLine(), sleep(timeoutMs).then(() => null)]);

    if (line === null) {
      return null; // timeout — state stays WAITING_FOR_WORKER
    }

    try {
      const parsed = JSON.parse(line);
      const result = WorkerTurnSchema.safeParse(parsed);
      if (!result.success) {
        console.error('[AgentSession] Invalid WorkerTurn:', result.error.message);
        return null;
      }
      this.state = 'WAITING_FOR_ORCHESTRATOR';
      return result.data;
    } catch {
      console.error('[AgentSession] Failed to parse JSON from worker');
      return null;
    }
  }

  async close(reason: TerminateReason): Promise<void> {
    if (this.state === 'CLOSED') return;

    try {
      const terminate: OrchestratorTurn = { type: 'terminate', reason };
      this.proc.stdin.write(encoder.encode(`${JSON.stringify(terminate)}\n`));
    } catch {
      // stdin may already be closed — ignore
    }

    await this.shutdownProcess();
  }

  async drainAndClose(): Promise<void> {
    if (this.state === 'CLOSED') return;
    await this.shutdownProcess();
  }

  // ── Private helpers ──────────────────────────────────────────────

  private async readNextLine(): Promise<string> {
    while (true) {
      const newlineIdx = this.buffer.indexOf('\n');
      if (newlineIdx !== -1) {
        const line = this.buffer.slice(0, newlineIdx);
        this.buffer = this.buffer.slice(newlineIdx + 1);
        return line;
      }

      const { done, value } = await this.reader.read();
      if (done) {
        const remaining = this.buffer;
        this.buffer = '';
        return remaining;
      }
      this.buffer += decoder.decode(value, { stream: true });
    }
  }

  private async shutdownProcess(): Promise<void> {
    try {
      this.proc.stdin.end();
    } catch {
      // already closed — ignore
    }

    try {
      this.reader.releaseLock();
    } catch {
      // already released — ignore
    }

    const result = await Promise.race([this.proc.exited, sleep(2000).then(() => 'timeout' as const)]);

    if (result === 'timeout') {
      this.proc.kill();
    }

    this.state = 'CLOSED';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
