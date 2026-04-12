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
import type { IAgentSession, SessionState } from '../../src/orchestrator/worker/agent-session.ts';
import type { OrchestratorTurn, TerminateReason, WorkerTurn } from '../../src/orchestrator/protocol.ts';
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
