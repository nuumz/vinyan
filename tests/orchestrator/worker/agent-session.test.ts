import { describe, expect, test } from 'bun:test';
import type { OrchestratorTurn, WorkerTurn } from '../../../src/orchestrator/protocol.ts';
import type { SubprocessHandle } from '../../../src/orchestrator/worker/agent-session.ts';
import { AgentSession } from '../../../src/orchestrator/worker/agent-session.ts';

// ── Mock helpers ─────────────────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

interface MockProcess {
  proc: SubprocessHandle;
  stdinChunks: string[];
  /** Push a line into the mock stdout (simulates worker writing). */
  pushStdout(line: string): void;
  /** Close the mock stdout stream. */
  closeStdout(): void;
}

function createMockProcess(workerResponses: string[] = []): MockProcess {
  const stdinChunks: string[] = [];
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;

  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller;
      for (const resp of workerResponses) {
        controller.enqueue(enc.encode(`${resp}\n`));
      }
    },
  });

  const stdin = {
    write(chunk: string | Uint8Array) {
      stdinChunks.push(typeof chunk === 'string' ? chunk : dec.decode(chunk));
      return typeof chunk === 'string' ? chunk.length : chunk.byteLength;
    },
    end() {},
  };

  return {
    proc: {
      stdin,
      stdout,
      pid: 12345,
      exited: new Promise(() => {}), // never resolves by default
      kill: () => {},
    },
    stdinChunks,
    pushStdout(line: string) {
      stdoutController.enqueue(enc.encode(`${line}\n`));
    },
    closeStdout() {
      stdoutController.close();
    },
  };
}

/** A minimal valid init turn for testing send(). */
function makeInitTurn(): OrchestratorTurn {
  return {
    type: 'init',
    taskId: 'task-1',
    goal: 'test goal',
    routingLevel: 1,
    perception: {
      taskTarget: { file: 'test.ts', description: 'test' },
      dependencyCone: {
        directImporters: [],
        directImportees: [],
        transitiveBlastRadius: 0,
      },
      diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
      verifiedFacts: [],
      runtime: { nodeVersion: '22', os: 'linux', availableTools: [] },
    },
    workingMemory: {
      failedApproaches: [],
      activeHypotheses: [],
      unresolvedUncertainties: [],
      scopedFacts: [],
    },
    budget: {
      maxTokens: 1000,
      maxTurns: 10,
      maxDurationMs: 60000,
      contextWindow: 128000,
      base: 500,
      negotiable: 300,
      delegation: 200,
      maxExtensionRequests: 3,
      maxToolCallsPerTurn: 10,
      delegationDepth: 0,
      maxDelegationDepth: 3,
    },
    allowedPaths: ['/tmp'],
    toolManifest: [],
  } as OrchestratorTurn;
}

/** A minimal valid WorkerTurn (done). */
function makeDoneTurn(): WorkerTurn {
  return { type: 'done', turnId: 'turn-1' };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('AgentSession', () => {
  test('state transitions: INIT → send → WAITING_FOR_WORKER → receive → WAITING_FOR_ORCHESTRATOR', async () => {
    const doneTurn = makeDoneTurn();
    const mock = createMockProcess([JSON.stringify(doneTurn)]);
    const session = new AgentSession(mock.proc);

    expect(session.sessionState).toBe('INIT');

    await session.send(makeInitTurn());
    expect(session.sessionState).toBe('WAITING_FOR_WORKER');

    const received = await session.receive(1000);
    expect(session.sessionState).toBe('WAITING_FOR_ORCHESTRATOR');
    expect(received).not.toBeNull();
    expect(received!.type).toBe('done');
    expect(received!.turnId).toBe('turn-1');
  });

  test('send() in wrong state throws', async () => {
    const mock = createMockProcess();
    const session = new AgentSession(mock.proc);

    // First send is valid (INIT → WAITING_FOR_WORKER)
    await session.send(makeInitTurn());
    expect(session.sessionState).toBe('WAITING_FOR_WORKER');

    // Second send in WAITING_FOR_WORKER should throw
    await expect(session.send(makeInitTurn())).rejects.toThrow('Invalid state for send: WAITING_FOR_WORKER');
  });

  test('receive() in wrong state throws', async () => {
    const mock = createMockProcess();
    const session = new AgentSession(mock.proc);

    // State is INIT — receive should throw
    await expect(session.receive(100)).rejects.toThrow('Invalid state for receive: INIT');
  });

  test('receive() timeout returns null and stays in WAITING_FOR_WORKER', async () => {
    const mock = createMockProcess(); // no responses queued
    const session = new AgentSession(mock.proc);

    await session.send(makeInitTurn());
    expect(session.sessionState).toBe('WAITING_FOR_WORKER');

    const result = await session.receive(50);
    expect(result).toBeNull();
    expect(session.sessionState).toBe('WAITING_FOR_WORKER');
  });

  test('receive() with invalid JSON returns null', async () => {
    const mock = createMockProcess(['not-valid-json']);
    const session = new AgentSession(mock.proc);

    await session.send(makeInitTurn());
    const result = await session.receive(1000);
    expect(result).toBeNull();
  });

  test('receive() with invalid WorkerTurn schema returns null', async () => {
    const mock = createMockProcess([JSON.stringify({ type: 'bogus', turnId: 'x' })]);
    const session = new AgentSession(mock.proc);

    await session.send(makeInitTurn());
    const result = await session.receive(1000);
    expect(result).toBeNull();
  });

  test('close() is idempotent', async () => {
    const mock = createMockProcess();
    // Make exited resolve quickly so close doesn't need to kill
    (mock.proc as any).exited = Promise.resolve(0);

    const session = new AgentSession(mock.proc);
    await session.close('budget_exceeded');
    expect(session.sessionState).toBe('CLOSED');

    // Second close should not throw
    await session.close('budget_exceeded');
    expect(session.sessionState).toBe('CLOSED');
  });

  test('close() sends terminate turn to stdin', async () => {
    const mock = createMockProcess();
    (mock.proc as any).exited = Promise.resolve(0);

    const session = new AgentSession(mock.proc);
    await session.close('budget_exceeded');

    const written = mock.stdinChunks.join('');
    const parsed = JSON.parse(written.trim());
    expect(parsed.type).toBe('terminate');
    expect(parsed.reason).toBe('budget_exceeded');
  });

  test('drainAndClose() does NOT send terminate turn', async () => {
    const mock = createMockProcess();
    (mock.proc as any).exited = Promise.resolve(0);

    const session = new AgentSession(mock.proc);
    await session.drainAndClose();

    expect(mock.stdinChunks.length).toBe(0);
    expect(session.sessionState).toBe('CLOSED');
  });

  test('drainAndClose() is idempotent', async () => {
    const mock = createMockProcess();
    (mock.proc as any).exited = Promise.resolve(0);

    const session = new AgentSession(mock.proc);
    await session.drainAndClose();
    await session.drainAndClose();
    expect(session.sessionState).toBe('CLOSED');
  });

  test('pid returns the subprocess pid', () => {
    const mock = createMockProcess();
    const session = new AgentSession(mock.proc);
    expect(session.pid).toBe(12345);
  });

  test('multi-turn conversation flow', async () => {
    const toolCallsTurn: WorkerTurn = {
      type: 'tool_calls',
      turnId: 'turn-1',
      calls: [{ id: 'c1', tool: 'read_file', parameters: { path: '/test.ts' } }],
      rationale: 'need to read',
    };
    const doneTurn: WorkerTurn = { type: 'done', turnId: 'turn-2' };

    const mock = createMockProcess([JSON.stringify(toolCallsTurn), JSON.stringify(doneTurn)]);
    const session = new AgentSession(mock.proc);

    // Turn 1: init → tool_calls
    await session.send(makeInitTurn());
    const t1 = await session.receive(1000);
    expect(t1!.type).toBe('tool_calls');
    expect(session.sessionState).toBe('WAITING_FOR_ORCHESTRATOR');

    // Turn 2: tool_results → done
    const toolResults: OrchestratorTurn = {
      type: 'tool_results',
      turnId: 'turn-1',
      results: [
        {
          callId: 'c1',
          tool: 'read_file',
          status: 'success',
          output: 'file content',
          durationMs: 10,
        },
      ],
    };
    await session.send(toolResults);
    expect(session.sessionState).toBe('WAITING_FOR_WORKER');

    const t2 = await session.receive(1000);
    expect(t2!.type).toBe('done');
    expect(session.sessionState).toBe('WAITING_FOR_ORCHESTRATOR');
  });
});
