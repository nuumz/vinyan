/**
 * agent-loop AuditEntry emit sites — behavior tests.
 *
 * Covers the four sites wired in PR-3 of the A8 audit redesign:
 *
 *   1. Successful tool execution → kind:'tool_call', lifecycle:'executed'
 *   2. Failed tool execution     → kind:'tool_call', lifecycle:'failed'
 *   3. Contract deny             → kind:'decision', ruleId starts 'contract:'
 *   4. Permission DSL deny       → kind:'decision', ruleId starts 'dsl:' or operator-supplied
 *   5. PreToolUse hook deny      → kind:'decision', ruleId === 'hook:PreToolUse'
 *
 * The legacy events (`agent:tool_started`, `agent:tool_executed`,
 * `agent:tool_denied`) MUST keep firing alongside the new audit entries —
 * the manifest path through the projection still consumes those.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentContract } from '../../src/core/agent-contract.ts';
import { AUDIT_SCHEMA_VERSION, type AuditEntry } from '../../src/core/audit.ts';
import { createBus, type VinyanBus } from '../../src/core/bus.ts';
import { type AgentLoopDeps, runAgentLoop } from '../../src/orchestrator/agent/agent-loop.ts';
import type { IAgentSession, SessionState } from '../../src/orchestrator/agent/agent-session.ts';
import { HookConfigSchema } from '../../src/orchestrator/hooks/hook-schema.ts';
import { PermissionConfigSchema } from '../../src/orchestrator/permissions/permission-schema.ts';
import type { OrchestratorTurn, TerminateReason, WorkerTurn } from '../../src/orchestrator/protocol.ts';
import type { ToolContext } from '../../src/orchestrator/tools/tool-interface.ts';
import type {
  PerceptualHierarchy,
  RoutingDecision,
  TaskInput,
  ToolCall,
  ToolResult,
  WorkingMemoryState,
} from '../../src/orchestrator/types.ts';

// ── Mock AgentSession (no subprocess) ────────────────────────────────

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

// ── Test fixtures ────────────────────────────────────────────────────

function makeInput(over: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 'task-audit-1',
    source: 'test',
    goal: 'audit emit smoke',
    targetFiles: ['src/foo.ts'],
    budget: { maxTokens: 10_000, maxDurationMs: 30_000, maxRetries: 1 },
    ...over,
  } as unknown as TaskInput;
}

function makeRouting(): RoutingDecision {
  return {
    level: 2,
    model: 'test-model',
    workerId: 'worker-test-1',
    budgetTokens: 10_000,
    latencyBudgetMs: 30_000,
  } as RoutingDecision;
}

function makePerception(): PerceptualHierarchy {
  return {
    taskTarget: { file: 'src/foo.ts', description: 'target file' },
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

function makeMockExecutor(handler?: (call: ToolCall, ctx: ToolContext) => Promise<ToolResult>) {
  const fallback = async (call: ToolCall): Promise<ToolResult> => ({
    callId: call.id,
    tool: call.tool,
    status: 'success',
    output: 'ok',
    durationMs: 1,
  });
  return { execute: handler ?? fallback };
}

/**
 * L1 contract — no `file_write`, no `shell_exec` — used for the
 * "contract deny" test so attempting `file_write` produces a deny.
 */
function makeReadOnlyContract(input: TaskInput, routing: RoutingDecision): AgentContract {
  return {
    taskId: input.id,
    routingLevel: routing.level,
    tokenBudget: 10_000,
    timeLimitMs: 30_000,
    maxToolCalls: 5,
    maxToolCallsPerTurn: 5,
    maxTurns: 15,
    maxEscalations: 3,
    capabilities: [{ type: 'file_read', paths: ['**'] }],
    onViolation: 'warn_then_kill',
    violationTolerance: 2,
    issuedAt: Date.now(),
    immutable: true,
  };
}

let workspace: string;

function makeDeps(session: MockAgentSession, bus: VinyanBus, overrides?: Partial<AgentLoopDeps>): AgentLoopDeps {
  return {
    workspace,
    contextWindow: 128_000,
    agentWorkerEntryPath: '/dev/null',
    toolExecutor: makeMockExecutor(),
    compressPerception: (p) => p,
    createSession: () => session,
    bus,
    ...overrides,
  };
}

function captureAuditEntries(bus: VinyanBus): AuditEntry[] {
  const entries: AuditEntry[] = [];
  bus.on('audit:entry', (entry) => entries.push(entry));
  return entries;
}

beforeEach(() => {
  workspace = join(tmpdir(), `vinyan-audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* ignore cleanup errors */
  }
});

// ── Tests ────────────────────────────────────────────────────────────

describe('agent-loop audit emits — tool execution lifecycle', () => {
  it('successful tool exec produces a tool_call audit entry with lifecycle=executed', async () => {
    const turns: WorkerTurn[] = [
      {
        type: 'tool_calls',
        turnId: 't-exec-1',
        calls: [{ id: 'c1', tool: 'file_read', parameters: { path: 'src/foo.ts' } }],
        rationale: 'reading foo',
        tokensConsumed: 50,
      },
      { type: 'done', turnId: 't-exec-2', tokensConsumed: 10 },
    ];
    const session = new MockAgentSession(turns);
    const bus = createBus();
    const audits = captureAuditEntries(bus);
    const deps = makeDeps(session, bus, {
      toolExecutor: makeMockExecutor(async (call) => ({
        callId: call.id,
        tool: call.tool,
        status: 'success',
        output: 'file contents here',
        durationMs: 5,
      })),
    });

    await runAgentLoop(makeInput(), makePerception(), makeMemory(), undefined, makeRouting(), deps);

    const toolCallEntries = audits.filter((e) => e.kind === 'tool_call');
    expect(toolCallEntries.length).toBe(1);
    const entry = toolCallEntries[0];
    expect(entry?.kind).toBe('tool_call');
    if (entry?.kind !== 'tool_call') return;
    expect(entry.lifecycle).toBe('executed');
    expect(entry.toolId).toBe('file_read');
    expect(entry.argsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.actor.type).toBe('worker');
    expect(entry.actor.id).toBe('worker-test-1');
    expect(entry.taskId).toBe('task-audit-1');
    expect(typeof entry.latencyMs).toBe('number');
  });

  it('failed tool exec produces a tool_call audit entry with lifecycle=failed', async () => {
    const turns: WorkerTurn[] = [
      {
        type: 'tool_calls',
        turnId: 't-fail-1',
        calls: [{ id: 'c1', tool: 'file_read', parameters: { path: 'src/missing.ts' } }],
        rationale: 'reading missing',
        tokensConsumed: 50,
      },
      { type: 'done', turnId: 't-fail-2', tokensConsumed: 10 },
    ];
    const session = new MockAgentSession(turns);
    const bus = createBus();
    const audits = captureAuditEntries(bus);
    const deps = makeDeps(session, bus, {
      toolExecutor: makeMockExecutor(async (call) => ({
        callId: call.id,
        tool: call.tool,
        status: 'error',
        error: 'ENOENT',
        durationMs: 2,
      })),
    });

    await runAgentLoop(makeInput(), makePerception(), makeMemory(), undefined, makeRouting(), deps);

    const toolCallEntries = audits.filter((e) => e.kind === 'tool_call');
    expect(toolCallEntries.length).toBe(1);
    const entry = toolCallEntries[0];
    if (entry?.kind !== 'tool_call') throw new Error('expected tool_call');
    expect(entry.lifecycle).toBe('failed');
  });
});

describe('agent-loop audit emits — denials', () => {
  it('contract deny emits decision audit entry with ruleId starting "contract:"', async () => {
    const turns: WorkerTurn[] = [
      {
        type: 'tool_calls',
        turnId: 't-cdeny-1',
        calls: [{ id: 'c1', tool: 'file_write', parameters: { path: 'src/foo.ts', content: 'x' } }],
        rationale: 'writing without permission',
        tokensConsumed: 50,
      },
      { type: 'done', turnId: 't-cdeny-2', tokensConsumed: 10 },
    ];
    const session = new MockAgentSession(turns);
    const bus = createBus();
    const audits = captureAuditEntries(bus);
    const input = makeInput();
    const routing = makeRouting();
    const deps = makeDeps(session, bus);
    const contract = makeReadOnlyContract(input, routing);

    await runAgentLoop(input, makePerception(), makeMemory(), undefined, routing, deps, undefined, contract);

    const decisions = audits.filter((e) => e.kind === 'decision');
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    const denyEntry = decisions.find((e) => e.kind === 'decision' && e.decisionType === 'tool_deny');
    expect(denyEntry).toBeDefined();
    if (denyEntry?.kind !== 'decision') return;
    expect(denyEntry.ruleId).toMatch(/^contract:/);
    expect(denyEntry.tier).toBe('deterministic');
    expect(denyEntry.actor.type).toBe('orchestrator');
  });

  it('DSL deny emits decision audit entry with operator-supplied ruleId when provided', async () => {
    const turns: WorkerTurn[] = [
      {
        type: 'tool_calls',
        turnId: 't-dsl-1',
        calls: [{ id: 'c1', tool: 'file_write', parameters: { path: 'config.json', content: '{}' } }],
        rationale: 'attempting prohibited write',
        tokensConsumed: 50,
      },
      { type: 'done', turnId: 't-dsl-2', tokensConsumed: 10 },
    ];
    const session = new MockAgentSession(turns);
    const bus = createBus();
    const audits = captureAuditEntries(bus);
    const deps = makeDeps(session, bus, {
      permissionConfig: PermissionConfigSchema.parse({
        deny: [{ tool: 'file_write', match: 'config\\.json', reason: 'no config edits', id: 'no-config-edits' }],
      }),
    });

    await runAgentLoop(makeInput(), makePerception(), makeMemory(), undefined, makeRouting(), deps);

    const denyEntry = audits.find((e) => e.kind === 'decision' && e.decisionType === 'tool_deny');
    expect(denyEntry).toBeDefined();
    if (denyEntry?.kind !== 'decision') return;
    expect(denyEntry.ruleId).toBe('no-config-edits');
    expect(denyEntry.rationale).toContain('no config edits');
  });

  it('DSL deny without operator id synthesizes a stable dsl: fingerprint', async () => {
    const turns: WorkerTurn[] = [
      {
        type: 'tool_calls',
        turnId: 't-dsl-2',
        calls: [{ id: 'c1', tool: 'file_write', parameters: { path: '/etc/hosts', content: 'evil' } }],
        rationale: 'attempting prohibited write',
        tokensConsumed: 50,
      },
      { type: 'done', turnId: 't-dsl-3', tokensConsumed: 10 },
    ];
    const session = new MockAgentSession(turns);
    const bus = createBus();
    const audits = captureAuditEntries(bus);
    const deps = makeDeps(session, bus, {
      permissionConfig: PermissionConfigSchema.parse({
        deny: [{ tool: 'file_write', match: '/etc/.*' }],
      }),
    });

    await runAgentLoop(makeInput(), makePerception(), makeMemory(), undefined, makeRouting(), deps);

    const denyEntry = audits.find((e) => e.kind === 'decision' && e.decisionType === 'tool_deny');
    expect(denyEntry).toBeDefined();
    if (denyEntry?.kind !== 'decision') return;
    expect(denyEntry.ruleId).toMatch(/^dsl:[0-9a-f]{12}$/);
  });

  it('hook deny emits decision audit entry with ruleId === "hook:PreToolUse"', async () => {
    const turns: WorkerTurn[] = [
      {
        type: 'tool_calls',
        turnId: 't-hook-1',
        calls: [{ id: 'c1', tool: 'file_write', parameters: { path: 'src/foo.ts', content: 'x' } }],
        rationale: 'writing under hook',
        tokensConsumed: 50,
      },
      { type: 'done', turnId: 't-hook-2', tokensConsumed: 10 },
    ];
    const session = new MockAgentSession(turns);
    const bus = createBus();
    const audits = captureAuditEntries(bus);
    const deps = makeDeps(session, bus, {
      hookConfig: HookConfigSchema.parse({
        hooks: {
          PreToolUse: [{ matcher: 'file_write', hooks: [{ command: 'echo "denied"; exit 1' }] }],
        },
      }),
    });

    await runAgentLoop(makeInput(), makePerception(), makeMemory(), undefined, makeRouting(), deps);

    const denyEntry = audits.find((e) => e.kind === 'decision' && e.decisionType === 'tool_deny');
    expect(denyEntry).toBeDefined();
    if (denyEntry?.kind !== 'decision') return;
    expect(denyEntry.ruleId).toBe('hook:PreToolUse');
    expect(denyEntry.rationale).toContain('PreToolUse hook');
  });
});

describe('agent-loop audit emits — wrapper invariants', () => {
  it('every entry carries policyVersion, current schemaVersion, redactionPolicyHash', async () => {
    const turns: WorkerTurn[] = [
      {
        type: 'tool_calls',
        turnId: 't-inv-1',
        calls: [{ id: 'c1', tool: 'file_read', parameters: { path: 'src/foo.ts' } }],
        rationale: 'reading',
        tokensConsumed: 50,
      },
      { type: 'done', turnId: 't-inv-2', tokensConsumed: 10 },
    ];
    const session = new MockAgentSession(turns);
    const bus = createBus();
    const audits = captureAuditEntries(bus);
    const deps = makeDeps(session, bus);

    await runAgentLoop(makeInput(), makePerception(), makeMemory(), undefined, makeRouting(), deps);

    expect(audits.length).toBeGreaterThan(0);
    for (const entry of audits) {
      // schemaVersion bumped to 2 for the Phase-2 hierarchy expansion. The
      // back-compat reader still accepts v1, so this assertion only pins
      // the EMITTED version — historical rows from before the bump remain
      // parseable.
      expect(entry.schemaVersion).toBe(AUDIT_SCHEMA_VERSION);
      expect(entry.policyVersion).toBe('audit-v1');
      expect(entry.redactionPolicyHash).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.ts).toBeGreaterThan(0);
    }
  });
});

describe('agent-loop audit emits — Phase 2 hierarchy id propagation', () => {
  it('root task: audit entries carry sessionId, no subTaskId/subAgentId', async () => {
    const turns: WorkerTurn[] = [
      {
        type: 'tool_calls',
        turnId: 't-root-1',
        calls: [{ id: 'c1', tool: 'file_read', parameters: { path: 'src/foo.ts' } }],
        rationale: 'reading',
        tokensConsumed: 30,
      },
      { type: 'done', turnId: 't-root-2', tokensConsumed: 10 },
    ];
    const session = new MockAgentSession(turns);
    const bus = createBus();
    const audits = captureAuditEntries(bus);
    const deps = makeDeps(session, bus);
    const input = makeInput({ sessionId: 'sess-A' });

    await runAgentLoop(input, makePerception(), makeMemory(), undefined, makeRouting(), deps);

    expect(audits.length).toBeGreaterThan(0);
    for (const e of audits) {
      expect(e.sessionId).toBe('sess-A');
      expect(e.workflowId).toBe(input.id); // alias of taskId
      expect(e.subTaskId).toBeUndefined();
      expect(e.subAgentId).toBeUndefined();
    }
  });

  it('sub-task: input.parentTaskId set → entries carry subTaskId and subAgentId equal to input.id', async () => {
    const turns: WorkerTurn[] = [
      {
        type: 'tool_calls',
        turnId: 't-sub-1',
        calls: [{ id: 'c1', tool: 'file_read', parameters: { path: 'src/foo.ts' } }],
        rationale: 'reading',
        tokensConsumed: 30,
      },
      { type: 'done', turnId: 't-sub-2', tokensConsumed: 10 },
    ];
    const session = new MockAgentSession(turns);
    const bus = createBus();
    const audits = captureAuditEntries(bus);
    const deps = makeDeps(session, bus);
    const input = makeInput({
      id: 'task-parent-1-delegate-step1',
      sessionId: 'sess-B',
      parentTaskId: 'task-parent-1',
    });

    await runAgentLoop(input, makePerception(), makeMemory(), undefined, makeRouting(), deps);

    expect(audits.length).toBeGreaterThan(0);
    for (const e of audits) {
      expect(e.sessionId).toBe('sess-B');
      expect(e.subTaskId).toBe(input.id);
      expect(e.subAgentId).toBe(input.id);
      // workflowId alias still equals THIS input's id (the sub-task's id) — the
      // audit entry pertains to the sub-workflow scoped to this input, not the
      // grandparent's workflow.
      expect(e.workflowId).toBe(input.id);
    }
  });
});

describe('agent-loop audit emits — Phase 2 hierarchyFromInput coverage across deny + reflect paths', () => {
  it('sub-task: contract-deny audit entry carries subTaskId/subAgentId from hierarchyFromInput', async () => {
    const turns: WorkerTurn[] = [
      {
        type: 'tool_calls',
        turnId: 't-cdeny-sub',
        calls: [{ id: 'c1', tool: 'file_write', parameters: { path: 'src/foo.ts', content: 'x' } }],
        rationale: 'attempting prohibited write under sub-task',
        tokensConsumed: 50,
      },
      { type: 'done', turnId: 't-cdeny-sub-2', tokensConsumed: 10 },
    ];
    const session = new MockAgentSession(turns);
    const bus = createBus();
    const audits = captureAuditEntries(bus);
    const input = makeInput({
      id: 'parent-X-delegate-step1',
      parentTaskId: 'parent-X',
      sessionId: 'sess-X',
    });
    const routing = makeRouting();
    const deps = makeDeps(session, bus);
    const contract = makeReadOnlyContract(input, routing);

    await runAgentLoop(input, makePerception(), makeMemory(), undefined, routing, deps, undefined, contract);

    expect(audits.length).toBeGreaterThan(0);
    // Mechanism guarantee: hierarchyFromInput stamps subTaskId/subAgentId on
    // every audit entry the orchestrator emits when input.parentTaskId is
    // set. That means the deny rows MUST carry the same chain as the
    // thought/tool rows.
    for (const e of audits) {
      expect(e.sessionId).toBe('sess-X');
      expect(e.subTaskId).toBe(input.id);
      expect(e.subAgentId).toBe(input.id);
      expect(e.workflowId).toBe(input.id);
    }
    // And specifically the deny path's decision row is present.
    const denyRow = audits.find((e) => e.kind === 'decision' && e.decisionType === 'tool_deny');
    expect(denyRow).toBeDefined();
  });

  it('sub-task: uncertain-reflect thought entry carries the full id chain', async () => {
    const turns: WorkerTurn[] = [
      {
        type: 'uncertain',
        turnId: 't-unc-sub',
        reason: 'cannot finish without external context — reflecting under sub-task',
        uncertainties: ['missing-input'],
        tokensConsumed: 30,
      },
    ];
    const session = new MockAgentSession(turns);
    const bus = createBus();
    const audits = captureAuditEntries(bus);
    const input = makeInput({
      id: 'parent-Y-delegate-step1',
      parentTaskId: 'parent-Y',
      sessionId: 'sess-Y',
    });
    const deps = makeDeps(session, bus);

    await runAgentLoop(input, makePerception(), makeMemory(), undefined, makeRouting(), deps);

    const reflectThoughts = audits.filter((e) => e.kind === 'thought' && e.trigger === 'reflect');
    expect(reflectThoughts.length).toBe(1);
    const r = reflectThoughts[0];
    if (r?.kind !== 'thought') throw new Error('expected thought');
    expect(r.sessionId).toBe('sess-Y');
    expect(r.subTaskId).toBe(input.id);
    expect(r.subAgentId).toBe(input.id);
    expect(r.workflowId).toBe(input.id);
  });
});
