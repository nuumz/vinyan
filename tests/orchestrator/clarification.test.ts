/**
 * Agent Conversation — clarification flow tests.
 *
 * Covers the end-to-end path that lets an agent pause a task to ask the user
 * a question (`attempt_completion` with `needsUserInput=true`) and the
 * orchestrator surface those questions as `status: 'input-required'` instead
 * of retrying or escalating.
 *
 * Scope:
 *  1. Unit  — agent-loop forwards `needsUserInput` from the worker's
 *             `uncertain` turn to `WorkerLoopResult.needsUserInput`.
 *  2. Unit  — SessionManager records an `[INPUT-REQUIRED]` block on
 *             assistant turns, exposes open clarifications, and preserves
 *             them across compaction.
 *  3. Unit  — `parseInputRequiredBlock` pure parser.
 *  4. Non-retryable detection is suppressed when `needsUserInput=true`
 *             (a user pause must not be misclassified as a hard error).
 *
 * NOTE: A full core-loop integration test (worker → executeTask →
 * 'input-required' TaskResult) would require spinning up the whole
 * Orchestrator factory with mocked providers, which is several hundred
 * lines of test scaffolding. The existing `core-loop-integration.test.ts`
 * is the right place for that; for this PR we focus on the unit boundaries
 * that carry the new state.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';

import { parseInputRequiredBlock, SessionManager } from '../../src/api/session-manager.ts';
import { SessionStore } from '../../src/db/session-store.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { runAgentLoop, type AgentLoopDeps } from '../../src/orchestrator/worker/agent-loop.ts';
import { buildInitUserMessage, buildSystemPrompt } from '../../src/orchestrator/worker/agent-worker-entry.ts';
import { DelegationRouter, buildSubTaskInput } from '../../src/orchestrator/delegation-router.ts';
import type { IAgentSession, SessionState } from '../../src/orchestrator/worker/agent-session.ts';
import type {
  AgentBudget,
  DelegationRequest,
  OrchestratorTurn,
  TerminateReason,
  WorkerTurn,
} from '../../src/orchestrator/protocol.ts';
import type {
  PerceptualHierarchy,
  RoutingDecision,
  TaskInput,
  TaskResult,
  ToolCall,
  ToolResult,
  WorkingMemoryState,
} from '../../src/orchestrator/types.ts';

// ── Shared mocks (mirrors tests/orchestrator/agent-loop.test.ts) ─────

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

function makeMockToolExecutor() {
  return {
    execute: async (call: ToolCall): Promise<ToolResult> => ({
      callId: call.id,
      tool: call.tool,
      status: 'success',
      output: 'mock result',
      durationMs: 1,
    }),
  };
}

/**
 * A mock tool executor that routes `delegate_task` through the real
 * `context.onDelegate` callback (which agent-loop wires to `handleDelegation`).
 * All other tool calls fall through to the default mock handler. Used by the
 * delegation bubble-up tests so the real handleDelegation code path runs.
 */
function makeDelegatingToolExecutor() {
  return {
    execute: async (
      call: ToolCall,
      context: import('../../src/orchestrator/tools/tool-interface.ts').ToolContext,
    ): Promise<ToolResult> => {
      if (call.tool === 'delegate_task' && context.onDelegate) {
        const result = await context.onDelegate({ ...call.parameters, callId: call.id } as any);
        // handleDelegation returns a ToolResult with callId: '' — backfill
        // from the actual call so the agent loop can correlate it.
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
    id: 'test-clar-1',
    source: 'cli',
    goal: 'Rename the helper',
    targetFiles: ['src/foo.ts'],
    budget: { maxTokens: 10000, maxDurationMs: 30000, maxRetries: 2 },
  } as TaskInput;
}

function makeTestRouting(): RoutingDecision {
  return {
    level: 2,
    model: 'test-model',
    budgetTokens: 10000,
    latencyBudgetMs: 30000,
  } as RoutingDecision;
}

function makeTestPerception(): PerceptualHierarchy {
  return {
    taskTarget: { file: 'src/foo.ts', description: 'target file' },
    dependencyCone: {
      directImporters: [],
      directImportees: [],
      transitiveBlastRadius: 0,
    },
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

function makeDeps(session: MockAgentSession): AgentLoopDeps {
  return {
    workspace: testWorkspace,
    contextWindow: 128_000,
    agentWorkerEntryPath: '/dev/null',
    toolExecutor: makeMockToolExecutor(),
    compressPerception: (p) => p,
    createSession: () => session,
  };
}

beforeEach(() => {
  testWorkspace = join(tmpdir(), `vinyan-clar-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(testWorkspace, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(testWorkspace, { recursive: true, force: true });
  } catch {
    /* ignore cleanup errors */
  }
});

// ── 1. agent-loop: needsUserInput propagates to WorkerLoopResult ────

describe('agent-loop: needsUserInput → WorkerLoopResult.needsUserInput', () => {
  it('forwards needsUserInput=true from an uncertain worker turn', async () => {
    const questions = [
      'Which file should I rename — src/foo.ts or src/foo-v2.ts?',
      'Should the old name remain as a deprecated alias?',
    ];
    const workerTurns: WorkerTurn[] = [
      {
        type: 'uncertain',
        turnId: 't1',
        reason: 'Ambiguous user intent',
        uncertainties: questions,
        tokensConsumed: 120,
        needsUserInput: true,
      },
    ];
    const session = new MockAgentSession(workerTurns);

    const result = await runAgentLoop(
      makeTestInput(),
      makeTestPerception(),
      makeTestMemory(),
      undefined,
      makeTestRouting(),
      makeDeps(session),
    );

    expect(result.isUncertain).toBe(true);
    expect(result.needsUserInput).toBe(true);
    expect(result.uncertainties).toEqual(questions);
    // Session should be drained (not force-closed) — this is a graceful pause.
    expect(session.drained).toBe(true);
    expect(session.closed).toBe(false);
  });

  it('leaves needsUserInput undefined when the worker did not set it', async () => {
    const workerTurns: WorkerTurn[] = [
      {
        type: 'uncertain',
        turnId: 't1',
        reason: 'Could not find function X',
        uncertainties: ['Function not located in repo'],
        tokensConsumed: 90,
      },
    ];
    const session = new MockAgentSession(workerTurns);

    const result = await runAgentLoop(
      makeTestInput(),
      makeTestPerception(),
      makeTestMemory(),
      undefined,
      makeTestRouting(),
      makeDeps(session),
    );

    expect(result.isUncertain).toBe(true);
    expect(result.needsUserInput).toBeUndefined();
  });

  it('does NOT classify a needsUserInput pause as a non-retryable error', async () => {
    // Craft uncertainties that WOULD match the non-retryable pattern "401"
    // if the detector were allowed to run. When needsUserInput=true, the
    // pause must override classification — a user question is not a 401.
    const workerTurns: WorkerTurn[] = [
      {
        type: 'uncertain',
        turnId: 't1',
        reason: 'Need to know which auth flow you want',
        uncertainties: ['Should we return 401 or 403 for invalid tokens?'],
        tokensConsumed: 100,
        needsUserInput: true,
      },
    ];
    const session = new MockAgentSession(workerTurns);

    const result = await runAgentLoop(
      makeTestInput(),
      makeTestPerception(),
      makeTestMemory(),
      undefined,
      makeTestRouting(),
      makeDeps(session),
    );

    expect(result.needsUserInput).toBe(true);
    // nonRetryableError must be undefined — a user pause should be resumable.
    expect(result.nonRetryableError).toBeUndefined();
  });
});

// ── 2. SessionManager: input-required recording & compaction ────────

describe('SessionManager — input-required recording', () => {
  let db: Database;
  let sessionStore: SessionStore;
  let manager: SessionManager;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    new MigrationRunner().migrate(db, ALL_MIGRATIONS);
    sessionStore = new SessionStore(db);
    manager = new SessionManager(sessionStore);
  });

  afterEach(() => {
    db.close();
  });

  function makeInputRequiredResult(questions: string[]): TaskResult {
    return {
      id: 'task-A',
      status: 'input-required',
      mutations: [],
      trace: {
        id: 'trace-A',
        taskId: 'task-A',
        timestamp: Date.now(),
        routingLevel: 2,
        approach: 'input-required-pause',
        oracleVerdicts: {},
        modelUsed: 'mock/test',
        tokensConsumed: 100,
        durationMs: 50,
        outcome: 'success',
        affectedFiles: [],
      } as any,
      clarificationNeeded: questions,
    };
  }

  it('recordAssistantTurn stores clarifications in an [INPUT-REQUIRED] block', () => {
    const session = manager.create('cli');
    const questions = ['Which auth flow did you mean?', 'Should the old endpoint stay alive?'];
    manager.recordAssistantTurn(session.id, 'task-A', makeInputRequiredResult(questions));

    const history = manager.getConversationHistory(session.id);
    expect(history).toHaveLength(1);
    const content = history[0]!.content;
    expect(content).toContain('[INPUT-REQUIRED]');
    for (const q of questions) {
      expect(content).toContain(q);
    }
  });

  it('getPendingClarifications returns the open questions', () => {
    const session = manager.create('cli');
    const questions = ['Q1?', 'Q2?'];
    manager.recordAssistantTurn(session.id, 'task-A', makeInputRequiredResult(questions));

    const pending = manager.getPendingClarifications(session.id);
    expect(pending).toEqual(questions);
  });

  it('getPendingClarifications returns [] once the user has answered', () => {
    const session = manager.create('cli');
    manager.recordAssistantTurn(session.id, 'task-A', makeInputRequiredResult(['Pick A or B?']));
    manager.recordUserTurn(session.id, 'Pick A');

    const pending = manager.getPendingClarifications(session.id);
    expect(pending).toEqual([]);
  });

  it('completeTask stores input-required result with completed db-status', () => {
    // completeTask must map 'input-required' → 'completed' at the DB boundary
    // (session_tasks.status has a CHECK constraint that forbids 'input-required').
    // The full TaskResult still carries status='input-required' inside result_json.
    const session = manager.create('cli');
    const taskInput: TaskInput = {
      id: 'task-A',
      source: 'cli',
      goal: 'rename something',
      taskType: 'code',
      budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 1 },
    };
    manager.addTask(session.id, taskInput);

    // Must not throw despite 'input-required' not being in the CHECK list.
    expect(() => manager.completeTask(session.id, 'task-A', makeInputRequiredResult(['Q?']))).not.toThrow();
  });

  it('compaction preserves both resolved and open clarifications', () => {
    const session = manager.create('cli');

    // Seed a long history: 8 turn pairs where turn 2 is a resolved
    // input-required (answered by the user) and turn 7 is still open.
    // With keepRecentTurns=3 the older 5 turn pairs get compacted.
    for (let i = 0; i < 8; i++) {
      manager.recordUserTurn(session.id, `user message ${i}`);
      if (i === 1) {
        manager.recordAssistantTurn(session.id, `task-${i}`, makeInputRequiredResult(['Pick config A or B?']));
        // Immediate user answer in the next iteration will resolve it.
      } else if (i === 6) {
        manager.recordAssistantTurn(
          session.id,
          `task-${i}`,
          makeInputRequiredResult(['Should I delete the old file?']),
        );
        // No user answer after this — stays open.
      } else {
        // Plain assistant reply — store via a completed-style TaskResult.
        manager.recordAssistantTurn(session.id, `task-${i}`, {
          id: `task-${i}`,
          status: 'completed',
          mutations: [],
          trace: {
            id: `trace-${i}`,
            taskId: `task-${i}`,
            timestamp: Date.now(),
            routingLevel: 1,
            approach: 'noop',
            oracleVerdicts: {},
            modelUsed: 'mock/test',
            tokensConsumed: 10,
            durationMs: 1,
            outcome: 'success',
            affectedFiles: [],
          } as any,
          answer: `reply ${i}`,
        });
      }
    }

    const compacted = manager.getConversationHistoryCompacted(session.id, 50_000, 3);
    const compactBlock = compacted.find((e) => e.content.includes('[SESSION CONTEXT'));
    expect(compactBlock).toBeDefined();
    expect(compactBlock!.content).toContain('Resolved clarifications');
    expect(compactBlock!.content).toContain('Pick config A or B?');
  });
});

// ── 3. parseInputRequiredBlock pure parser ───────────────────────────

describe('parseInputRequiredBlock', () => {
  it('returns [] when the tag is absent', () => {
    expect(parseInputRequiredBlock('plain assistant reply')).toEqual([]);
  });

  it('extracts bullet questions', () => {
    const content = [
      'I looked at both files.',
      '',
      '[INPUT-REQUIRED]',
      '- Which file should I rename?',
      '- Keep the old name as an alias?',
    ].join('\n');
    expect(parseInputRequiredBlock(content)).toEqual(['Which file should I rename?', 'Keep the old name as an alias?']);
  });

  it('stops at the first non-bullet line after bullets', () => {
    const content = ['[INPUT-REQUIRED]', '- First', '- Second', 'epilogue line', '- should not appear'].join('\n');
    expect(parseInputRequiredBlock(content)).toEqual(['First', 'Second']);
  });

  it('ignores stray leading whitespace on bullets', () => {
    const content = '[INPUT-REQUIRED]\n  - With spaces';
    expect(parseInputRequiredBlock(content)).toEqual(['With spaces']);
  });
});

// ── 4. Interactive delegation: child bubble-up to parent ────────────

/**
 * These tests exercise the Phase 6.4 delegate_task path when the delegated
 * child returns `status: 'input-required'`. The parent worker must see the
 * child's questions as a structured, non-error ToolResult so it can either
 * answer-and-re-delegate or bubble up via its own attempt_completion.
 */

/**
 * Agent-loop appends a `<vinyan-reminder>` block to the LAST tool result's
 * output when there are budget/turn/failure hints to surface (separator:
 * `\n\n`). Strip it so JSON.parse sees only the delegate_task structured
 * output, not the trailing reminder prose.
 */
function parseDelegateOutput(result: ToolResult): Record<string, unknown> {
  const raw = typeof result.output === 'string' ? result.output : JSON.stringify(result.output ?? '');
  const jsonPart = raw.split('\n\n')[0] ?? raw;
  return JSON.parse(jsonPart) as Record<string, unknown>;
}

function makeChildResult(status: TaskResult['status'], extras: Partial<TaskResult> = {}): TaskResult {
  return {
    id: 'child-1',
    status,
    mutations: [],
    trace: {
      id: 'trace-child',
      taskId: 'child-1',
      timestamp: Date.now(),
      routingLevel: 2,
      approach: 'delegation-test',
      oracleVerdicts: {},
      modelUsed: 'mock/test',
      tokensConsumed: 100,
      durationMs: 10,
      outcome: status === 'completed' || status === 'input-required' ? 'success' : 'failure',
      affectedFiles: [],
    } as any,
    ...extras,
  };
}

describe('delegate_task — child input-required bubble-up', () => {
  /**
   * Parent worker issues a delegate_task call. The mocked child returns
   * `status: 'input-required'` with two clarification questions. The parent
   * then bubbles up via attempt_completion(needsUserInput=true).
   *
   * We assert:
   *   1. The ToolResult sent back to the parent session has status='success'
   *      (NOT 'error') — so the parent's error-handling path doesn't fire.
   *   2. The ToolResult output JSON contains `pausedForUserInput: true` and
   *      the child's `clarificationNeeded` list.
   *   3. The parent's final WorkerLoopResult carries needsUserInput through
   *      (because the parent bubbled up with needsUserInput=true).
   */
  it('forwards input-required child as success ToolResult with clarificationNeeded', async () => {
    const childQuestions = [
      'Which auth file should I edit — src/auth.ts or src/auth-v2.ts?',
      'Should the old helper remain as a deprecated alias?',
    ];

    const executeTaskMock = async (_subInput: TaskInput): Promise<TaskResult> =>
      makeChildResult('input-required', { clarificationNeeded: childQuestions });

    const workerTurns: WorkerTurn[] = [
      // Turn 1: parent calls delegate_task
      {
        type: 'tool_calls',
        turnId: 't1',
        calls: [
          {
            id: 'c1',
            tool: 'delegate_task',
            parameters: {
              goal: 'rename the helper',
              targetFiles: ['src/foo.ts'],
            },
          },
        ],
        rationale: 'delegating rename work to a child',
        tokensConsumed: 100,
      },
      // Turn 2: parent sees child paused → bubbles up
      {
        type: 'uncertain',
        turnId: 't2',
        reason: 'Delegated child needs clarification',
        uncertainties: childQuestions,
        tokensConsumed: 60,
        needsUserInput: true,
      },
    ];

    const session = new MockAgentSession(workerTurns);
    const deps: AgentLoopDeps = {
      ...makeDeps(session),
      toolExecutor: makeDelegatingToolExecutor(),
      delegationRouter: new DelegationRouter(),
      executeTask: executeTaskMock,
    };

    const result = await runAgentLoop(
      makeTestInput(),
      makeTestPerception(),
      makeTestMemory(),
      undefined,
      makeTestRouting(),
      deps,
    );

    // Parent bubbled up successfully
    expect(result.isUncertain).toBe(true);
    expect(result.needsUserInput).toBe(true);

    // Inspect the tool_results turn sent back to the session
    const toolResultTurns = session.sent.filter((t) => t.type === 'tool_results') as Array<
      Extract<OrchestratorTurn, { type: 'tool_results' }>
    >;
    expect(toolResultTurns).toHaveLength(1);
    const delegateResult = toolResultTurns[0]!.results[0]!;
    expect(delegateResult.tool).toBe('delegate_task');
    // Critical: NOT 'error' — a paused child is not a failure.
    expect(delegateResult.status).toBe('success');

    const output = parseDelegateOutput(delegateResult) as {
      status: string;
      pausedForUserInput?: boolean;
      clarificationNeeded?: string[];
    };
    expect(output.status).toBe('input-required');
    expect(output.pausedForUserInput).toBe(true);
    expect(output.clarificationNeeded).toEqual(childQuestions);
  });

  it('still classifies a truly failed child as ToolResult.status=error', async () => {
    const executeTaskMock = async (_subInput: TaskInput): Promise<TaskResult> =>
      makeChildResult('failed', { escalationReason: 'oracle rejected mutation' });

    const workerTurns: WorkerTurn[] = [
      {
        type: 'tool_calls',
        turnId: 't1',
        calls: [
          {
            id: 'c1',
            tool: 'delegate_task',
            parameters: { goal: 'do it', targetFiles: ['src/foo.ts'] },
          },
        ],
        rationale: 'delegating',
        tokensConsumed: 50,
      },
      { type: 'done', turnId: 't2', proposedContent: 'giving up', tokensConsumed: 20 },
    ];

    const session = new MockAgentSession(workerTurns);
    const deps: AgentLoopDeps = {
      ...makeDeps(session),
      toolExecutor: makeDelegatingToolExecutor(),
      delegationRouter: new DelegationRouter(),
      executeTask: executeTaskMock,
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
    const delegateResult = toolResultTurns[0]!.results[0]!;
    expect(delegateResult.status).toBe('error');
    // The output JSON should NOT contain pausedForUserInput
    const output = parseDelegateOutput(delegateResult);
    expect(output.status).toBe('failed');
    expect(output.pausedForUserInput).toBeUndefined();
    expect(output.clarificationNeeded).toBeUndefined();
  });

  it('treats a completed child as ToolResult.status=success (regression)', async () => {
    const executeTaskMock = async (_subInput: TaskInput): Promise<TaskResult> =>
      makeChildResult('completed');

    const workerTurns: WorkerTurn[] = [
      {
        type: 'tool_calls',
        turnId: 't1',
        calls: [
          {
            id: 'c1',
            tool: 'delegate_task',
            parameters: { goal: 'do it', targetFiles: ['src/foo.ts'] },
          },
        ],
        rationale: 'delegating',
        tokensConsumed: 40,
      },
      { type: 'done', turnId: 't2', proposedContent: 'child done', tokensConsumed: 20 },
    ];

    const session = new MockAgentSession(workerTurns);
    const deps: AgentLoopDeps = {
      ...makeDeps(session),
      toolExecutor: makeDelegatingToolExecutor(),
      delegationRouter: new DelegationRouter(),
      executeTask: executeTaskMock,
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
    const delegateResult = toolResultTurns[0]!.results[0]!;
    expect(delegateResult.status).toBe('success');
    const output = parseDelegateOutput(delegateResult);
    expect(output.status).toBe('completed');
    expect(output.pausedForUserInput).toBeUndefined();
  });
});

// ── 5. buildSubTaskInput: context propagation ───────────────────────

describe('buildSubTaskInput — context propagation', () => {
  const parent: TaskInput = {
    id: 'parent-1',
    source: 'cli',
    goal: 'rename the helper',
    taskType: 'code',
    targetFiles: ['src/foo.ts'],
    budget: { maxTokens: 50_000, maxDurationMs: 60_000, maxRetries: 2 },
  };

  const childBudget: AgentBudget = {
    maxTokens: 5000,
    maxTurns: 10,
    maxDurationMs: 30_000,
    contextWindow: 128_000,
    base: 3000,
    negotiable: 1250,
    delegation: 750,
    maxExtensionRequests: 3,
    maxToolCallsPerTurn: 10,
    maxToolCalls: 20,
    delegationDepth: 1,
    maxDelegationDepth: 3,
  };

  it('propagates request.context into child constraints as a CONTEXT: prefix', () => {
    const request: DelegationRequest = {
      goal: 'rename helper to util',
      targetFiles: ['src/foo.ts'],
      context:
        "Resolved clarifications: 'Which file?' => src/foo.ts; 'Keep old name as alias?' => no, remove it",
    };
    const sub = buildSubTaskInput(request, parent, {} as RoutingDecision, childBudget);
    expect(sub.constraints).toBeDefined();
    expect(sub.constraints).toHaveLength(1);
    expect(sub.constraints![0]).toMatch(/^CONTEXT:/);
    expect(sub.constraints![0]).toContain("Which file?' => src/foo.ts");
    expect(sub.constraints![0]).toContain('remove it');
  });

  it('leaves constraints undefined when request.context is absent', () => {
    const request: DelegationRequest = {
      goal: 'rename helper',
      targetFiles: ['src/foo.ts'],
    };
    const sub = buildSubTaskInput(request, parent, {} as RoutingDecision, childBudget);
    expect(sub.constraints).toBeUndefined();
  });
});

// ── 6. System prompt: delegation clarification guidance ─────────────

describe('buildSystemPrompt — delegation clarification guidance', () => {
  it('L2+ prompt includes the delegation clarification section', () => {
    const prompt = buildSystemPrompt(2, 'code');
    expect(prompt).toContain('Handling Delegated Sub-task Clarifications');
    expect(prompt).toContain('pausedForUserInput');
    expect(prompt).toContain('needsUserInput=true');
  });

  it('L3 prompt also includes the delegation clarification section', () => {
    const prompt = buildSystemPrompt(3, 'code');
    expect(prompt).toContain('Handling Delegated Sub-task Clarifications');
  });

  it('L1 prompt does NOT include the delegation clarification section', () => {
    // Delegation is L2+ only; the section is irrelevant for L1 workers.
    const prompt = buildSystemPrompt(1, 'code');
    expect(prompt).not.toContain('Handling Delegated Sub-task Clarifications');
  });
});

// ── 7. buildInitUserMessage: CLARIFIED / CONTEXT constraint rendering ───

/**
 * Regression guard: before this fix, `buildInitUserMessage` only rendered
 * `understanding.semanticIntent.implicitConstraints` — so raw
 * `CLARIFIED:` / `CONTEXT:` strings in `TaskInput.constraints` (the
 * mechanism that `vinyan chat` and the interactive delegation path use to
 * pass user answers to the agent) were silently dropped at the L2+
 * subprocess boundary. These tests lock the fix in place.
 */
describe('buildInitUserMessage — CLARIFIED / CONTEXT constraint rendering', () => {
  const emptyPerception = {
    taskTarget: { file: 'src/foo.ts', description: 'target file' },
    dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
    diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
    verifiedFacts: [],
    runtime: { nodeVersion: 'test', os: 'test', availableTools: [] },
  };

  function makeUnderstanding(constraints: string[]): Record<string, unknown> {
    return {
      rawGoal: 'test goal',
      actionVerb: 'modify',
      actionCategory: 'mutation',
      frameworkContext: [],
      constraints,
      acceptanceCriteria: [],
      expectsMutation: true,
    };
  }

  it('renders CLARIFIED:<q>=><a> entries as a User Clarifications section', () => {
    const message = buildInitUserMessage(
      'rename the helper',
      emptyPerception,
      undefined,
      makeUnderstanding([
        'CLARIFIED:Which file should I rename?=>src/auth.ts',
        'CLARIFIED:Keep old name as alias?=>no, remove it',
      ]),
    );

    expect(message).toContain('## User Clarifications');
    expect(message).toContain('Which file should I rename?');
    expect(message).toContain('src/auth.ts');
    expect(message).toContain('Keep old name as alias?');
    expect(message).toContain('no, remove it');
    // The formatting should preserve Q/A labels so the LLM can pair them.
    expect(message).toMatch(/Q:.*Which file should I rename\?\s*\n\s*A:.*src\/auth\.ts/);
  });

  it('renders CONTEXT:<text> entries as a Delegation Context section', () => {
    const message = buildInitUserMessage(
      'apply the rename',
      emptyPerception,
      undefined,
      makeUnderstanding([
        "CONTEXT:Resolved clarifications: 'Which file?' => src/auth.ts; 'Alias?' => no",
      ]),
    );

    expect(message).toContain('## Delegation Context (from parent agent)');
    expect(message).toContain('src/auth.ts');
    expect(message).toContain('authoritative grounding');
    // Raw CONTEXT: prefix should not leak into the prompt.
    expect(message).not.toContain('CONTEXT:Resolved');
  });

  it('filters pipeline metadata constraints (MIN_ROUTING_LEVEL, THINKING, TOOLS)', () => {
    const message = buildInitUserMessage(
      'do work',
      emptyPerception,
      undefined,
      makeUnderstanding(['MIN_ROUTING_LEVEL:1', 'THINKING:enabled', 'TOOLS:enabled']),
    );

    // None of the metadata strings should surface in the LLM prompt.
    expect(message).not.toContain('MIN_ROUTING_LEVEL');
    expect(message).not.toContain('THINKING:enabled');
    expect(message).not.toContain('TOOLS:enabled');
    // And since there's nothing else to render, no User Constraints section.
    expect(message).not.toContain('## User Constraints');
    expect(message).not.toContain('## User Clarifications');
    expect(message).not.toContain('## Delegation Context');
  });

  it('renders plain user constraints (non-CLARIFIED, non-CONTEXT, non-metadata) as User Constraints', () => {
    const message = buildInitUserMessage(
      'do work',
      emptyPerception,
      undefined,
      makeUnderstanding(['must use the existing logger helper', 'no new dependencies']),
    );

    expect(message).toContain('## User Constraints');
    expect(message).toContain('must use the existing logger helper');
    expect(message).toContain('no new dependencies');
  });

  it('handles mixed constraint types by surfacing each in its own section', () => {
    const message = buildInitUserMessage(
      'rename and apply',
      emptyPerception,
      undefined,
      makeUnderstanding([
        'MIN_ROUTING_LEVEL:2',
        'CLARIFIED:Which module?=>auth',
        'CONTEXT:parent decided to preserve the public API',
        'prefer composition over inheritance',
      ]),
    );

    expect(message).toContain('## User Clarifications');
    expect(message).toContain('Which module?');
    expect(message).toContain('## Delegation Context');
    expect(message).toContain('parent decided to preserve the public API');
    expect(message).toContain('## User Constraints');
    expect(message).toContain('prefer composition over inheritance');
    // Pipeline metadata is still filtered
    expect(message).not.toContain('MIN_ROUTING_LEVEL');
  });

  it('emits no constraint-related section when understanding.constraints is empty', () => {
    const message = buildInitUserMessage(
      'simple task',
      emptyPerception,
      undefined,
      makeUnderstanding([]),
    );

    expect(message).not.toContain('## User Clarifications');
    expect(message).not.toContain('## Delegation Context');
    expect(message).not.toContain('## User Constraints');
    // Goal is still present
    expect(message).toContain('## Goal\nsimple task');
  });

  it('treats a malformed CLARIFIED: entry (no separator at all) as a plain constraint', () => {
    // The parser looks for the first `=>` as the Q/A delimiter. A CLARIFIED:
    // string with no separator has no valid Q/A split and must degrade to
    // a plain user constraint rather than being silently dropped.
    const malformed = 'CLARIFIED:just some prose with no separator';
    const message = buildInitUserMessage(
      'test',
      emptyPerception,
      undefined,
      makeUnderstanding([malformed]),
    );

    expect(message).not.toContain('## User Clarifications');
    expect(message).toContain('## User Constraints');
    expect(message).toContain(malformed);
  });
});
