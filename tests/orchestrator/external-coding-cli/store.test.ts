/**
 * CodingCliStore — verify the SQLite persistence layer. Uses a real
 * in-memory bun:sqlite database with the repo's migration runner so the
 * tested schema matches production exactly.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { CodingCliStore } from '../../../src/db/coding-cli-store.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../../src/db/migrations/index.ts';
import type {
  CodingCliCapabilities,
  CodingCliResult,
  CodingCliSessionRecord,
} from '../../../src/orchestrator/external-coding-cli/types.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  return db;
}

const CAPABILITIES: CodingCliCapabilities = {
  headless: true,
  interactive: true,
  streamProtocol: true,
  resume: false,
  nativeHooks: true,
  jsonOutput: true,
  approvalPrompts: true,
  toolEvents: true,
  fileEditEvents: true,
  transcriptAccess: false,
  statusCommand: false,
  cancelSupport: true,
};

const SAMPLE_RESULT: CodingCliResult = {
  status: 'completed',
  providerId: 'claude-code',
  summary: 'did the thing',
  changedFiles: ['src/foo.ts'],
  commandsRun: [],
  testsRun: [],
  decisions: [],
  verification: { claimedPassed: true, details: '' },
  blockers: [],
  requiresHumanReview: false,
};

function makeRecord(id: string, taskId: string): CodingCliSessionRecord {
  return {
    id,
    taskId,
    sessionId: 'sess-1',
    providerId: 'claude-code',
    binaryPath: '/usr/bin/claude',
    binaryVersion: '2.1.0',
    capabilities: CAPABILITIES,
    cwd: '/tmp',
    pid: 12345,
    state: 'running',
    startedAt: 1000,
    updatedAt: 1100,
    endedAt: null,
    lastOutputAt: 1050,
    lastHookAt: null,
    transcriptPath: null,
    eventLogPath: '/tmp/log.jsonl',
    filesChanged: ['src/foo.ts'],
    commandsRequested: [],
    finalResult: null,
    rawMeta: { providerSessionId: 'claude-sess-x' },
  };
}

describe('CodingCliStore', () => {
  test('insert + get round-trip', () => {
    const db = makeDb();
    const store = new CodingCliStore(db);
    store.insert(makeRecord('s1', 't1'));
    const retrieved = store.get('s1');
    expect(retrieved?.taskId).toBe('t1');
    expect(retrieved?.capabilities.nativeHooks).toBe(true);
  });

  test('update mutates the same row (upsert)', () => {
    const db = makeDb();
    const store = new CodingCliStore(db);
    const r = makeRecord('s2', 't2');
    store.insert(r);
    store.update({ ...r, state: 'completed', endedAt: 2000, finalResult: SAMPLE_RESULT });
    const retrieved = store.get('s2');
    expect(retrieved?.state).toBe('completed');
    expect(retrieved?.endedAt).toBe(2000);
    expect(retrieved?.finalResult?.status).toBe('completed');
  });

  test('append + list events with seq monotonicity', () => {
    const db = makeDb();
    const store = new CodingCliStore(db);
    store.insert(makeRecord('s3', 't3'));
    store.appendEvent('s3', 'coding-cli:state_changed', { from: 'created', to: 'starting' }, 1000);
    store.appendEvent('s3', 'coding-cli:tool_started', { toolName: 'Edit' }, 1010);
    const events = store.listEvents('s3');
    expect(events).toHaveLength(2);
    expect(events[0]!.seq).toBe(1);
    expect(events[1]!.seq).toBe(2);
  });

  test('approval recording + resolution', () => {
    const db = makeDb();
    const store = new CodingCliStore(db);
    store.insert(makeRecord('s4', 't4'));
    store.recordApproval({
      id: 'a1',
      sessionId: 's4',
      taskId: 't4',
      requestId: 'r1',
      command: 'rm -rf /',
      reason: 'destructive',
      policyDecision: 'require-human',
      humanDecision: null,
      decidedBy: null,
      decidedAt: null,
      requestedAt: 1000,
      rawJson: '{}',
    });
    const before = store.listApprovals('s4');
    expect(before[0]!.human_decision).toBeNull();
    store.resolveApproval('s4', 'r1', 'rejected', 'human', 1100);
    const after = store.listApprovals('s4');
    expect(after[0]!.human_decision).toBe('rejected');
    expect(after[0]!.decided_by).toBe('human');
  });

  test('decisions append + list', () => {
    const db = makeDb();
    const store = new CodingCliStore(db);
    store.insert(makeRecord('s5', 't5'));
    store.recordDecision({
      id: 'd1',
      sessionId: 's5',
      taskId: 't5',
      decision: 'use library X',
      rationale: 'because Y',
      alternativesJson: JSON.stringify(['library Z']),
      ts: 1000,
    });
    const decisions = store.listDecisions('s5');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.decision).toBe('use library X');
  });
});
