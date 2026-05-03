/**
 * V5 — single-clamp coverage proof.
 *
 * Defends the load-bearing assertion behind STEP 1: the dispatch-time
 * clamp lives at exactly ONE site (`phase-generate.ts:129`) and covers
 * BOTH `worker:dispatch` emit points fired during a single L2+ task run:
 *
 *   - emit #1: `phase-generate.ts:129` (right before delegating to the
 *     L2 agent-loop branch)
 *   - emit #2: `agent-loop.ts:1252` (inside `runAgentLoop`, after the
 *     init turn is sent)
 *
 * The test wires a real `runAgentLoop` via the L2-with-agent-deps path
 * in `executeGeneratePhase` and uses an injected `createSession` to
 * bypass the worker subprocess. With `ctx.startTime` set in the past
 * (matching the architect-r1 incident shape), the test asserts:
 *
 *   1. Both emits fire (proving the test actually exercises both sites).
 *   2. Both emits carry the SAME `routing` object reference (proving
 *      `agent-loop.ts:1252` does not snapshot or rebuild routing — the
 *      single-site clamp at phase-generate flows verbatim through).
 *   3. The shared `routing.latencyBudgetMs` is clamped (matches the
 *      independent calculation against the synthetic `startTime`).
 *
 * If a future refactor reintroduces a routing snapshot inside the
 * agent-loop (e.g. cloning before emit, or deriving budget from
 * something other than the parameter reference), assertion #2 breaks
 * here BEFORE the bypass returns to production.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VinyanBus, VinyanBusEvents } from '../../src/core/bus.ts';
import type { AgentLoopDeps } from '../../src/orchestrator/agent/agent-loop.ts';
import type { IAgentSession, SessionState } from '../../src/orchestrator/agent/agent-session.ts';
import type { OrchestratorDeps } from '../../src/orchestrator/core-loop.ts';
import { executeGeneratePhase } from '../../src/orchestrator/phases/phase-generate.ts';
import type { PhaseContext } from '../../src/orchestrator/phases/types.ts';
import type { OrchestratorTurn, TerminateReason, WorkerTurn } from '../../src/orchestrator/protocol.ts';
import type {
  PerceptualHierarchy,
  RoutingDecision,
  SemanticTaskUnderstanding,
  TaskInput,
} from '../../src/orchestrator/types.ts';
import { WorkingMemory } from '../../src/orchestrator/working-memory.ts';

interface RecordedEmit {
  type: keyof VinyanBusEvents;
  payload: unknown;
}

function makeBus(events: RecordedEmit[]): VinyanBus {
  return {
    emit: (type: keyof VinyanBusEvents, payload: unknown) => {
      events.push({ type, payload });
    },
    on: () => {},
    off: () => {},
  } as unknown as VinyanBus;
}

/**
 * Mock session — replays a single `done` turn so `runAgentLoop` exits
 * cleanly after firing its worker:dispatch emit.
 */
class StubAgentSession implements IAgentSession {
  state: SessionState = 'INIT';
  readonly pid = 0;
  readonly sent: OrchestratorTurn[] = [];
  private delivered = false;

  async send(turn: OrchestratorTurn): Promise<void> {
    this.sent.push(turn);
    this.state = 'WAITING_FOR_WORKER';
  }

  async receive(_timeoutMs: number): Promise<WorkerTurn | null> {
    if (this.delivered) return null;
    this.delivered = true;
    this.state = 'WAITING_FOR_ORCHESTRATOR';
    return {
      type: 'done',
      turnId: 'd1',
      proposedContent: 'ok',
      tokensConsumed: 1,
    } as WorkerTurn;
  }

  async close(_reason: TerminateReason): Promise<void> {
    this.state = 'CLOSED';
  }

  async drainAndClose(): Promise<void> {
    this.state = 'CLOSED';
  }

  get sessionState(): SessionState {
    return this.state;
  }
}

function buildAgentLoopDeps(workspace: string, bus: VinyanBus, session: StubAgentSession): AgentLoopDeps {
  return {
    workspace,
    contextWindow: 128_000,
    agentWorkerEntryPath: '/dev/null', // bypassed by createSession
    toolExecutor: {
      async execute(call) {
        return { callId: call.id, tool: call.tool, status: 'success', output: '', durationMs: 1 };
      },
    },
    compressPerception: (p) => p,
    bus,
    createSession: () => session,
  };
}

function makeUnderstanding(): SemanticTaskUnderstanding {
  return {
    taskDomain: 'code-mutation',
    taskIntent: 'execute',
    toolRequirement: 'no-tools',
    resolvedEntities: [],
    understandingDepth: 0,
    verifiedClaims: [],
    understandingFingerprint: 'test-fingerprint',
  } as unknown as SemanticTaskUnderstanding;
}

function makePerception(): PerceptualHierarchy {
  return {
    taskTarget: { file: 'src/foo.ts', description: 'test' },
    dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
    diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
    verifiedFacts: [],
  } as unknown as PerceptualHierarchy;
}

function makeInput(maxDurationMs: number): TaskInput {
  return {
    id: 'test-single-clamp-coverage',
    source: 'cli',
    goal: 'verify single-site clamp covers both worker:dispatch emits',
    taskType: 'code',
    budget: { maxTokens: 10_000, maxDurationMs, maxRetries: 1 },
  };
}

function makeRouting(latencyBudgetMs: number): RoutingDecision {
  return { level: 2, model: 'mock/m', budgetTokens: 10_000, latencyBudgetMs };
}

describe('Single-clamp coverage — phase-generate emit + agent-loop emit see the same clamped routing', () => {
  test('both worker:dispatch emits in one L2 task run carry an identical, clamped routing reference', async () => {
    // Synthetic past startTime so the dispatch-site clamp produces a
    // value distinct from the input latencyBudgetMs (otherwise both
    // emits trivially equal the input and the assertion is uninformative).
    const startTime = Date.now() - 30_000; // 30s elapsed of a 60s budget
    const inputBudgetMs = 60_000;

    const events: RecordedEmit[] = [];
    const bus = makeBus(events);
    const workspace = mkdtempSync(join(tmpdir(), 'vinyan-budget-clamp-'));
    mkdirSync(workspace, { recursive: true });

    try {
      const session = new StubAgentSession();
      const agentLoopDeps = buildAgentLoopDeps(workspace, bus, session);

      const workerPool = {
        async dispatch() {
          throw new Error('not expected to be called on the L2 agent-loop path');
        },
        getAgentLoopDeps: () => agentLoopDeps,
      };

      const deps = {
        bus,
        workerPool,
        traceCollector: { record: async () => {} },
      } as unknown as OrchestratorDeps;

      const ctx: PhaseContext = {
        input: makeInput(inputBudgetMs),
        deps,
        startTime,
        workingMemory: new WorkingMemory(),
        explorationFlag: false,
      };

      await executeGeneratePhase(ctx, {
        routing: makeRouting(60_000), // way over remaining wall-clock
        perception: makePerception(),
        understanding: makeUnderstanding(),
        plan: undefined,
        totalTokensConsumed: 0,
        budgetCapMultiplier: 6,
        retry: 0,
      });

      const dispatchEmits = events.filter((e) => e.type === 'worker:dispatch');
      // (1) Both emits actually fired — proves the test really exercised
      // BOTH sites and is not silently passing because one was skipped.
      expect(dispatchEmits.length).toBe(2);

      const phaseGenerateEmit = dispatchEmits[0]!.payload as { taskId: string; routing: RoutingDecision };
      const agentLoopEmit = dispatchEmits[1]!.payload as { taskId: string; routing: RoutingDecision };

      // (2) Identity check — the agent-loop emit carries the SAME routing
      // object reference that phase-generate clamped. If a future change
      // reintroduces a snapshot/clone inside agent-loop, this breaks.
      expect(agentLoopEmit.routing).toBe(phaseGenerateEmit.routing);

      // (3) Value check — the shared routing has been clamped.
      // remaining = 60000 - 30000 = 30000; usable = 30000 - 250 = 29750
      // Both emits should report well under the original 60_000ms.
      expect(phaseGenerateEmit.routing.latencyBudgetMs).toBeLessThanOrEqual(29_750);
      expect(agentLoopEmit.routing.latencyBudgetMs).toBe(phaseGenerateEmit.routing.latencyBudgetMs);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
