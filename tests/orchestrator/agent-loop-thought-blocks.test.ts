/**
 * agent-loop thought-block boundary — behavior tests.
 *
 * Covers PR-5 of the A8 audit redesign: one `kind:'thought'` AuditEntry
 * per logical thought block. The boundaries are:
 *
 *   1. Each `tool_calls` turn whose rationale is meaningful
 *      (`!== 'Tool execution'`) emits ONE thought entry with
 *      `trigger: 'pre-tool'`.
 *   2. An `uncertain` terminal carrying a `reason` emits ONE thought
 *      entry with `trigger: 'reflect'` — safety net for runs that end
 *      without a tool_calls turn.
 *   3. A `done` turn emits NO thought entry (the final answer is its
 *      own audit kind, landed in PR-6).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEntry } from '../../src/core/audit.ts';
import { createBus, type VinyanBus } from '../../src/core/bus.ts';
import { type AgentLoopDeps, runAgentLoop } from '../../src/orchestrator/agent/agent-loop.ts';
import type { IAgentSession, SessionState } from '../../src/orchestrator/agent/agent-session.ts';
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

function makeInput(): TaskInput {
  return {
    id: 'task-thoughts-1',
    source: 'test',
    goal: 'thoughts boundary smoke',
    targetFiles: ['src/foo.ts'],
    budget: { maxTokens: 10_000, maxDurationMs: 30_000, maxRetries: 1 },
  } as unknown as TaskInput;
}

function makeRouting(): RoutingDecision {
  return {
    level: 2,
    model: 'test-model',
    workerId: 'worker-thoughts',
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
  return { failedApproaches: [], activeHypotheses: [], unresolvedUncertainties: [], scopedFacts: [] };
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

function captureAudit(bus: VinyanBus): AuditEntry[] {
  const out: AuditEntry[] = [];
  bus.on('audit:entry', (e) => out.push(e));
  return out;
}

beforeEach(() => {
  workspace = join(tmpdir(), `vinyan-thoughts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('agent-loop thought-block emit', () => {
  it('N tool_calls turns with meaningful rationale → N pre-tool thought entries', async () => {
    const turns: WorkerTurn[] = [
      {
        type: 'tool_calls',
        turnId: 't1',
        rationale: 'Reading the file to understand structure',
        calls: [{ id: 'c1', tool: 'file_read', parameters: { path: 'src/foo.ts' } }],
        tokensConsumed: 30,
      },
      {
        type: 'tool_calls',
        turnId: 't2',
        rationale: 'Looking for callers of the function',
        calls: [{ id: 'c2', tool: 'file_read', parameters: { path: 'src/bar.ts' } }],
        tokensConsumed: 30,
      },
      {
        type: 'tool_calls',
        turnId: 't3',
        rationale: 'Drafting the fix',
        calls: [{ id: 'c3', tool: 'file_read', parameters: { path: 'src/baz.ts' } }],
        tokensConsumed: 30,
      },
      { type: 'done', turnId: 't4', proposedContent: 'fix proposed', tokensConsumed: 20 },
    ];
    const bus = createBus();
    const audits = captureAudit(bus);
    const deps = makeDeps(new MockAgentSession(turns), bus);

    await runAgentLoop(makeInput(), makePerception(), makeMemory(), undefined, makeRouting(), deps);

    const thoughts = audits.filter((e) => e.kind === 'thought');
    expect(thoughts.length).toBe(3);
    for (const t of thoughts) {
      if (t.kind !== 'thought') throw new Error('expected thought');
      expect(t.trigger).toBe('pre-tool');
      expect(t.actor.type).toBe('worker');
      expect(t.actor.id).toBe('worker-thoughts');
    }
    expect((thoughts[0] as Extract<AuditEntry, { kind: 'thought' }>).content).toContain('Reading the file');
    expect((thoughts[1] as Extract<AuditEntry, { kind: 'thought' }>).content).toContain('callers');
    expect((thoughts[2] as Extract<AuditEntry, { kind: 'thought' }>).content).toContain('Drafting');
  });

  it('rationale "Tool execution" suppresses the thought entry (not meaningful)', async () => {
    const turns: WorkerTurn[] = [
      {
        type: 'tool_calls',
        turnId: 't1',
        rationale: 'Tool execution',
        calls: [{ id: 'c1', tool: 'file_read', parameters: { path: 'src/foo.ts' } }],
        tokensConsumed: 30,
      },
      { type: 'done', turnId: 't2', proposedContent: 'ok', tokensConsumed: 10 },
    ];
    const bus = createBus();
    const audits = captureAudit(bus);
    const deps = makeDeps(new MockAgentSession(turns), bus);

    await runAgentLoop(makeInput(), makePerception(), makeMemory(), undefined, makeRouting(), deps);

    const thoughts = audits.filter((e) => e.kind === 'thought');
    expect(thoughts.length).toBe(0);
  });

  it('uncertain terminal with reason → 1 reflect thought (safety net)', async () => {
    const turns: WorkerTurn[] = [
      {
        type: 'uncertain',
        turnId: 't1',
        reason: "I don't have enough information to fix this without running tests",
        uncertainties: ['untested'],
        tokensConsumed: 30,
      },
    ];
    const bus = createBus();
    const audits = captureAudit(bus);
    const deps = makeDeps(new MockAgentSession(turns), bus);

    await runAgentLoop(makeInput(), makePerception(), makeMemory(), undefined, makeRouting(), deps);

    const thoughts = audits.filter((e) => e.kind === 'thought');
    expect(thoughts.length).toBe(1);
    if (thoughts[0]?.kind !== 'thought') throw new Error('expected thought');
    expect(thoughts[0].trigger).toBe('reflect');
    expect(thoughts[0].content).toContain("don't have enough information");
  });

  it('done turn alone → 0 thought entries (final answer is not a thought)', async () => {
    const turns: WorkerTurn[] = [{ type: 'done', turnId: 't1', proposedContent: 'all done', tokensConsumed: 10 }];
    const bus = createBus();
    const audits = captureAudit(bus);
    const deps = makeDeps(new MockAgentSession(turns), bus);

    await runAgentLoop(makeInput(), makePerception(), makeMemory(), undefined, makeRouting(), deps);

    const thoughts = audits.filter((e) => e.kind === 'thought');
    expect(thoughts.length).toBe(0);
  });
});
