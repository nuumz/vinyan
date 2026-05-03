/**
 * TaskProcessProjectionService — unit tests (no HTTP).
 *
 * Wires real durable stores against an in-memory SQLite, plants events
 * via TaskEventStore.append, and asserts the projection captures the
 * authoritative process state the operator console will render.
 *
 * Goal: prove the projection IS the canonical source of truth — the
 * vinyan-ui side can therefore render projection.gates / projection.plan
 * directly without re-folding raw events.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ApprovalLedgerStore } from '../../src/db/approval-ledger-store.ts';
import { CodingCliStore } from '../../src/db/coding-cli-store.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import type { SessionTaskRow } from '../../src/db/session-store.ts';
import { TaskEventStore } from '../../src/db/task-event-store.ts';
import { TaskProcessProjectionService } from '../../src/api/projections/task-process-projection.ts';
import type { CodingCliSessionRecord } from '../../src/orchestrator/external-coding-cli/types.ts';
import type { TaskResult } from '../../src/orchestrator/types.ts';

let db: Database;
let taskEventStore: TaskEventStore;
let approvalLedgerStore: ApprovalLedgerStore;
let codingCliStore: CodingCliStore;
const taskRows = new Map<string, SessionTaskRow>();
const inFlight = new Set<string>();
const pending = new Set<string>();
const asyncResults = new Map<string, TaskResult>();

function makeService(): TaskProcessProjectionService {
  return new TaskProcessProjectionService({
    taskEventStore,
    approvalLedgerStore,
    codingCliStore,
    findTaskRow: (id) => taskRows.get(id),
    pendingApprovalTaskIds: () => pending,
    asyncResults: () => asyncResults,
    inFlightTaskIds: () => inFlight,
  });
}

function plantTaskRow(taskId: string, over: Partial<SessionTaskRow> = {}): SessionTaskRow {
  const row: SessionTaskRow = {
    session_id: over.session_id ?? 'sess-1',
    task_id: taskId,
    task_input_json: over.task_input_json ?? JSON.stringify({ id: taskId, goal: 'g' }),
    status: over.status ?? 'running',
    result_json: over.result_json ?? null,
    created_at: over.created_at ?? 1000,
    updated_at: over.updated_at ?? 1100,
    archived_at: over.archived_at ?? null,
  };
  taskRows.set(taskId, row);
  return row;
}

function append(
  taskId: string,
  eventType: string,
  payload: Record<string, unknown> = {},
  ts = 1000,
  sessionId = 'sess-1',
): void {
  taskEventStore.append({ taskId, sessionId, eventType, payload, ts });
}

function makeSession(over: Partial<CodingCliSessionRecord> = {}): CodingCliSessionRecord {
  return {
    id: over.id ?? `cli-${Math.random().toString(36).slice(2, 8)}`,
    taskId: over.taskId ?? 'task-1',
    sessionId: over.sessionId ?? null,
    providerId: over.providerId ?? 'claude-code',
    binaryPath: '/usr/local/bin/claude',
    binaryVersion: '0.0.1',
    capabilities: {} as never,
    cwd: '/tmp',
    pid: null,
    state: over.state ?? 'running',
    startedAt: over.startedAt ?? 2000,
    updatedAt: over.updatedAt ?? 2100,
    endedAt: over.endedAt ?? null,
    lastOutputAt: null,
    lastHookAt: null,
    transcriptPath: null,
    eventLogPath: null,
    filesChanged: over.filesChanged ?? [],
    commandsRequested: over.commandsRequested ?? [],
    finalResult: over.finalResult ?? null,
    rawMeta: {},
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  taskEventStore = new TaskEventStore(db);
  approvalLedgerStore = new ApprovalLedgerStore(db);
  codingCliStore = new CodingCliStore(db);
  taskRows.clear();
  inFlight.clear();
  pending.clear();
  asyncResults.clear();
});

afterEach(() => {
  db.close();
});

describe('TaskProcessProjectionService.build — existence', () => {
  test('returns null when the task is unknown to every store', () => {
    expect(makeService().build('task-ghost')).toBeNull();
  });

  test('returns a projection skeleton when only an in-flight signal exists', () => {
    inFlight.add('task-live');
    const proj = makeService().build('task-live');
    expect(proj).not.toBeNull();
    expect(proj!.lifecycle.status).toBe('running');
    expect(proj!.completeness.kind).toBe('empty');
  });
});

describe('TaskProcessProjectionService.build — lifecycle + completeness', () => {
  test('terminal task:complete → completed + complete', () => {
    plantTaskRow('task-1', { status: 'completed' });
    append('task-1', 'task:start', {}, 1000);
    append('task-1', 'task:complete', {}, 2000);
    const p = makeService().build('task-1')!;
    expect(p.lifecycle.status).toBe('completed');
    expect(p.lifecycle.terminalEventType).toBe('task:complete');
    expect(p.completeness.kind).toBe('complete');
    expect(p.completeness.eventCount).toBe(2);
  });

  test('terminal task:failed → failed + terminal-error', () => {
    plantTaskRow('task-2', { status: 'failed' });
    append('task-2', 'task:start', {}, 1000);
    append('task-2', 'task:failed', { reason: 'oracle-rejected' }, 2000);
    const p = makeService().build('task-2')!;
    expect(p.lifecycle.status).toBe('failed');
    expect(p.lifecycle.terminalReason).toBe('oracle-rejected');
    expect(p.completeness.kind).toBe('terminal-error');
  });

  test('open gate without terminal → awaiting-user', () => {
    plantTaskRow('task-3');
    append('task-3', 'task:start', {}, 1000);
    append('task-3', 'workflow:human_input_needed', { question: 'pick a color' }, 1500);
    const p = makeService().build('task-3')!;
    expect(p.completeness.kind).toBe('awaiting-user');
    expect(p.gates.workflowHumanInput.open).toBe(true);
    expect(p.gates.workflowHumanInput.detail).toMatchObject({ question: 'pick a color' });
  });

  test('events but no terminal and no open gate → missing-terminal', () => {
    plantTaskRow('task-4');
    append('task-4', 'task:start', {}, 1000);
    append('task-4', 'phase:timing', { phase: 'perceive', durationMs: 50 }, 1100);
    const p = makeService().build('task-4')!;
    expect(p.completeness.kind).toBe('missing-terminal');
  });

  test('result.status drives lifecycle when no terminal event recorded', () => {
    plantTaskRow('task-5', {
      status: 'completed',
      result_json: JSON.stringify({ id: 'task-5', status: 'completed', mutations: [] } satisfies Partial<TaskResult>),
    });
    const p = makeService().build('task-5')!;
    expect(p.lifecycle.status).toBe('completed');
    expect(p.lifecycle.resultStatus).toBe('completed');
  });
});

describe('TaskProcessProjectionService.build — gates', () => {
  test('partial-decision pair: open then resolved', () => {
    plantTaskRow('task-pd');
    append('task-pd', 'workflow:partial_failure_decision_needed', { reason: 'oracle-mismatch' }, 1500);
    let p = makeService().build('task-pd')!;
    expect(p.gates.partialDecision.open).toBe(true);
    expect(p.gates.partialDecision.detail).toMatchObject({ reason: 'oracle-mismatch' });

    append('task-pd', 'workflow:partial_failure_decision_provided', { decision: 'continue' }, 1700);
    p = makeService().build('task-pd')!;
    expect(p.gates.partialDecision.open).toBe(false);
    expect(p.gates.partialDecision.resolved).toBe(true);
  });

  test('approval gate prefers durable ledger over events', () => {
    plantTaskRow('task-approve');
    const result = approvalLedgerStore.createPending({
      taskId: 'task-approve',
      riskScore: 0.9,
      reason: 'high-risk write',
      now: 1500,
    });
    expect(result.ok).toBe(true);
    const p = makeService().build('task-approve')!;
    expect(p.gates.approval.open).toBe(true);
    expect(p.gates.approval.detail?.reason).toBe('high-risk write');
    expect(p.gates.approval.openedEventId).toMatch(/^approval-ledger:/);
  });

  test('coding-cli gate reads the durable approval row', () => {
    plantTaskRow('task-cli');
    codingCliStore.insert(makeSession({ id: 'cli-A', taskId: 'task-cli' }));
    codingCliStore.recordApproval({
      id: 'appr-A',
      sessionId: 'cli-A',
      taskId: 'task-cli',
      requestId: 'r-A',
      command: 'rm -rf /',
      reason: 'destructive',
      policyDecision: 'request_approval',
      humanDecision: null,
      decidedBy: null,
      decidedAt: null,
      requestedAt: 3000,
      rawJson: '{}',
    });
    let p = makeService().build('task-cli')!;
    expect(p.gates.codingCliApproval.open).toBe(true);
    expect(p.gates.codingCliApproval.detail).toMatchObject({
      sessionId: 'cli-A',
      requestId: 'r-A',
      command: 'rm -rf /',
    });

    codingCliStore.resolveApproval('cli-A', 'r-A', 'approved', 'alice', 3500);
    p = makeService().build('task-cli')!;
    expect(p.gates.codingCliApproval.open).toBe(false);
    expect(p.gates.codingCliApproval.resolved).toBe(true);
  });
});

describe('TaskProcessProjectionService.build — plan', () => {
  test('multi-agent subtasks accumulate across planned + updated events', () => {
    plantTaskRow('task-plan');
    append(
      'task-plan',
      'workflow:subtasks_planned',
      {
        groupMode: 'parallel',
        subtasks: [
          { subtaskId: 'st-1', stepId: 's1', status: 'planned', agentId: 'researcher' },
          { subtaskId: 'st-2', stepId: 's2', status: 'planned', agentId: 'author' },
        ],
      },
      1500,
    );
    append(
      'task-plan',
      'workflow:subtask_updated',
      { subtaskId: 'st-1', stepId: 's1', status: 'running', startedAt: 1600 },
      1600,
    );
    append(
      'task-plan',
      'workflow:subtask_updated',
      { subtaskId: 'st-1', stepId: 's1', status: 'completed', completedAt: 1900, outputPreview: 'done' },
      1900,
    );
    const plan = makeService().build('task-plan')!.plan;
    expect(plan.groupMode).toBe('parallel');
    expect(plan.multiAgentSubtasks).toHaveLength(2);
    const st1 = plan.multiAgentSubtasks.find((s) => s.subtaskId === 'st-1')!;
    expect(st1.status).toBe('completed');
    expect(st1.outputPreview).toBe('done');
    expect(st1.agentId).toBe('researcher');
  });

  test('todo list folds created → updated transitions (legacy `todos` payload)', () => {
    plantTaskRow('task-todos');
    append(
      'task-todos',
      'workflow:todo_created',
      { todos: [{ id: 't1', content: 'Step 1', status: 'pending' }] },
      1300,
    );
    append(
      'task-todos',
      'workflow:todo_updated',
      { todos: [{ id: 't1', status: 'completed' }] },
      1400,
    );
    const plan = makeService().build('task-todos')!.plan;
    expect(plan.todoList).toHaveLength(1);
    expect(plan.todoList[0]!.status).toBe('completed');
    expect(plan.todoList[0]!.content).toBe('Step 1');
  });

  test('todo list accepts the runtime `todoList` payload shape', () => {
    // The workflow executor emits `workflow:todo_created` with the field
    // `todoList` (workflow-executor.ts:559-564). Older fixtures used `todos`;
    // both must fold so live runs and replays behave the same.
    plantTaskRow('task-todos-real');
    append(
      'task-todos-real',
      'workflow:todo_created',
      {
        todoList: [
          { id: 'tdo-1', content: 'Researcher answers', status: 'pending', sourceStepId: 'p-researcher' },
          { id: 'tdo-2', content: 'Mentor answers', status: 'pending', sourceStepId: 'p-mentor' },
        ],
      },
      1500,
    );
    const plan = makeService().build('task-todos-real')!.plan;
    expect(plan.todoList).toHaveLength(2);
    expect(plan.todoList.map((t) => t.id)).toEqual(['tdo-1', 'tdo-2']);
    expect(plan.todoList[0]!.content).toBe('Researcher answers');
  });

  test('collaborationRounds fold per-(stepId, round) telemetry, sorted by stepId then round', () => {
    plantTaskRow('task-collab-rounds');
    // 2 agents × 2 rounds = 4 rows. Emit out of order to test sort.
    append(
      'task-collab-rounds',
      'workflow:collaboration_round',
      {
        stepId: 'p-mentor',
        subTaskId: 'task-collab-rounds-delegate-p-mentor-r0',
        agentId: 'mentor',
        round: 0,
        status: 'completed',
        tokensConsumed: 120,
        outputPreview: 'mentor r0 output',
        startedAt: 1000,
        completedAt: 1100,
      },
      1100,
    );
    append(
      'task-collab-rounds',
      'workflow:collaboration_round',
      {
        stepId: 'p-architect',
        subTaskId: 'task-collab-rounds-delegate-p-architect-r0',
        agentId: 'architect',
        round: 0,
        status: 'completed',
        tokensConsumed: 90,
        outputPreview: 'architect r0 output',
        startedAt: 1000,
        completedAt: 1100,
      },
      1100,
    );
    append(
      'task-collab-rounds',
      'workflow:collaboration_round',
      {
        stepId: 'p-architect',
        subTaskId: 'task-collab-rounds-delegate-p-architect-r1',
        agentId: 'architect',
        round: 1,
        status: 'failed',
        tokensConsumed: 0,
        errorMessage: 'mock err',
        startedAt: 1200,
        completedAt: 1300,
      },
      1300,
    );
    append(
      'task-collab-rounds',
      'workflow:collaboration_round',
      {
        stepId: 'p-mentor',
        subTaskId: 'task-collab-rounds-delegate-p-mentor-r1',
        agentId: 'mentor',
        round: 1,
        status: 'completed',
        tokensConsumed: 110,
        outputPreview: 'mentor r1 output',
        startedAt: 1200,
        completedAt: 1300,
      },
      1300,
    );
    const plan = makeService().build('task-collab-rounds')!.plan;
    expect(plan.collaborationRounds).toBeDefined();
    expect(plan.collaborationRounds!).toHaveLength(4);
    // Sorted by stepId then round; architect's two rounds first, then mentor's.
    const ordered = plan.collaborationRounds!.map((r) => `${r.stepId}-r${r.round}`);
    expect(ordered).toEqual([
      'p-architect-r0',
      'p-architect-r1',
      'p-mentor-r0',
      'p-mentor-r1',
    ]);
    const archR1 = plan.collaborationRounds!.find(
      (r) => r.stepId === 'p-architect' && r.round === 1,
    )!;
    expect(archR1.status).toBe('failed');
    expect(archR1.tokensConsumed).toBe(0);
    const mentorR1 = plan.collaborationRounds!.find(
      (r) => r.stepId === 'p-mentor' && r.round === 1,
    )!;
    expect(mentorR1.outputPreview).toBe('mentor r1 output');
    expect(mentorR1.agentId).toBe('mentor');
  });

  test('multiAgentSubtasks cardinality preserved when collaborationRounds populated', () => {
    // The "one card per agent" cardinality contract for multiAgentSubtasks
    // (collaboration-block.ts:12-16) must hold even when round-level data
    // exists. Round telemetry lives on a separate field; the agent-roster
    // card stays at 1 row per agent.
    plantTaskRow('task-card-cardinality');
    append(
      'task-card-cardinality',
      'workflow:subtasks_planned',
      {
        groupMode: 'debate',
        subtasks: [
          { subtaskId: 'st-1', stepId: 's1', status: 'planned', agentId: 'researcher' },
          { subtaskId: 'st-2', stepId: 's2', status: 'planned', agentId: 'mentor' },
        ],
      },
      1500,
    );
    // Two rounds per agent.
    for (const round of [0, 1]) {
      for (const [stepId, agentId] of [['s1', 'researcher'], ['s2', 'mentor']] as const) {
        append(
          'task-card-cardinality',
          'workflow:collaboration_round',
          {
            stepId,
            subTaskId: `task-card-cardinality-delegate-${stepId}-r${round}`,
            agentId,
            round,
            status: 'completed',
            tokensConsumed: 50,
            outputPreview: `${agentId} r${round}`,
            startedAt: 1000 + round * 100,
            completedAt: 1050 + round * 100,
          },
          1050 + round * 100,
        );
      }
    }
    const plan = makeService().build('task-card-cardinality')!.plan;
    // Cardinality contract: one row per agent, regardless of round count.
    expect(plan.multiAgentSubtasks).toHaveLength(2);
    // Round timeline holds 4 entries (2 agents × 2 rounds).
    expect(plan.collaborationRounds).toHaveLength(4);
  });

  test('plan steps fold descriptions from workflow:plan_ready', () => {
    // `workflow:plan_ready` is the authoritative source for step
    // descriptions. Without folding it the projection emits steps with
    // empty `description`, which the UI then renders blank.
    plantTaskRow('task-plan-ready');
    append(
      'task-plan-ready',
      'workflow:decision_recorded',
      { decision: { stage: 'classified' } },
      1500,
    );
    append(
      'task-plan-ready',
      'workflow:plan_ready',
      {
        goal: 'multi-agent debate',
        awaitingApproval: false,
        steps: [
          {
            id: 'p-researcher',
            description: 'researcher answers · 2 rounds',
            strategy: 'delegate-sub-agent',
            agentId: 'researcher',
            dependencies: [],
          },
          {
            id: 'synth-coordinator',
            description: 'coordinator synthesizes the final answer.',
            strategy: 'llm-reasoning',
            dependencies: ['p-researcher'],
          },
        ],
      },
      1600,
    );
    const plan = makeService().build('task-plan-ready')!.plan;
    expect(plan.steps).toHaveLength(2);
    const researcher = plan.steps.find((s) => s.id === 'p-researcher')!;
    expect(researcher.description).toBe('researcher answers · 2 rounds');
    expect(researcher.strategy).toBe('delegate-sub-agent');
    expect(researcher.agentId).toBe('researcher');
    const coord = plan.steps.find((s) => s.id === 'synth-coordinator')!;
    expect(coord.description).toBe('coordinator synthesizes the final answer.');
  });
});

describe('TaskProcessProjectionService.build — coding-cli + diagnostics + history', () => {
  test('coding-cli failureDetail surfaced from coding-cli:failed event payload', () => {
    plantTaskRow('task-cli-fail');
    codingCliStore.insert(makeSession({ id: 'cli-fail', taskId: 'task-cli-fail', state: 'failed' }));
    codingCliStore.appendEvent('cli-fail', 'coding-cli:failed', { reason: 'provider quota exhausted' }, 5000);
    const sessions = makeService().build('task-cli-fail')!.codingCliSessions;
    expect(sessions[0]!.failureDetail?.reason).toBe('provider quota exhausted');
    expect(sessions[0]!.failureDetail?.at).toBe(5000);
  });

  test('coding-cli cancelDetail surfaced from coding-cli:cancelled event payload', () => {
    plantTaskRow('task-cli-cancel');
    codingCliStore.insert(
      makeSession({ id: 'cli-cancel', taskId: 'task-cli-cancel', state: 'cancelled' }),
    );
    codingCliStore.appendEvent(
      'cli-cancel',
      'coding-cli:cancelled',
      { by: 'alice', reason: 'budget exceeded' },
      6000,
    );
    const sessions = makeService().build('task-cli-cancel')!.codingCliSessions;
    expect(sessions[0]!.cancelDetail?.by).toBe('alice');
    expect(sessions[0]!.cancelDetail?.reason).toBe('budget exceeded');
    expect(sessions[0]!.cancelDetail?.at).toBe(6000);
  });

  test('coding-cli stalledDetail surfaced from most-recent coding-cli:stalled event', () => {
    plantTaskRow('task-cli-stall');
    codingCliStore.insert(makeSession({ id: 'cli-stall', taskId: 'task-cli-stall', state: 'running' }));
    codingCliStore.appendEvent('cli-stall', 'coding-cli:stalled', { idleMs: 30_000 }, 7000);
    codingCliStore.appendEvent('cli-stall', 'coding-cli:stalled', { idleMs: 92_000 }, 7500);
    const sessions = makeService().build('task-cli-stall')!.codingCliSessions;
    expect(sessions[0]!.stalledDetail?.idleMs).toBe(92_000);
    expect(sessions[0]!.stalledDetail?.at).toBe(7500);
  });

  test('coding-cli failureDetail is NOT set when state is not failed (defensive against stale events)', () => {
    plantTaskRow('task-cli-recovered');
    codingCliStore.insert(
      makeSession({ id: 'cli-recovered', taskId: 'task-cli-recovered', state: 'completed' }),
    );
    // Stale "failed" event from an earlier attempt, then a later event
    // means the session ended in 'completed' state.
    codingCliStore.appendEvent('cli-recovered', 'coding-cli:failed', { reason: 'old' }, 8000);
    const sessions = makeService().build('task-cli-recovered')!.codingCliSessions;
    expect(sessions[0]!.failureDetail).toBeUndefined();
  });

  test('coding-cli sessions surface pending + resolved approvals', () => {
    plantTaskRow('task-cli2');
    codingCliStore.insert(makeSession({ id: 'cli-X', taskId: 'task-cli2', filesChanged: ['src/a.ts'] }));
    codingCliStore.recordApproval({
      id: 'apx',
      sessionId: 'cli-X',
      taskId: 'task-cli2',
      requestId: 'rx',
      command: 'edit',
      reason: 'edit',
      policyDecision: 'request_approval',
      humanDecision: null,
      decidedBy: null,
      decidedAt: null,
      requestedAt: 4000,
      rawJson: '{}',
    });
    codingCliStore.recordApproval({
      id: 'apx2',
      sessionId: 'cli-X',
      taskId: 'task-cli2',
      requestId: 'rx2',
      command: 'edit-2',
      reason: 'edit',
      policyDecision: 'request_approval',
      humanDecision: 'approved',
      decidedBy: 'op',
      decidedAt: 4200,
      requestedAt: 4100,
      rawJson: '{}',
    });
    const sessions = makeService().build('task-cli2')!.codingCliSessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.pendingApprovals).toHaveLength(1);
    expect(sessions[0]!.pendingApprovals[0]!.requestId).toBe('rx');
    expect(sessions[0]!.resolvedApprovals).toHaveLength(1);
    expect(sessions[0]!.resolvedApprovals[0]!.humanDecision).toBe('approved');
    expect(sessions[0]!.filesChanged).toEqual(['src/a.ts']);
  });

  test('diagnostics: phase timing + tool calls + escalations', () => {
    plantTaskRow('task-diag');
    append('task-diag', 'task:start', { routingLevel: 1 }, 1000);
    append('task-diag', 'phase:timing', { phase: 'perceive', durationMs: 50 }, 1050);
    append(
      'task-diag',
      'agent:tool_started',
      { callId: 'c1', tool: 'file_read' },
      1100,
    );
    append(
      'task-diag',
      'agent:tool_executed',
      { callId: 'c1', tool: 'file_read', status: 'success', outputPreview: 'ok' },
      1200,
    );
    append(
      'task-diag',
      'task:escalate',
      { fromLevel: 1, toLevel: 2, reason: 'oracle-disagreement' },
      1300,
    );
    const diag = makeService().build('task-diag')!.diagnostics;
    expect(diag.phases).toHaveLength(1);
    expect(diag.phases[0]!.status).toBe('completed');
    expect(diag.phases[0]!.durationMs).toBe(50);
    expect(diag.toolCalls).toHaveLength(1);
    expect(diag.toolCalls[0]!.status).toBe('success');
    expect(diag.escalations).toHaveLength(1);
    expect(diag.escalations[0]!.fromLevel).toBe(1);
    expect(diag.routingLevel).toBe(1);
  });

  test('diagnostics fold workflow lifecycle events as `workflow:<stage>` phases', () => {
    // Tasks orchestrated through the workflow executor never emit the
    // core-loop `phase:*` events, so without folding the workflow
    // lifecycle the operator sees an empty diagnostics list. Each
    // workflow stage maps to a phase row whose name is unambiguous
    // (`workflow:` prefix) and whose durations come from start/complete
    // pairs when the executor emitted them.
    plantTaskRow('task-wf-diag');
    append('task-wf-diag', 'workflow:decision_recorded', { decision: { stage: 'classified' } }, 1500);
    append(
      'task-wf-diag',
      'workflow:plan_ready',
      { goal: 'g', awaitingApproval: false, steps: [{ id: 's1', description: 'd', dependencies: [] }] },
      1600,
    );
    append('task-wf-diag', 'workflow:step_start', { stepId: 's1', startedAt: 1700 }, 1700);
    append(
      'task-wf-diag',
      'workflow:delegate_dispatched',
      { stepId: 's1', subTaskId: 'task-wf-diag-delegate-s1-r0' },
      1750,
    );
    append('task-wf-diag', 'workflow:delegate_completed', { stepId: 's1', status: 'completed' }, 2700);
    append(
      'task-wf-diag',
      'workflow:step_complete',
      { stepId: 's1', strategy: 'delegate-sub-agent', status: 'completed', durationMs: 1100 },
      2800,
    );
    const diag = makeService().build('task-wf-diag')!.diagnostics;
    const names = diag.phases.map((p) => p.name).sort();
    expect(names).toContain('workflow:decision_recorded');
    expect(names).toContain('workflow:plan_ready');
    expect(names).toContain('workflow:step:s1');
    expect(names).toContain('workflow:delegate:s1');
    const stepPhase = diag.phases.find((p) => p.name === 'workflow:step:s1')!;
    expect(stepPhase.status).toBe('completed');
    expect(stepPhase.durationMs).toBe(1100);
    const delegatePhase = diag.phases.find((p) => p.name === 'workflow:delegate:s1')!;
    expect(delegatePhase.status).toBe('completed');
  });

  test('history.descendantTaskIds reads from delegate_dispatched payloads', () => {
    plantTaskRow('task-parent');
    append(
      'task-parent',
      'workflow:delegate_dispatched',
      { subTaskId: 'task-child-1' },
      1100,
    );
    append(
      'task-parent',
      'workflow:delegate_dispatched',
      { subTaskId: 'task-child-2' },
      1200,
    );
    const history = makeService().build('task-parent')!.history;
    expect(history.descendantTaskIds).toEqual(['task-child-1', 'task-child-2']);
    expect(history.eventCount).toBe(2);
    expect(history.lastSeq).toBeGreaterThan(0);
  });
});
