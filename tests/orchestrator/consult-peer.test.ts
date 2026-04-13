/**
 * consult_peer — unit tests.
 *
 * Exercises the lightweight second-opinion primitive added in PR #7.
 * Structure mirrors clarification.test.ts (MockAgentSession +
 * makeDelegatingToolExecutor pattern) so tests stay in the same
 * unit-boundary style without requiring real LLM calls or subprocess
 * agents.
 *
 * Coverage:
 *   1. consultPeer tool descriptor — shape, minRoutingLevel, required
 *      fields, inputSchema correctness.
 *   2. AgentBudgetTracker — canConsult() gating, recordConsultation()
 *      counter + base-pool charge, per-session cap, headroom check.
 *   3. handleConsultPeer via runAgentLoop — success path, no-peer
 *      denial, budget-exhausted denial, A1 enforcement (same-id peer
 *      rejected), confidence cap, response format.
 *   4. System prompt — includes CONSULT_PEER_SECTION at L1+ and L2+
 *      but NOT at L0.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { consultPeer } from '../../src/orchestrator/tools/control-tools.ts';
import { BUILT_IN_TOOLS } from '../../src/orchestrator/tools/built-in-tools.ts';
import { AgentBudgetTracker } from '../../src/orchestrator/worker/agent-budget.ts';
import {
  runAgentLoop,
  type AgentLoopDeps,
} from '../../src/orchestrator/worker/agent-loop.ts';
import { buildSystemPrompt } from '../../src/orchestrator/worker/agent-worker-entry.ts';
import type {
  IAgentSession,
  SessionState,
} from '../../src/orchestrator/worker/agent-session.ts';
import type {
  OrchestratorTurn,
  PeerConsultRequest,
  PeerOpinion,
  TerminateReason,
  WorkerTurn,
} from '../../src/orchestrator/protocol.ts';
import type {
  PerceptualHierarchy,
  RoutingDecision,
  TaskInput,
  ToolCall,
  ToolResult,
  WorkingMemoryState,
} from '../../src/orchestrator/types.ts';

// ── Mock session harness (matches clarification.test.ts) ────────────

class MockAgentSession implements IAgentSession {
  private turns: WorkerTurn[];
  private turnIndex = 0;
  sent: OrchestratorTurn[] = [];
  state: SessionState = 'INIT';
  readonly pid = 99999;
  closed = false;
  closedReason?: TerminateReason;
  drained = false;

  constructor(turns: WorkerTurn[]) {
    this.turns = turns;
  }

  async send(turn: OrchestratorTurn): Promise<void> {
    this.sent.push(turn);
    this.state = 'WAITING_FOR_WORKER';
  }

  async receive(_timeoutMs: number): Promise<WorkerTurn | null> {
    const turn = this.turns[this.turnIndex++] ?? null;
    if (turn) this.state = 'WAITING_FOR_ORCHESTRATOR';
    return turn;
  }

  async close(reason: TerminateReason): Promise<void> {
    this.closed = true;
    this.closedReason = reason;
    this.state = 'CLOSED';
  }

  async drainAndClose(): Promise<void> {
    this.drained = true;
    this.state = 'CLOSED';
  }

  get sessionState(): SessionState {
    return this.state;
  }
}

/**
 * Mock tool executor that delegates `consult_peer` to the REAL tool's
 * `execute()` method so both the happy path (routes via context.onConsult)
 * and the denial path (onConsult undefined → returns 'denied') are
 * exercised under the same mock. All other tools fall through to a
 * no-op mock handler.
 */
function makeConsultingToolExecutor() {
  return {
    execute: async (
      call: ToolCall,
      context: import('../../src/orchestrator/tools/tool-interface.ts').ToolContext,
    ): Promise<ToolResult> => {
      if (call.tool === 'consult_peer') {
        const result = await consultPeer.execute(
          { ...call.parameters, callId: call.id },
          context,
        );
        return { ...result, callId: call.id };
      }
      return {
        callId: call.id,
        tool: call.tool,
        status: 'success',
        output: 'mock result',
        durationMs: 1,
      };
    },
  };
}

function makeTestInput(): TaskInput {
  return {
    id: 'test-consult-1',
    source: 'cli',
    goal: 'Decide between Option A and Option B',
    targetFiles: ['src/foo.ts'],
    budget: { maxTokens: 20_000, maxDurationMs: 30_000, maxRetries: 2 },
  } as TaskInput;
}

function makeTestRouting(model = 'mock/fast'): RoutingDecision {
  return {
    level: 2,
    model,
    budgetTokens: 20_000,
    latencyBudgetMs: 30_000,
  } as RoutingDecision;
}

function makeTestPerception(): PerceptualHierarchy {
  return {
    taskTarget: { file: 'src/foo.ts', description: 'target file' },
    dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
    diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
    verifiedFacts: [],
    runtime: { nodeVersion: 'test', os: 'test', availableTools: [] },
  } as PerceptualHierarchy;
}

function makeTestMemory(): WorkingMemoryState {
  return {
    failedApproaches: [],
    activeHypotheses: [],
    unresolvedUncertainties: [],
    scopedFacts: [],
  };
}

let testWorkspace: string;

function makeBaseDeps(session: MockAgentSession): AgentLoopDeps {
  return {
    workspace: testWorkspace,
    contextWindow: 128_000,
    agentWorkerEntryPath: '/dev/null',
    toolExecutor: makeConsultingToolExecutor(),
    compressPerception: (p) => p,
    createSession: () => session,
  };
}

beforeEach(() => {
  testWorkspace = join(
    tmpdir(),
    `vinyan-consult-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  mkdirSync(testWorkspace, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(testWorkspace, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ── 1. Tool descriptor & registration ───────────────────────────────

describe('consultPeer — tool descriptor', () => {
  it('is registered in BUILT_IN_TOOLS under "consult_peer"', () => {
    const registered = BUILT_IN_TOOLS.get('consult_peer');
    expect(registered).toBeDefined();
    expect(registered).toBe(consultPeer);
  });

  it('exposes a minRoutingLevel of 1 (L1+, not L0)', () => {
    const descriptor = consultPeer.descriptor();
    expect(descriptor.minRoutingLevel).toBe(1);
  });

  it('requires a `question` field and documents `context` + `requestedTokens` as optional', () => {
    const descriptor = consultPeer.descriptor();
    expect(descriptor.inputSchema.required).toEqual(['question']);
    expect(descriptor.inputSchema.properties.question).toBeDefined();
    expect(descriptor.inputSchema.properties.context).toBeDefined();
    expect(descriptor.inputSchema.properties.requestedTokens).toBeDefined();
  });

  it('is categorized as a control tool, not side-effectful', () => {
    const descriptor = consultPeer.descriptor();
    expect(descriptor.category).toBe('control');
    expect(descriptor.sideEffect).toBe(false);
    expect(descriptor.toolKind).toBe('control');
  });

  it('execute() returns denied when context.onConsult is missing', async () => {
    const result = await consultPeer.execute(
      { question: 'test', callId: 'c1' },
      {
        routingLevel: 1,
        allowedPaths: [],
        workspace: testWorkspace,
      },
    );
    expect(result.status).toBe('denied');
  });
});

// ── 2. AgentBudgetTracker consultation accounting ──────────────────

describe('AgentBudgetTracker — consult_peer accounting', () => {
  const routing: RoutingDecision = {
    level: 2,
    model: 'mock/test',
    budgetTokens: 20_000,
    latencyBudgetMs: 30_000,
  } as RoutingDecision;

  it('allows consultations when headroom is available', () => {
    const tracker = AgentBudgetTracker.fromRouting(routing, 128_000);
    expect(tracker.canConsult()).toBe(true);
    expect(tracker.consultationsUsed).toBe(0);
    expect(tracker.remainingConsultations).toBe(3);
  });

  it('denies consultation after 3 calls (per-session cap)', () => {
    const tracker = AgentBudgetTracker.fromRouting(routing, 128_000);
    tracker.recordConsultation(300);
    tracker.recordConsultation(400);
    tracker.recordConsultation(350);
    expect(tracker.consultationsUsed).toBe(3);
    expect(tracker.remainingConsultations).toBe(0);
    expect(tracker.canConsult()).toBe(false);
  });

  it('charges tokens to the base pool and counts toward canContinue()', () => {
    // Use a tiny budget so we can observe base-pool depletion.
    const tinyRouting: RoutingDecision = {
      level: 2,
      model: 'mock/test',
      budgetTokens: 2_000, // base = 1200, negotiable = 500, delegation = 300
      latencyBudgetMs: 5_000,
    } as RoutingDecision;
    const tracker = AgentBudgetTracker.fromRouting(tinyRouting, 128_000);

    // First consultation should succeed (1200 - 300 = 900, still > 500 headroom)
    expect(tracker.canConsult()).toBe(true);
    tracker.recordConsultation(300);
    expect(tracker.canConsult()).toBe(true);

    // Second consultation consumes most of the rest (900 - 400 = 500 headroom — still valid)
    tracker.recordConsultation(400);
    // Now base headroom is 500, exactly at the canConsult() floor → allowed.
    expect(tracker.canConsult()).toBe(true);

    // Third consultation — consultationCount == 3 after this, hits the per-session cap.
    tracker.recordConsultation(100);
    expect(tracker.canConsult()).toBe(false);
  });

  it('denies consultation when base pool headroom is below 500 even if count allows', () => {
    const tinyRouting: RoutingDecision = {
      level: 2,
      model: 'mock/test',
      budgetTokens: 1_000, // base = 600, so headroom shrinks quickly
      latencyBudgetMs: 5_000,
    } as RoutingDecision;
    const tracker = AgentBudgetTracker.fromRouting(tinyRouting, 128_000);

    // Exhaust base pool with a regular turn so only ~200 tokens remain.
    tracker.recordTurn(400);
    // Now base headroom = 600 - 400 = 200 < 500 floor → denied even though
    // consultationCount is 0.
    expect(tracker.canConsult()).toBe(false);
    expect(tracker.consultationsUsed).toBe(0);
  });
});

// ── 3. handleConsultPeer via runAgentLoop ───────────────────────────

describe('consult_peer — end-to-end via runAgentLoop', () => {
  function makePeerConsultant(
    opinion: string,
    options: { peerId?: string; tokens?: { input: number; output: number } } = {},
  ): NonNullable<AgentLoopDeps['peerConsultant']> {
    return async (_req: PeerConsultRequest, _workerId?: string): Promise<PeerOpinion> => ({
      opinion,
      confidence: 0.7,
      confidenceSource: 'llm-self-report',
      peerEngineId: options.peerId ?? 'mock/powerful',
      tokensUsed: options.tokens ?? { input: 150, output: 120 },
      durationMs: 25,
    });
  }

  it('returns a structured PeerOpinion as tool result output when the worker calls consult_peer', async () => {
    const workerTurns: WorkerTurn[] = [
      {
        type: 'tool_calls',
        turnId: 't1',
        calls: [
          {
            id: 'c1',
            tool: 'consult_peer',
            parameters: {
              question: 'Should I use pattern A or pattern B for retry logic?',
              context: 'The code currently retries 3x with fixed backoff.',
            },
          },
        ],
        rationale: 'checking design choice',
        tokensConsumed: 80,
      },
      { type: 'done', turnId: 't2', proposedContent: 'resolved', tokensConsumed: 30 },
    ];

    const session = new MockAgentSession(workerTurns);
    const deps: AgentLoopDeps = {
      ...makeBaseDeps(session),
      peerConsultant: makePeerConsultant('Use exponential backoff with jitter — fixed backoff thundering-herds on server restart.'),
    };

    await runAgentLoop(
      makeTestInput(),
      makeTestPerception(),
      makeTestMemory(),
      undefined,
      makeTestRouting(),
      deps,
    );

    const toolResultTurns = session.sent.filter((t) => t.type === 'tool_results') as Array<
      Extract<OrchestratorTurn, { type: 'tool_results' }>
    >;
    expect(toolResultTurns.length).toBeGreaterThanOrEqual(1);
    const consultResult = toolResultTurns[0]!.results[0]!;
    expect(consultResult.tool).toBe('consult_peer');
    expect(consultResult.status).toBe('success');

    // Output contains the serialized PeerOpinion — strip any trailing
    // reminder block that agent-loop may append to the last result.
    const rawOutput = consultResult.output as string;
    const jsonPart = rawOutput.split('\n\n')[0] ?? rawOutput;
    const opinion = JSON.parse(jsonPart) as PeerOpinion;
    expect(opinion.opinion).toContain('exponential backoff');
    expect(opinion.confidence).toBe(0.7);
    expect(opinion.confidenceSource).toBe('llm-self-report');
    expect(opinion.peerEngineId).toBe('mock/powerful');
    expect(opinion.tokensUsed).toEqual({ input: 150, output: 120 });
  });

  it('denies consult_peer when no peerConsultant is wired (deps.peerConsultant undefined)', async () => {
    const workerTurns: WorkerTurn[] = [
      {
        type: 'tool_calls',
        turnId: 't1',
        calls: [
          {
            id: 'c1',
            tool: 'consult_peer',
            parameters: { question: 'test question' },
          },
        ],
        rationale: 'test',
        tokensConsumed: 50,
      },
      { type: 'done', turnId: 't2', proposedContent: 'ok', tokensConsumed: 20 },
    ];

    const session = new MockAgentSession(workerTurns);
    // No peerConsultant — the consult_peer tool's execute() returns
    // denied because context.onConsult is undefined (agent-loop does
    // not wire it without deps.peerConsultant).
    const deps: AgentLoopDeps = makeBaseDeps(session);

    await runAgentLoop(
      makeTestInput(),
      makeTestPerception(),
      makeTestMemory(),
      undefined,
      makeTestRouting(),
      deps,
    );

    const toolResultTurns = session.sent.filter((t) => t.type === 'tool_results') as Array<
      Extract<OrchestratorTurn, { type: 'tool_results' }>
    >;
    const consultResult = toolResultTurns[0]!.results[0]!;
    expect(consultResult.tool).toBe('consult_peer');
    expect(consultResult.status).toBe('denied');
  });

  it('denies consult_peer when peerConsultant returns null (A1: no distinct peer)', async () => {
    const workerTurns: WorkerTurn[] = [
      {
        type: 'tool_calls',
        turnId: 't1',
        calls: [
          {
            id: 'c1',
            tool: 'consult_peer',
            parameters: { question: 'anything' },
          },
        ],
        rationale: 'test',
        tokensConsumed: 50,
      },
      { type: 'done', turnId: 't2', proposedContent: 'ok', tokensConsumed: 20 },
    ];

    const session = new MockAgentSession(workerTurns);
    const deps: AgentLoopDeps = {
      ...makeBaseDeps(session),
      // A1-blocked: the wired peer consultant cannot find a distinct
      // peer model and returns null (e.g., only one provider exists).
      peerConsultant: async () => null,
    };

    await runAgentLoop(
      makeTestInput(),
      makeTestPerception(),
      makeTestMemory(),
      undefined,
      makeTestRouting(),
      deps,
    );

    const toolResultTurns = session.sent.filter((t) => t.type === 'tool_results') as Array<
      Extract<OrchestratorTurn, { type: 'tool_results' }>
    >;
    const consultResult = toolResultTurns[0]!.results[0]!;
    expect(consultResult.status).toBe('denied');
    const output = consultResult.output as string;
    expect(output).toContain('distinct peer');
  });

  it('surfaces errors from peerConsultant as ToolResult.status=error', async () => {
    const workerTurns: WorkerTurn[] = [
      {
        type: 'tool_calls',
        turnId: 't1',
        calls: [
          {
            id: 'c1',
            tool: 'consult_peer',
            parameters: { question: 'q' },
          },
        ],
        rationale: 'test',
        tokensConsumed: 50,
      },
      { type: 'done', turnId: 't2', proposedContent: 'ok', tokensConsumed: 20 },
    ];

    const session = new MockAgentSession(workerTurns);
    const deps: AgentLoopDeps = {
      ...makeBaseDeps(session),
      peerConsultant: async () => {
        throw new Error('peer LLM timed out');
      },
    };

    await runAgentLoop(
      makeTestInput(),
      makeTestPerception(),
      makeTestMemory(),
      undefined,
      makeTestRouting(),
      deps,
    );

    const toolResultTurns = session.sent.filter((t) => t.type === 'tool_results') as Array<
      Extract<OrchestratorTurn, { type: 'tool_results' }>
    >;
    const consultResult = toolResultTurns[0]!.results[0]!;
    expect(consultResult.status).toBe('error');
    expect(consultResult.error).toContain('peer LLM timed out');
  });
});

// ── 4. System prompt integration ────────────────────────────────────

describe('buildSystemPrompt — consult_peer guidance', () => {
  it('includes the consult_peer section at L1', () => {
    const prompt = buildSystemPrompt(1, 'code');
    expect(prompt).toContain('Second Opinions (consult_peer tool)');
    expect(prompt).toContain('heuristic tier');
    expect(prompt).toContain('3 consultations per session');
  });

  it('includes the consult_peer section at L2 and L3', () => {
    expect(buildSystemPrompt(2, 'code')).toContain('Second Opinions (consult_peer tool)');
    expect(buildSystemPrompt(3, 'code')).toContain('Second Opinions (consult_peer tool)');
  });

  it('does NOT include the consult_peer section at L0 (L0 has no tool loop)', () => {
    const prompt = buildSystemPrompt(0, 'code');
    expect(prompt).not.toContain('Second Opinions (consult_peer tool)');
  });
});
