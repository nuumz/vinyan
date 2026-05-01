/**
 * CodingCliStore — open-approval lookups by taskId.
 *
 * Pins the contract that the operations console relies on for
 * `needsActionType: 'coding-cli-approval'`: durable rows with
 * `human_decision IS NULL` are treated as open. Resolved rows
 * (`human_decision != NULL` AND `decided_at != NULL`) drop out of the
 * lookup.
 *
 * Frontend MUST consume these rather than folding raw events.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { CodingCliStore } from '../../src/db/coding-cli-store.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import type { CodingCliSessionRecord } from '../../src/orchestrator/external-coding-cli/types.ts';

let db: Database;
let store: CodingCliStore;

function makeSession(over: Partial<CodingCliSessionRecord> = {}): CodingCliSessionRecord {
  const id = over.id ?? `cli-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    taskId: over.taskId ?? 'task-default',
    sessionId: over.sessionId ?? null,
    providerId: over.providerId ?? 'claude-code',
    binaryPath: over.binaryPath ?? '/usr/local/bin/claude',
    binaryVersion: over.binaryVersion ?? '0.0.1',
    capabilities: over.capabilities ?? ({} as never),
    cwd: over.cwd ?? '/tmp/cwd',
    pid: over.pid ?? null,
    state: over.state ?? 'running',
    startedAt: over.startedAt ?? Date.now(),
    updatedAt: over.updatedAt ?? Date.now(),
    endedAt: over.endedAt ?? null,
    lastOutputAt: over.lastOutputAt ?? null,
    lastHookAt: over.lastHookAt ?? null,
    transcriptPath: over.transcriptPath ?? null,
    eventLogPath: over.eventLogPath ?? null,
    filesChanged: over.filesChanged ?? [],
    commandsRequested: over.commandsRequested ?? [],
    finalResult: over.finalResult ?? null,
    rawMeta: over.rawMeta ?? {},
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  store = new CodingCliStore(db);
});

afterEach(() => {
  db.close();
});

describe('CodingCliStore.hasOpenApprovalForTask', () => {
  test('returns false when the task has no approvals at all', () => {
    expect(store.hasOpenApprovalForTask('task-empty')).toBe(false);
  });

  test('returns true when an approval row is unresolved (human_decision IS NULL)', () => {
    store.insert(makeSession({ id: 'cli-A', taskId: 'task-A' }));
    store.recordApproval({
      id: 'appr-1',
      sessionId: 'cli-A',
      taskId: 'task-A',
      requestId: 'req-1',
      command: 'rm -rf /',
      reason: 'destructive',
      policyDecision: 'request_approval',
      humanDecision: null,
      decidedBy: null,
      decidedAt: null,
      requestedAt: 1000,
      rawJson: '{}',
    });
    expect(store.hasOpenApprovalForTask('task-A')).toBe(true);
  });

  test('returns false when the only approval has been resolved', () => {
    store.insert(makeSession({ id: 'cli-B', taskId: 'task-B' }));
    store.recordApproval({
      id: 'appr-2',
      sessionId: 'cli-B',
      taskId: 'task-B',
      requestId: 'req-2',
      command: 'echo ok',
      reason: 'safe',
      policyDecision: 'request_approval',
      humanDecision: null,
      decidedBy: null,
      decidedAt: null,
      requestedAt: 2000,
      rawJson: '{}',
    });
    expect(store.hasOpenApprovalForTask('task-B')).toBe(true);
    store.resolveApproval('cli-B', 'req-2', 'approved', 'alice', 2500);
    expect(store.hasOpenApprovalForTask('task-B')).toBe(false);
  });

  test('returns true when at least one of multiple approvals is still open', () => {
    store.insert(makeSession({ id: 'cli-C', taskId: 'task-C' }));
    store.recordApproval({
      id: 'appr-c1',
      sessionId: 'cli-C',
      taskId: 'task-C',
      requestId: 'r1',
      command: 'cmd-1',
      reason: 'a',
      policyDecision: 'request_approval',
      humanDecision: null,
      decidedBy: null,
      decidedAt: null,
      requestedAt: 3000,
      rawJson: '{}',
    });
    store.recordApproval({
      id: 'appr-c2',
      sessionId: 'cli-C',
      taskId: 'task-C',
      requestId: 'r2',
      command: 'cmd-2',
      reason: 'b',
      policyDecision: 'request_approval',
      humanDecision: null,
      decidedBy: null,
      decidedAt: null,
      requestedAt: 3100,
      rawJson: '{}',
    });
    store.resolveApproval('cli-C', 'r1', 'approved', 'alice', 3200);
    expect(store.hasOpenApprovalForTask('task-C')).toBe(true);
  });

  test('does not cross-contaminate between tasks', () => {
    store.insert(makeSession({ id: 'cli-X', taskId: 'task-X' }));
    store.insert(makeSession({ id: 'cli-Y', taskId: 'task-Y' }));
    store.recordApproval({
      id: 'appr-x',
      sessionId: 'cli-X',
      taskId: 'task-X',
      requestId: 'rx',
      command: 'cmd-x',
      reason: 'x',
      policyDecision: 'request_approval',
      humanDecision: null,
      decidedBy: null,
      decidedAt: null,
      requestedAt: 4000,
      rawJson: '{}',
    });
    expect(store.hasOpenApprovalForTask('task-X')).toBe(true);
    expect(store.hasOpenApprovalForTask('task-Y')).toBe(false);
  });
});

describe('CodingCliStore.listOpenApprovalsForTasks', () => {
  test('returns an empty map for an empty input list', () => {
    const map = store.listOpenApprovalsForTasks([]);
    expect(map.size).toBe(0);
  });

  test('groups open approvals by task_id and orders by requested_at ASC', () => {
    store.insert(makeSession({ id: 'cli-1', taskId: 'task-1' }));
    store.insert(makeSession({ id: 'cli-2', taskId: 'task-2' }));
    store.recordApproval({
      id: 'a-1b',
      sessionId: 'cli-1',
      taskId: 'task-1',
      requestId: 'r-1b',
      command: 'b',
      reason: 'b',
      policyDecision: 'request_approval',
      humanDecision: null,
      decidedBy: null,
      decidedAt: null,
      requestedAt: 5100,
      rawJson: '{}',
    });
    store.recordApproval({
      id: 'a-1a',
      sessionId: 'cli-1',
      taskId: 'task-1',
      requestId: 'r-1a',
      command: 'a',
      reason: 'a',
      policyDecision: 'request_approval',
      humanDecision: null,
      decidedBy: null,
      decidedAt: null,
      requestedAt: 5000,
      rawJson: '{}',
    });
    store.recordApproval({
      id: 'a-2',
      sessionId: 'cli-2',
      taskId: 'task-2',
      requestId: 'r-2',
      command: 'cmd-2',
      reason: '2',
      policyDecision: 'request_approval',
      humanDecision: null,
      decidedBy: null,
      decidedAt: null,
      requestedAt: 5050,
      rawJson: '{}',
    });

    const map = store.listOpenApprovalsForTasks(['task-1', 'task-2', 'task-empty']);
    expect(map.size).toBe(2);
    expect(map.has('task-empty')).toBe(false);
    const t1 = map.get('task-1') ?? [];
    expect(t1.map((r) => r.request_id)).toEqual(['r-1a', 'r-1b']);
    const t2 = map.get('task-2') ?? [];
    expect(t2.map((r) => r.request_id)).toEqual(['r-2']);
  });

  test('omits tasks whose approvals are all resolved', () => {
    store.insert(makeSession({ id: 'cli-r', taskId: 'task-r' }));
    store.recordApproval({
      id: 'a-r',
      sessionId: 'cli-r',
      taskId: 'task-r',
      requestId: 'rr',
      command: 'cmd',
      reason: '-',
      policyDecision: 'request_approval',
      humanDecision: null,
      decidedBy: null,
      decidedAt: null,
      requestedAt: 6000,
      rawJson: '{}',
    });
    store.resolveApproval('cli-r', 'rr', 'rejected', 'bob', 6100);
    const map = store.listOpenApprovalsForTasks(['task-r']);
    expect(map.has('task-r')).toBe(false);
  });

  test('chunks correctly when the input list exceeds the SQLite parameter limit', () => {
    const taskIds: string[] = [];
    for (let i = 0; i < 1100; i++) {
      const id = `task-bulk-${i}`;
      taskIds.push(id);
    }
    // Plant just one open approval inside the chunk boundary.
    store.insert(makeSession({ id: 'cli-bulk', taskId: 'task-bulk-700' }));
    store.recordApproval({
      id: 'a-bulk',
      sessionId: 'cli-bulk',
      taskId: 'task-bulk-700',
      requestId: 'rb',
      command: 'cmd',
      reason: '-',
      policyDecision: 'request_approval',
      humanDecision: null,
      decidedBy: null,
      decidedAt: null,
      requestedAt: 7000,
      rawJson: '{}',
    });
    const map = store.listOpenApprovalsForTasks(taskIds);
    expect(map.size).toBe(1);
    expect(map.has('task-bulk-700')).toBe(true);
  });
});
