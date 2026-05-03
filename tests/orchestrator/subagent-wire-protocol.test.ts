/**
 * Phase 2.8 — sub-agent wire-protocol tests.
 *
 * Three load-bearing claims:
 *
 *   1. Round-trip — when agent-loop's input has `parentTaskId` set, the
 *      OrchestratorTurn 'init' it sends carries `subAgentId === input.id`,
 *      and an audit-entry payload stamped via `stampSubAgentId(initSubAgentId, …)`
 *      ends up with that value.
 *
 *   2. Backward-compat — an older orchestrator that omits `subAgentId`
 *      on init does NOT crash the subprocess; the entry returns
 *      untouched and the missing-counter increments so an operator can
 *      detect version skew.
 *
 *   3. Idempotency — when the entry already carries a subAgentId (e.g.
 *      pre-stamped by the orchestrator's hierarchyFromInput), the
 *      subprocess does NOT overwrite it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBus, type VinyanBus } from '../../src/core/bus.ts';
import { type AgentLoopDeps, runAgentLoop } from '../../src/orchestrator/agent/agent-loop.ts';
import type { IAgentSession, SessionState } from '../../src/orchestrator/agent/agent-session.ts';
import {
  getMissingSubAgentIdCount,
  resetMissingSubAgentIdCount,
  stampSubAgentId,
} from '../../src/orchestrator/observability/subagent-stamp.ts';
import type { OrchestratorTurn, TerminateReason, WorkerTurn } from '../../src/orchestrator/protocol.ts';
import type {
  PerceptualHierarchy,
  RoutingDecision,
  TaskInput,
  ToolCall,
  ToolResult,
  WorkingMemoryState,
} from '../../src/orchestrator/types.ts';

class MockAgentSession implements IAgentSession {
  private turns: WorkerTurn[];
  private idx = 0;
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
  async receive(_t: number): Promise<WorkerTurn | null> {
    const t = this.turns[this.idx++] ?? null;
    if (t) this.state = 'WAITING_FOR_ORCHESTRATOR';
    return t;
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

function makeInput(over: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 'task-x',
    source: 'test',
    goal: 'subagent wire smoke',
    targetFiles: ['src/foo.ts'],
    budget: { maxTokens: 10_000, maxDurationMs: 30_000, maxRetries: 1 },
    ...over,
  } as unknown as TaskInput;
}

function makeRouting(): RoutingDecision {
  return {
    level: 2,
    model: 'test-model',
    workerId: 'worker-x',
    budgetTokens: 10_000,
    latencyBudgetMs: 30_000,
  } as RoutingDecision;
}

function makePerception(): PerceptualHierarchy {
  return {
    taskTarget: { file: 'src/foo.ts', description: 'target' },
    dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
    diagnostics: { lintWarnings: [], typeErrors: [], testFailures: [] },
    verifiedFacts: [],
    runtime: {},
  } as unknown as PerceptualHierarchy;
}

function makeMemory(): WorkingMemoryState {
  return {
    failedApproaches: [],
    activeHypotheses: [],
    unresolvedUncertainties: [],
    scopedFacts: [],
  };
}

function defaultExecutor() {
  return {
    execute: async (call: ToolCall): Promise<ToolResult> => ({
      callId: call.id,
      tool: call.tool,
      status: 'success',
      output: 'ok',
      durationMs: 1,
    }),
  };
}

let workspace: string;

function makeDeps(session: MockAgentSession, bus: VinyanBus): AgentLoopDeps {
  return {
    workspace,
    contextWindow: 128_000,
    agentWorkerEntryPath: '/dev/null',
    toolExecutor: defaultExecutor(),
    compressPerception: (p) => p,
    createSession: () => session,
    bus,
  };
}

beforeEach(() => {
  workspace = join(tmpdir(), `vinyan-subagent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(workspace, { recursive: true });
  resetMissingSubAgentIdCount();
});

afterEach(() => {
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('agent-loop init turn — subAgentId injection', () => {
  it('root task: input.parentTaskId absent → init turn omits subAgentId', async () => {
    const turns: WorkerTurn[] = [{ type: 'done', turnId: 't1', proposedContent: 'ok', tokensConsumed: 10 }];
    const session = new MockAgentSession(turns);
    const bus = createBus();
    const deps = makeDeps(session, bus);
    await runAgentLoop(makeInput(), makePerception(), makeMemory(), undefined, makeRouting(), deps);

    const initTurn = session.sent.find((t) => t.type === 'init');
    expect(initTurn).toBeDefined();
    if (initTurn?.type !== 'init') throw new Error('expected init turn');
    expect(initTurn.subAgentId).toBeUndefined();
  });

  it('sub-task: input.parentTaskId present → init turn carries subAgentId === input.id', async () => {
    const turns: WorkerTurn[] = [{ type: 'done', turnId: 't1', proposedContent: 'ok', tokensConsumed: 10 }];
    const session = new MockAgentSession(turns);
    const bus = createBus();
    const deps = makeDeps(session, bus);
    const input = makeInput({
      id: 'parent-A-delegate-step1',
      parentTaskId: 'parent-A',
      sessionId: 'sess-1',
    });
    await runAgentLoop(input, makePerception(), makeMemory(), undefined, makeRouting(), deps);

    const initTurn = session.sent.find((t) => t.type === 'init');
    if (initTurn?.type !== 'init') throw new Error('expected init turn');
    expect(initTurn.subAgentId).toBe(input.id);
  });
});

describe('stampSubAgentId — back-compat fallback', () => {
  it('when init carried subAgentId, stamps it on the entry', () => {
    const initSubAgentId = 'parent-A-delegate-step1';
    const entry: Record<string, unknown> = { id: 'audit-1', kind: 'thought', content: 'x' };
    const out = stampSubAgentId(initSubAgentId, entry);
    expect(out).toEqual({ ...entry, subAgentId: initSubAgentId });
    expect(getMissingSubAgentIdCount()).toBe(0);
  });

  it('when init did NOT carry subAgentId, returns entry untouched + bumps counter (no crash)', () => {
    const entry: Record<string, unknown> = { id: 'audit-1', kind: 'thought', content: 'x' };
    const out1 = stampSubAgentId(undefined, entry);
    const out2 = stampSubAgentId(undefined, entry);
    expect(out1).toBe(entry);
    expect(out2).toBe(entry);
    expect(getMissingSubAgentIdCount()).toBe(2);
  });

  it('idempotent: pre-stamped subAgentId is preserved (no overwrite)', () => {
    const entry: Record<string, unknown> = {
      id: 'audit-1',
      kind: 'thought',
      content: 'x',
      subAgentId: 'pre-stamped',
    };
    const out = stampSubAgentId('different-init-value', entry);
    expect(out).toBe(entry);
    expect(out.subAgentId).toBe('pre-stamped');
  });

  it('round-trip: orchestrator-side hierarchyFromInput emit + subprocess stamp produce the same scope', () => {
    // The parent agent-loop's own audit:entry rows already carry
    // subAgentId via hierarchyFromInput when input.parentTaskId is set
    // (P2.3). The subprocess wire-protocol guarantees the SAME scoping
    // from the subprocess side without depending on payload duplication.
    // We assert the equality at the helper level.
    const subTaskId = 'parent-A-delegate-step1';
    const orchestratorEmit: Record<string, unknown> = {
      id: 'a-1',
      kind: 'thought',
      content: 'x',
      subAgentId: subTaskId,
    };
    const subprocessStamp = stampSubAgentId(subTaskId, {
      id: 'a-2',
      kind: 'thought',
      content: 'y',
    } as Record<string, unknown>);
    expect(orchestratorEmit.subAgentId).toBe(subprocessStamp.subAgentId);
  });
});
