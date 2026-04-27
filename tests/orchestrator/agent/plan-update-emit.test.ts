/**
 * agent-loop → bus.emit('agent:plan_update') wiring test.
 *
 * The autonomous worker installs/refreshes its plan via the `plan_update`
 * control tool, which calls `context.onPlanUpdate(todos)`. agent-loop binds
 * that callback to `SessionProgress.recordPlanUpdate` and, on a successful
 * update, must re-emit `agent:plan_update` on the bus so the chat UI's
 * streaming-turn reducer can refresh its checklist. Without this emit the
 * UI sees only the initial plan snapshot (or nothing) and the user perceives
 * the agent as silent — even though it is actively progressing.
 *
 * This test exercises the binding by:
 *   1. Driving runAgentLoop with a worker turn that issues a plan_update
 *      tool call and a follow-up `done` turn.
 *   2. Wiring a tool executor that invokes `context.onPlanUpdate` (mirrors
 *      what the real ToolRouter does for control tools).
 *   3. Capturing bus events and asserting an `agent:plan_update` was emitted
 *      with the correct taskId and a status mapping that matches the UI's
 *      reducer ('in_progress' → 'running', 'completed' → 'done').
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBus, type VinyanBus } from '../../../src/core/bus.ts';
import {
  runAgentLoop,
  type AgentLoopDeps,
} from '../../../src/orchestrator/agent/agent-loop.ts';
import type {
  IAgentSession,
  SessionState,
} from '../../../src/orchestrator/agent/agent-session.ts';
import type {
  OrchestratorTurn,
  TerminateReason,
  WorkerTurn,
} from '../../../src/orchestrator/protocol.ts';
import type { ToolContext } from '../../../src/orchestrator/tools/tool-interface.ts';
import type {
  PerceptualHierarchy,
  RoutingDecision,
  TaskInput,
  ToolCall,
  ToolResult,
  WorkingMemoryState,
} from '../../../src/orchestrator/types.ts';

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
 * Tool executor that routes `plan_update` through the real
 * `context.onPlanUpdate` callback (which agent-loop wires to
 * `SessionProgress.recordPlanUpdate` + `bus.emit`). All other tools
 * fall through to a generic success response.
 */
function makePlanUpdateExecutor() {
  return {
    execute: async (call: ToolCall, context: ToolContext): Promise<ToolResult> => {
      if (call.tool === 'plan_update' && context.onPlanUpdate) {
        const todos = (call.parameters as { todos?: unknown }).todos as Parameters<
          NonNullable<ToolContext['onPlanUpdate']>
        >[0];
        const result = context.onPlanUpdate(todos);
        return {
          callId: call.id,
          tool: call.tool,
          status: result.ok ? 'success' : 'error',
          output: result.ok ? `plan updated (${result.count} items)` : result.error,
          durationMs: 1,
        };
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

function makeInput(): TaskInput {
  return {
    id: 'test-plan-emit-1',
    source: 'cli',
    goal: 'Refactor helper',
    targetFiles: ['src/foo.ts'],
    budget: { maxTokens: 10_000, maxDurationMs: 30_000, maxRetries: 2 },
  } as TaskInput;
}

function makeRouting(): RoutingDecision {
  return {
    level: 2,
    model: 'test-model',
    budgetTokens: 10_000,
    latencyBudgetMs: 30_000,
  } as RoutingDecision;
}

function makePerception(): PerceptualHierarchy {
  return {
    taskTarget: { file: 'src/foo.ts', description: 'target file' },
    dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
    diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
    verifiedFacts: [],
    runtime: { nodeVersion: 'test', os: 'test', availableTools: [] },
  } as PerceptualHierarchy;
}

function makeMemory(): WorkingMemoryState {
  return {
    failedApproaches: [],
    activeHypotheses: [],
    unresolvedUncertainties: [],
    scopedFacts: [],
  };
}

let testWorkspace: string;

function makeDeps(session: MockAgentSession, bus: VinyanBus): AgentLoopDeps {
  return {
    workspace: testWorkspace,
    contextWindow: 128_000,
    agentWorkerEntryPath: '/dev/null',
    // Bypass the bootstrap precondition check; createSession is used instead
    // of actually spawning a subprocess, so this socket path is never opened.
    proxySocketPath: '/tmp/vinyan-test.sock',
    toolExecutor: makePlanUpdateExecutor(),
    compressPerception: (p) => p,
    createSession: () => session,
    bus,
  };
}

beforeEach(() => {
  testWorkspace = join(
    tmpdir(),
    `vinyan-plan-emit-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  mkdirSync(testWorkspace, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(testWorkspace, { recursive: true, force: true });
  } catch {
    /* ignore cleanup errors */
  }
});

describe("agent-loop emits 'agent:plan_update' after a successful plan_update tool call", () => {
  it('emits with the taskId and the UI-shaped step list', async () => {
    const todos = [
      { content: 'Read foo.ts', activeForm: 'Reading foo.ts', status: 'completed' },
      { content: 'Rename helper', activeForm: 'Renaming helper', status: 'in_progress' },
      { content: 'Run tests', activeForm: 'Running tests', status: 'pending' },
    ];
    const workerTurns: WorkerTurn[] = [
      {
        type: 'tool_calls',
        turnId: 't1',
        rationale: 'install plan',
        calls: [
          {
            id: 'call-1',
            tool: 'plan_update',
            parameters: { todos },
          } as ToolCall,
        ],
        tokensConsumed: 50,
      },
      { type: 'done', turnId: 't2', proposedContent: 'finished', tokensConsumed: 10 },
    ];

    const bus = createBus();
    const captured: Array<{ taskId: string; steps: unknown[] }> = [];
    bus.on('agent:plan_update', (payload) => captured.push(payload));

    const session = new MockAgentSession(workerTurns);
    await runAgentLoop(
      makeInput(),
      makePerception(),
      makeMemory(),
      undefined,
      makeRouting(),
      makeDeps(session, bus),
    );

    expect(captured.length).toBeGreaterThanOrEqual(1);
    const last = captured[captured.length - 1]!;
    expect(last.taskId).toBe('test-plan-emit-1');
    expect(last.steps).toHaveLength(3);

    const steps = last.steps as Array<{ id: string; label: string; status: string }>;
    // Status mapping: completed → done, in_progress → running, pending → pending
    expect(steps[0]).toMatchObject({ label: 'Read foo.ts', status: 'done' });
    expect(steps[1]).toMatchObject({ label: 'Renaming helper', status: 'running' });
    expect(steps[2]).toMatchObject({ label: 'Run tests', status: 'pending' });
    // ids must be stringified (UI key)
    for (const s of steps) expect(typeof s.id).toBe('string');
  });

  it('does NOT emit when the plan_update payload is rejected (validation failure)', async () => {
    // Two in_progress items → recordPlanUpdate returns ok:false; bus must stay quiet.
    const badTodos = [
      { content: 'A', activeForm: 'Doing A', status: 'in_progress' },
      { content: 'B', activeForm: 'Doing B', status: 'in_progress' },
    ];
    const workerTurns: WorkerTurn[] = [
      {
        type: 'tool_calls',
        turnId: 't1',
        rationale: 'install plan',
        calls: [
          {
            id: 'call-1',
            tool: 'plan_update',
            parameters: { todos: badTodos },
          } as ToolCall,
        ],
        tokensConsumed: 50,
      },
      { type: 'done', turnId: 't2', proposedContent: 'finished', tokensConsumed: 10 },
    ];

    const bus = createBus();
    const captured: unknown[] = [];
    bus.on('agent:plan_update', (payload) => captured.push(payload));

    const session = new MockAgentSession(workerTurns);
    await runAgentLoop(
      makeInput(),
      makePerception(),
      makeMemory(),
      undefined,
      makeRouting(),
      makeDeps(session, bus),
    );

    expect(captured).toHaveLength(0);
  });
});
