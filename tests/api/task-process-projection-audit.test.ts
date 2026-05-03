/**
 * TaskProcessProjectionService — A8 audit-log fold.
 *
 * Covers the load-bearing invariants for `auditLog` / `bySection` /
 * `provenance` / `completenessBySection` introduced by PR-4:
 *
 *   - Old tasks (no `audit:entry` rows, only legacy events) get a
 *     synthesized audit log derived from the recorded events.
 *   - New tasks with real `audit:entry` rows surface them with their
 *     UUID ids and the per-kind synthesis is suppressed.
 *   - Mixed tasks: per-kind dedup — a real `decision` entry suppresses
 *     synthesis from `agent:tool_denied` but not from `oracle:verdict`
 *     (verdict kind is unaffected).
 *   - Provenance roll-up extracts unique policyVersions, oracleIds.
 *   - Per-section completeness reports `unclassifiable` for `thoughts`
 *     until PR-5 lands and `partial` for `toolCalls` when starts have
 *     no matching `executed`.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { TaskProcessProjectionService } from '../../src/api/projections/task-process-projection.ts';
import type { AuditEntry } from '../../src/core/audit.ts';
import { ApprovalLedgerStore } from '../../src/db/approval-ledger-store.ts';
import { CodingCliStore } from '../../src/db/coding-cli-store.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import type { SessionTaskRow } from '../../src/db/session-store.ts';
import { TaskEventStore } from '../../src/db/task-event-store.ts';
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

function plantTaskRow(taskId: string): void {
  taskRows.set(taskId, {
    session_id: 'sess-1',
    task_id: taskId,
    task_input_json: JSON.stringify({ id: taskId, goal: 'audit projection' }),
    status: 'completed',
    result_json: null,
    created_at: 1000,
    updated_at: 2000,
    archived_at: null,
  });
}

function append(taskId: string, eventType: string, payload: Record<string, unknown>, ts: number): void {
  taskEventStore.append({ taskId, sessionId: 'sess-1', eventType, payload, ts });
}

const FAKE_HASH = 'a'.repeat(64);

function buildAuditEntryPayload(over: Partial<AuditEntry> & { kind: AuditEntry['kind'] }): Record<string, unknown> {
  // Returns a plain object shaped like AuditEntry so `taskEventStore.append`
  // can persist it as the event payload for the projection to safeParse.
  const base: Record<string, unknown> = {
    id: over.id ?? `entry-${Math.random().toString(36).slice(2, 10)}`,
    taskId: over.taskId ?? 'task-1',
    ts: over.ts ?? 1000,
    schemaVersion: 1,
    policyVersion: over.policyVersion ?? 'audit-v1',
    actor: over.actor ?? { type: 'orchestrator' },
    redactionPolicyHash: 'a'.repeat(64),
  };
  return { ...base, ...over };
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

describe('buildAuditLog — legacy synthesis (no real audit:entry rows)', () => {
  test('synthesizes tool_call entries from agent:tool_executed', () => {
    plantTaskRow('task-1');
    append('task-1', 'agent:tool_started', { taskId: 'task-1', toolCallId: 'c1', toolName: 'Read' }, 1000);
    append(
      'task-1',
      'agent:tool_executed',
      { taskId: 'task-1', toolCallId: 'c1', toolName: 'Read', durationMs: 12, isError: false },
      1010,
    );

    const proj = makeService().build('task-1');
    expect(proj?.auditLog?.length).toBeGreaterThanOrEqual(1);
    const toolCalls = proj?.bySection?.toolCalls ?? [];
    expect(toolCalls.length).toBe(1);
    const e = toolCalls[0];
    if (e?.kind !== 'tool_call') throw new Error('expected tool_call');
    expect(e.lifecycle).toBe('executed');
    expect(e.toolId).toBe('Read');
    expect(e.latencyMs).toBe(12);
    expect(e.id.startsWith('synth:')).toBe(true);
  });

  test('synthesizes verdict entries from oracle:verdict', () => {
    plantTaskRow('task-1');
    append(
      'task-1',
      'oracle:verdict',
      {
        taskId: 'task-1',
        oracleName: 'type-oracle',
        verdict: { verified: true, confidence: 0.9, type: 'known' },
      },
      1500,
    );

    const proj = makeService().build('task-1');
    const verdicts = proj?.bySection?.verdicts ?? [];
    expect(verdicts.length).toBe(1);
    const v = verdicts[0];
    if (v?.kind !== 'verdict') throw new Error('expected verdict');
    expect(v.source).toBe('oracle');
    expect(v.pass).toBe(true);
    expect(v.confidence).toBe(0.9);
    expect(v.oracleId).toBe('type-oracle');
  });

  test('synthesizes decision entries from agent:tool_denied + task:escalate', () => {
    plantTaskRow('task-1');
    append('task-1', 'agent:tool_denied', { taskId: 'task-1', toolName: 'shell_exec', violation: 'no shell' }, 2000);
    append('task-1', 'task:escalate', { taskId: 'task-1', fromLevel: 1, toLevel: 2, reason: 'oracle dispute' }, 3000);

    const proj = makeService().build('task-1');
    const decisions = proj?.bySection?.decisions ?? [];
    expect(decisions.length).toBe(2);
    const denyEntry = decisions.find(
      (e): e is Extract<AuditEntry, { kind: 'decision' }> => e.kind === 'decision' && e.decisionType === 'tool_deny',
    );
    expect(denyEntry?.ruleId).toBe('legacy:tool-deny');
    const escalateEntry = decisions.find(
      (e): e is Extract<AuditEntry, { kind: 'decision' }> => e.kind === 'decision' && e.decisionType === 'escalate',
    );
    expect(escalateEntry?.verdict).toBe('L1→L2');
  });
});

describe('buildAuditLog — real audit:entry rows', () => {
  test('preserves real audit:entry rows untouched', () => {
    plantTaskRow('task-1');
    append(
      'task-1',
      'audit:entry',
      buildAuditEntryPayload({
        id: 'real-1',
        kind: 'tool_call',
        actor: { type: 'worker', id: 'worker-1' },
        ts: 1100,
        lifecycle: 'executed',
        toolId: 'file_read',
        argsHash: FAKE_HASH,
        argsRedacted: { path: 'src/foo.ts' },
        latencyMs: 5,
      } as Partial<AuditEntry> & { kind: 'tool_call' }),
      1100,
    );

    const proj = makeService().build('task-1');
    expect(proj?.auditLog?.length).toBe(1);
    expect(proj?.auditLog?.[0]?.id).toBe('real-1');
    const tcs = proj?.bySection?.toolCalls ?? [];
    expect(tcs.length).toBe(1);
    if (tcs[0]?.kind !== 'tool_call') throw new Error('expected tool_call');
    expect(tcs[0].toolId).toBe('file_read');
  });

  test('per-kind dedup: real tool_call suppresses synthesis from agent:tool_executed', () => {
    plantTaskRow('task-1');
    append(
      'task-1',
      'audit:entry',
      buildAuditEntryPayload({
        id: 'real-tc',
        kind: 'tool_call',
        actor: { type: 'worker', id: 'w' },
        ts: 1100,
        lifecycle: 'executed',
        toolId: 'file_read',
        argsHash: FAKE_HASH,
        argsRedacted: {},
      } as Partial<AuditEntry> & { kind: 'tool_call' }),
      1100,
    );
    append(
      'task-1',
      'agent:tool_executed',
      { taskId: 'task-1', toolCallId: 'c1', toolName: 'Read', durationMs: 12 },
      1200,
    );

    const proj = makeService().build('task-1');
    expect(proj?.bySection?.toolCalls.length).toBe(1);
    expect(proj?.bySection?.toolCalls[0]?.id).toBe('real-tc');
  });

  test('per-kind dedup: verdict kind not present → synth from oracle:verdict still fires', () => {
    plantTaskRow('task-1');
    append(
      'task-1',
      'audit:entry',
      buildAuditEntryPayload({
        id: 'real-tc',
        kind: 'tool_call',
        actor: { type: 'worker', id: 'w' },
        ts: 1100,
        lifecycle: 'executed',
        toolId: 'file_read',
        argsHash: FAKE_HASH,
        argsRedacted: {},
      } as Partial<AuditEntry> & { kind: 'tool_call' }),
      1100,
    );
    append(
      'task-1',
      'oracle:verdict',
      { taskId: 'task-1', oracleName: 'type-oracle', verdict: { verified: false, confidence: 0.3 } },
      1300,
    );

    const proj = makeService().build('task-1');
    expect(proj?.bySection?.toolCalls.length).toBe(1);
    expect(proj?.bySection?.verdicts.length).toBe(1);
    expect(proj?.bySection?.verdicts[0]?.id.startsWith('synth:')).toBe(true);
  });

  test('drops malformed audit:entry rows without crashing', () => {
    plantTaskRow('task-1');
    // Missing `kind` field — schema invalid.
    append('task-1', 'audit:entry', { id: 'bad', taskId: 'task-1', ts: 100 }, 1100);
    // Valid one alongside.
    append(
      'task-1',
      'audit:entry',
      buildAuditEntryPayload({
        id: 'good',
        kind: 'thought',
        actor: { type: 'worker', id: 'w' },
        ts: 1200,
        content: 'thinking out loud',
      } as Partial<AuditEntry> & { kind: 'thought' }),
      1200,
    );

    const proj = makeService().build('task-1');
    expect(proj?.auditLog?.length).toBe(1);
    expect(proj?.auditLog?.[0]?.id).toBe('good');
  });
});

describe('buildAuditLog — provenance roll-up', () => {
  test('collects unique policyVersions and oracleIds', () => {
    plantTaskRow('task-1');
    append(
      'task-1',
      'audit:entry',
      buildAuditEntryPayload({
        id: 'a',
        kind: 'verdict',
        actor: { type: 'oracle', id: 'type-oracle' },
        ts: 1000,
        policyVersion: 'audit-v1',
        source: 'oracle',
        pass: true,
        oracleId: 'type-oracle',
      } as Partial<AuditEntry> & { kind: 'verdict' }),
      1000,
    );
    append(
      'task-1',
      'audit:entry',
      buildAuditEntryPayload({
        id: 'b',
        kind: 'verdict',
        actor: { type: 'oracle', id: 'dep-oracle' },
        ts: 1100,
        policyVersion: 'audit-v2',
        source: 'oracle',
        pass: false,
        oracleId: 'dep-oracle',
      } as Partial<AuditEntry> & { kind: 'verdict' }),
      1100,
    );

    const proj = makeService().build('task-1');
    expect(proj?.provenance?.policyVersions).toEqual(['audit-v1', 'audit-v2']);
    expect(proj?.provenance?.oracleIds).toEqual(['dep-oracle', 'type-oracle']);
  });
});

describe('buildAuditLog — per-section completeness', () => {
  test('thoughts section reports unclassifiable when no thought entries exist', () => {
    plantTaskRow('task-1');
    append('task-1', 'agent:tool_executed', { taskId: 'task-1', toolCallId: 'c1', toolName: 'r' }, 1000);

    const proj = makeService().build('task-1');
    const thoughts = proj?.completenessBySection?.find((c) => c.section === 'thoughts');
    expect(thoughts?.kind).toBe('unclassifiable');
    expect(thoughts?.count).toBe(0);
    expect(thoughts?.reason).toContain('thought-block boundaries');
  });

  test('toolCalls section reports partial when started lacks matching executed', () => {
    plantTaskRow('task-1');
    append('task-1', 'agent:tool_started', { taskId: 'task-1', toolCallId: 'c1', toolName: 'r' }, 1000);
    // No matching agent:tool_executed for c1.
    append('task-1', 'agent:tool_started', { taskId: 'task-1', toolCallId: 'c2', toolName: 'r' }, 1010);
    append('task-1', 'agent:tool_executed', { taskId: 'task-1', toolCallId: 'c2', toolName: 'r', durationMs: 5 }, 1020);

    const proj = makeService().build('task-1');
    const tc = proj?.completenessBySection?.find((c) => c.section === 'toolCalls');
    expect(tc?.kind).toBe('partial');
    expect(tc?.reason).toContain('1 tool_started without tool_executed');
  });

  test('toolCalls section reports complete when every started has executed', () => {
    plantTaskRow('task-1');
    append('task-1', 'agent:tool_started', { taskId: 'task-1', toolCallId: 'c1', toolName: 'r' }, 1000);
    append('task-1', 'agent:tool_executed', { taskId: 'task-1', toolCallId: 'c1', toolName: 'r', durationMs: 5 }, 1010);

    const proj = makeService().build('task-1');
    const tc = proj?.completenessBySection?.find((c) => c.section === 'toolCalls');
    expect(tc?.kind).toBe('complete');
  });
});

describe('buildAuditLog — chronological ordering', () => {
  test('sorts by ts then id for determinism', () => {
    plantTaskRow('task-1');
    append('task-1', 'agent:tool_executed', { taskId: 'task-1', toolCallId: 'c1', toolName: 'r' }, 2000);
    append('task-1', 'agent:tool_executed', { taskId: 'task-1', toolCallId: 'c2', toolName: 'r' }, 1000);

    const proj = makeService().build('task-1');
    const log = proj?.auditLog ?? [];
    expect(log.length).toBe(2);
    expect(log[0]?.ts).toBe(1000);
    expect(log[1]?.ts).toBe(2000);
  });
});

describe('buildAuditLog — Phase 2.7 byEntity rollup', () => {
  test('byEntity collects subTaskIds and subAgentIds from wrapper + variant fields', async () => {
    plantTaskRow('task-1');
    append(
      'task-1',
      'audit:entry',
      buildAuditEntryPayload({
        id: 'st-1',
        kind: 'subtask',
        actor: { type: 'orchestrator' },
        ts: 100,
        subTaskId: 'task-1-delegate-step1',
        subAgentId: 'task-1-delegate-step1',
        phase: 'spawn',
      } as Partial<AuditEntry> & { kind: 'subtask' }),
      100,
    );
    append(
      'task-1',
      'audit:entry',
      buildAuditEntryPayload({
        id: 'sa-1',
        kind: 'subagent',
        actor: { type: 'orchestrator' },
        ts: 110,
        subTaskId: 'task-1-delegate-step1',
        subAgentId: 'task-1-delegate-step1',
        phase: 'spawn',
        persona: 'researcher',
      } as Partial<AuditEntry> & { kind: 'subagent' }),
      110,
    );

    const proj = makeService().build('task-1');
    expect(proj?.byEntity?.taskId).toBe('task-1');
    expect(proj?.byEntity?.workflowId).toBe('task-1'); // alias invariant
    expect(proj?.byEntity?.subTaskIds).toEqual(['task-1-delegate-step1']);
    expect(proj?.byEntity?.subAgentIds).toEqual(['task-1-delegate-step1']);
  });

  test('byEntity surfaces sessionId from the first wrapper that carries it', async () => {
    plantTaskRow('task-1');
    append(
      'task-1',
      'audit:entry',
      buildAuditEntryPayload({
        id: 'th-1',
        kind: 'thought',
        actor: { type: 'worker', id: 'w-1' },
        ts: 100,
        sessionId: 'sess-Z',
        content: 'thinking',
      } as Partial<AuditEntry> & { kind: 'thought' }),
      100,
    );

    const proj = makeService().build('task-1');
    expect(proj?.byEntity?.sessionId).toBe('sess-Z');
  });
});

describe('buildAuditLog — Phase 2.7 new sections', () => {
  test('subTasks section folds kind:"subtask" rows', async () => {
    plantTaskRow('task-1');
    append(
      'task-1',
      'audit:entry',
      buildAuditEntryPayload({
        id: 'st-1',
        kind: 'subtask',
        actor: { type: 'orchestrator' },
        ts: 100,
        subTaskId: 'task-1-delegate-step1',
        phase: 'return',
        outputHash: 'a'.repeat(64),
      } as Partial<AuditEntry> & { kind: 'subtask' }),
      100,
    );
    const proj = makeService().build('task-1');
    expect(proj?.bySection?.subTasks.length).toBe(1);
    expect(proj?.bySection?.subAgents.length).toBe(0);
  });

  test('workflowEvents section folds kind:"workflow" rows', async () => {
    plantTaskRow('task-1');
    append(
      'task-1',
      'audit:entry',
      buildAuditEntryPayload({
        id: 'wf-1',
        kind: 'workflow',
        actor: { type: 'orchestrator' },
        ts: 100,
        phase: 'planned',
        planHash: 'b'.repeat(64),
      } as Partial<AuditEntry> & { kind: 'workflow' }),
      100,
    );
    const proj = makeService().build('task-1');
    expect(proj?.bySection?.workflowEvents.length).toBe(1);
  });

  test('synthesis: workflow:plan_ready legacy event becomes a kind:"workflow" row when no real ones exist', () => {
    plantTaskRow('task-1');
    append('task-1', 'workflow:plan_ready', { taskId: 'task-1', steps: [] }, 1000);
    const proj = makeService().build('task-1');
    const wf = proj?.bySection?.workflowEvents ?? [];
    expect(wf.length).toBe(1);
    if (wf[0]?.kind !== 'workflow') throw new Error('expected workflow');
    expect(wf[0].phase).toBe('planned');
  });
});

describe('buildAuditLog — Phase 2.7 provenance.capabilityTokenIds', () => {
  test('collects capabilityTokenId from tool_call + subagent rows', async () => {
    plantTaskRow('task-1');
    append(
      'task-1',
      'audit:entry',
      buildAuditEntryPayload({
        id: 'tc-1',
        kind: 'tool_call',
        actor: { type: 'worker', id: 'w' },
        ts: 100,
        lifecycle: 'denied',
        toolId: 'shell_exec',
        argsHash: 'a'.repeat(64),
        capabilityTokenId: 'cap-tok-A',
      } as Partial<AuditEntry> & { kind: 'tool_call' }),
      100,
    );
    append(
      'task-1',
      'audit:entry',
      buildAuditEntryPayload({
        id: 'sa-1',
        kind: 'subagent',
        actor: { type: 'orchestrator' },
        ts: 110,
        subAgentId: 'task-1-d-1',
        phase: 'spawn',
        capabilityTokenId: 'cap-tok-B',
      } as Partial<AuditEntry> & { kind: 'subagent' }),
      110,
    );
    const proj = makeService().build('task-1');
    expect(proj?.provenance?.capabilityTokenIds).toEqual(['cap-tok-A', 'cap-tok-B']);
  });
});
