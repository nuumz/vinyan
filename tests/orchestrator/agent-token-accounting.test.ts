/**
 * Token accounting across the worker → orchestrator seam.
 *
 * The worker subprocess (`agent-worker-entry.ts`) writes usage onto every turn
 * and the orchestrator (`agent-loop.ts`) sums what it receives. Each side had
 * its own unit tests and each passed, but they disagreed about what the number
 * meant: the worker sent a running session total, the loop added it up. Three
 * turns of 1k tokens were reported as 6k. Nothing caught it, because no test
 * ran the two together.
 *
 * So these tests drive the real worker loop, take the turns it actually
 * writes, and replay them through the real orchestrator loop — asserting the
 * session total the orchestrator lands on matches what the provider really
 * charged. Any future drift in the meaning of a usage field fails here.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentLoopDeps, runAgentLoop } from '../../src/orchestrator/agent/agent-loop.ts';
import type { IAgentSession, SessionState } from '../../src/orchestrator/agent/agent-session.ts';
import { runAgentWorkerLoop, type WorkerIO } from '../../src/orchestrator/agent/agent-worker-entry.ts';
import { createScriptedMockProvider, type ScriptedMockResponse } from '../../src/orchestrator/llm/mock-provider.ts';
import type { OrchestratorTurn, WorkerTurn } from '../../src/orchestrator/protocol.ts';
import type {
  PerceptualHierarchy,
  RoutingDecision,
  TaskInput,
  ToolCall,
  ToolResult,
  WorkingMemoryState,
} from '../../src/orchestrator/types.ts';

// ── Worker side ──────────────────────────────────────────────────────

function makeInitTurn(): string {
  return JSON.stringify({
    type: 'init',
    taskId: 'task-1',
    goal: 'Edit two files',
    routingLevel: 2,
    perception: {
      taskTarget: { file: 'a.ts', description: 'target' },
      dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
      diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
      verifiedFacts: [],
      runtime: { nodeVersion: '22', os: 'linux', availableTools: ['file_read'] },
    },
    workingMemory: { failedApproaches: [], activeHypotheses: [], unresolvedUncertainties: [], scopedFacts: [] },
    budget: {
      maxTokens: 1_000_000,
      maxTurns: 10,
      maxDurationMs: 60_000,
      contextWindow: 128_000,
      base: 5000,
      negotiable: 3000,
      delegation: 2000,
      maxExtensionRequests: 3,
      maxToolCallsPerTurn: 10,
      delegationDepth: 0,
      maxDelegationDepth: 3,
    },
    allowedPaths: ['/tmp'],
    toolManifest: [
      { name: 'file_read', description: 'Read a file', inputSchema: { path: { type: 'string' } } },
      { name: 'attempt_completion', description: 'Signal completion', inputSchema: { status: { type: 'string' } } },
    ],
  });
}

function makeToolResults(turnId: string, callId: string): string {
  return JSON.stringify({
    type: 'tool_results',
    turnId,
    results: [{ callId, tool: 'file_read', output: 'content', status: 'success', durationMs: 1 }],
  });
}

/** Run the real worker loop and return the turns it wrote to stdout. */
async function collectWorkerTurns(responses: ScriptedMockResponse[]): Promise<WorkerTurn[]> {
  const provider = createScriptedMockProvider(responses);
  // One tool_results reply per non-terminal response.
  const inputs = [makeInitTurn(), ...responses.slice(0, -1).map((_, i) => makeToolResults(`t${i}`, `tc${i}`))];
  const queue = [...inputs];
  const outputs: string[] = [];
  const io: WorkerIO = {
    async readLine() {
      return queue.shift() ?? null;
    },
    writeLine(line: string) {
      outputs.push(line);
    },
  };
  await runAgentWorkerLoop(provider, io);
  return outputs.map((line) => JSON.parse(line.trim()) as WorkerTurn);
}

// ── Orchestrator side ────────────────────────────────────────────────

class ReplaySession implements IAgentSession {
  private index = 0;
  state: SessionState = 'INIT';
  readonly pid = 1;

  constructor(private readonly turns: WorkerTurn[]) {}

  async send(_turn: OrchestratorTurn): Promise<void> {
    this.state = 'WAITING_FOR_WORKER';
  }

  async receive(): Promise<WorkerTurn | null> {
    const turn = this.turns[this.index++] ?? null;
    if (turn) this.state = 'WAITING_FOR_ORCHESTRATOR';
    return turn;
  }

  async close(): Promise<void> {
    this.state = 'CLOSED';
  }

  async drainAndClose(): Promise<void> {
    this.state = 'CLOSED';
  }

  get sessionState(): SessionState {
    return this.state;
  }
}

let workspace: string;

beforeEach(() => {
  workspace = join(tmpdir(), `vinyan-tokacct-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function makeDeps(session: ReplaySession): AgentLoopDeps {
  return {
    workspace,
    contextWindow: 128_000,
    agentWorkerEntryPath: '/dev/null',
    toolExecutor: {
      execute: async (call: ToolCall): Promise<ToolResult> => ({
        callId: call.id,
        tool: call.tool,
        status: 'success',
        output: 'mock result',
        durationMs: 1,
      }),
    },
    compressPerception: (p) => p,
    createSession: () => session,
  };
}

function makeInput(): TaskInput {
  return {
    id: 'task-1',
    source: 'cli',
    goal: 'Edit two files',
    taskType: 'code',
    targetFiles: ['a.ts'],
    budget: { maxTokens: 1_000_000, maxDurationMs: 60_000, maxRetries: 2 },
  } as TaskInput;
}

function makePerception(): PerceptualHierarchy {
  return {
    taskTarget: { file: 'a.ts', description: 'target' },
    dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
    diagnostics: { lintWarnings: [], typeErrors: [], testFailures: [] },
    verifiedFacts: [],
    runtime: {},
  } as unknown as PerceptualHierarchy;
}

function makeMemory(): WorkingMemoryState {
  return { failedApproaches: [], activeHypotheses: [], unresolvedUncertainties: [], scopedFacts: [] };
}

function makeRouting(): RoutingDecision {
  return { level: 2, model: 'claude-sonnet-4', budgetTokens: 1_000_000, latencyBudgetMs: 60_000 } as RoutingDecision;
}

/** Drive the real worker, replay its turns through the real orchestrator loop. */
async function roundTrip(responses: ScriptedMockResponse[]) {
  const turns = await collectWorkerTurns(responses);
  const session = new ReplaySession(turns);
  const result = await runAgentLoop(
    makeInput(),
    makePerception(),
    makeMemory(),
    undefined,
    makeRouting(),
    makeDeps(session),
  );
  return { turns, result };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('worker → orchestrator token accounting', () => {
  test('the session total matches what the provider charged, across four turns', async () => {
    const responses: ScriptedMockResponse[] = [
      {
        stopReason: 'tool_use',
        content: 'read a',
        toolCalls: [{ id: 'tc0', tool: 'file_read', parameters: { path: 'a.ts' } }],
        tokensUsed: { input: 1_000, output: 200 },
      },
      {
        stopReason: 'tool_use',
        content: 'read b',
        toolCalls: [{ id: 'tc1', tool: 'file_read', parameters: { path: 'b.ts' } }],
        tokensUsed: { input: 1_400, output: 300 },
      },
      {
        stopReason: 'tool_use',
        content: 'read c',
        toolCalls: [{ id: 'tc2', tool: 'file_read', parameters: { path: 'c.ts' } }],
        tokensUsed: { input: 1_800, output: 250 },
      },
      { stopReason: 'end_turn', content: 'done', toolCalls: [], tokensUsed: { input: 2_000, output: 400 } },
    ];
    const trueTotal = 1_000 + 200 + 1_400 + 300 + 1_800 + 250 + 2_000 + 400; // 7_350

    const { result } = await roundTrip(responses);

    expect(result.tokensConsumed).toBe(trueTotal);
    // The old cumulative-total contract reported 1_200 + 2_900 + 4_950 + 7_350.
    expect(result.tokensConsumed).toBeLessThan(16_400);
  });

  test('the input/output split survives the round trip and adds up to the total', async () => {
    const responses: ScriptedMockResponse[] = [
      {
        stopReason: 'tool_use',
        content: 'read a',
        toolCalls: [{ id: 'tc0', tool: 'file_read', parameters: { path: 'a.ts' } }],
        tokensUsed: { input: 1_000, output: 200 },
      },
      { stopReason: 'end_turn', content: 'done', toolCalls: [], tokensUsed: { input: 2_000, output: 400 } },
    ];

    const { result } = await roundTrip(responses);

    expect(result.tokensInput).toBe(3_000);
    expect(result.tokensOutput).toBe(600);
    expect((result.tokensInput ?? 0) + (result.tokensOutput ?? 0)).toBe(result.tokensConsumed);
  });

  test('cache tokens from non-terminal turns are not lost', async () => {
    const responses: ScriptedMockResponse[] = [
      {
        stopReason: 'tool_use',
        content: 'read a',
        toolCalls: [{ id: 'tc0', tool: 'file_read', parameters: { path: 'a.ts' } }],
        tokensUsed: { input: 1_000, output: 200, cacheRead: 30_000, cacheCreation: 5_000 },
      },
      {
        stopReason: 'end_turn',
        content: 'done',
        toolCalls: [],
        tokensUsed: { input: 2_000, output: 400, cacheRead: 31_000, cacheCreation: 0 },
      },
    ];

    const { result } = await roundTrip(responses);

    expect(result.cacheReadTokens).toBe(61_000);
    expect(result.cacheCreationTokens).toBe(5_000);
  });

  test('a single-turn session reports exactly that turn', async () => {
    const responses: ScriptedMockResponse[] = [
      { stopReason: 'end_turn', content: 'done', toolCalls: [], tokensUsed: { input: 900, output: 100 } },
    ];

    const { turns, result } = await roundTrip(responses);

    expect(turns).toHaveLength(1);
    expect(result.tokensConsumed).toBe(1_000);
    expect(result.tokensInput).toBe(900);
    expect(result.tokensOutput).toBe(100);
  });
});
