/**
 * SessionManager — dual-write integration tests (Phase 2).
 *
 * Asserts that with the JSONL appender wired, every public mutator:
 *   1. emits exactly one JSONL line per logical operation,
 *   2. leaves SQLite consistent with the JSONL fold,
 *   3. produces a verifier report with `matches=true`.
 *
 * Negative test: when the appender is NOT wired, behavior is unchanged
 * (legacy SQLite-only path) — covers the "tests that don't construct an
 * appender are unaffected" contract from Phase 2 design.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../../src/api/session-manager.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { JsonlAppender } from '../../src/db/session-jsonl/appender.ts';
import { makeFsyncPolicy } from '../../src/db/session-jsonl/fsync-policy.ts';
import { JsonlReader } from '../../src/db/session-jsonl/reader.ts';
import { IndexRebuilder } from '../../src/db/session-jsonl/rebuild-index.ts';
import { SessionVerifier } from '../../src/db/session-jsonl/verifier.ts';
import { SessionStore } from '../../src/db/session-store.ts';
import type { TaskInput, TaskResult } from '../../src/orchestrator/types.ts';

let db: Database;
let store: SessionStore;
let manager: SessionManager;
let layout: { sessionsDir: string };
let appender: JsonlAppender;
let rebuilder: IndexRebuilder;
let verifier: SessionVerifier;
let reader: JsonlReader;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  store = new SessionStore(db);
  layout = { sessionsDir: mkdtempSync(join(tmpdir(), 'vinyan-dualwrite-')) };
  appender = new JsonlAppender({ layout, policy: makeFsyncPolicy('none') });
  rebuilder = new IndexRebuilder(db, layout);
  verifier = new SessionVerifier(db, layout);
  reader = new JsonlReader(layout);
  manager = new SessionManager(store);
  manager.attachJsonlLayer(appender, rebuilder);
});

afterEach(() => {
  db.close();
});

function makeTaskInput(id: string): TaskInput {
  return {
    id,
    source: 'api',
    goal: `Test ${id}`,
    taskType: 'code',
    budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 1 },
  };
}

function makeTaskResult(id: string, status: 'completed' | 'failed' = 'completed'): TaskResult {
  return {
    id,
    status,
    mutations: [],
    trace: {
      id: `trace-${id}`,
      taskId: id,
      sessionId: 'sess',
      workerId: 'w',
      timestamp: 1,
      routingLevel: 0,
      approach: 'test',
      oracleVerdicts: {},
      modelUsed: 'none',
      tokensConsumed: 5,
      durationMs: 1,
      outcome: status === 'completed' ? 'success' : 'failure',
      affectedFiles: [],
    },
  };
}

function lineCount(sessionId: string): number {
  return reader.scanAll(sessionId).lines.length;
}

describe('SessionManager dual-write — write path coverage', () => {
  test('create() emits session.created and verifier matches', () => {
    const session = manager.create('cli', { title: 'hello' });
    const lines = reader.scanAll(session.id).lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]?.line.kind).toBe('session.created');
    expect(verifier.verify(session.id).matches).toBe(true);
  });

  test('updateMetadata() emits session.metadata.updated', () => {
    const s = manager.create('cli');
    manager.updateMetadata(s.id, { title: 'renamed' });
    const lines = reader.scanAll(s.id).lines;
    expect(lines.map((l) => l.line.kind)).toEqual(['session.created', 'session.metadata.updated']);
    expect(manager.get(s.id)?.title).toBe('renamed');
    expect(verifier.verify(s.id).matches).toBe(true);
  });

  test('archive / unarchive emit lifecycle lines and toggle archived_at', () => {
    const s = manager.create('cli');
    expect(manager.archive(s.id).applied).toBe(true);
    expect(manager.get(s.id)?.archivedAt).not.toBeNull();
    expect(manager.unarchive(s.id).applied).toBe(true);
    expect(manager.get(s.id)?.archivedAt).toBeNull();
    const kinds = reader.scanAll(s.id).lines.map((l) => l.line.kind);
    expect(kinds).toEqual(['session.created', 'session.archived', 'session.unarchived']);
    expect(verifier.verify(s.id).matches).toBe(true);
  });

  test('softDelete / restore emit deleted/restored', () => {
    const s = manager.create('cli');
    manager.softDelete(s.id);
    manager.restore(s.id);
    const kinds = reader.scanAll(s.id).lines.map((l) => l.line.kind);
    expect(kinds).toEqual(['session.created', 'session.deleted', 'session.restored']);
    expect(manager.get(s.id)?.deletedAt).toBeNull();
    expect(verifier.verify(s.id).matches).toBe(true);
  });

  test('addTask + completeTask append task.created + task.status.changed', () => {
    const s = manager.create('cli');
    manager.addTask(s.id, makeTaskInput('t1'));
    manager.completeTask(s.id, 't1', makeTaskResult('t1', 'completed'));
    const kinds = reader.scanAll(s.id).lines.map((l) => l.line.kind);
    expect(kinds).toEqual(['session.created', 'task.created', 'task.status.changed']);
    expect(verifier.verify(s.id).matches).toBe(true);
  });

  test('cancelTask records cancelled + result is preserved', () => {
    const s = manager.create('cli');
    manager.addTask(s.id, makeTaskInput('t-cancel'));
    expect(manager.cancelTask(s.id, 't-cancel', 'reason')).toBe(true);
    const kinds = reader.scanAll(s.id).lines.map((l) => l.line.kind);
    expect(kinds).toEqual(['session.created', 'task.created', 'task.status.changed']);
    const taskRow = store.getTask(s.id, 't-cancel');
    expect(taskRow?.status).toBe('cancelled');
    expect(verifier.verify(s.id).matches).toBe(true);
  });

  test('archiveTask appends task.archived', () => {
    const s = manager.create('cli');
    manager.addTask(s.id, makeTaskInput('t-arc'));
    expect(manager.archiveTask('t-arc')).toBe(true);
    const kinds = reader.scanAll(s.id).lines.map((l) => l.line.kind);
    expect(kinds).toEqual(['session.created', 'task.created', 'task.archived']);
    expect(verifier.verify(s.id).matches).toBe(true);
  });

  test('compact() appends session.compacted and persists CompactionResult', () => {
    const s = manager.create('cli');
    manager.addTask(s.id, makeTaskInput('t1'));
    manager.completeTask(s.id, 't1', makeTaskResult('t1', 'completed'));
    const compaction = manager.compact(s.id);
    expect(compaction.statistics.totalTasks).toBe(1);
    const kinds = reader.scanAll(s.id).lines.map((l) => l.line.kind);
    expect(kinds[kinds.length - 1]).toBe('session.compacted');
    expect(verifier.verify(s.id).matches).toBe(true);
  });

  test('recordUserTurn appends turn.appended (role=user) + updates turn_summary', () => {
    const s = manager.create('cli');
    manager.recordUserTurn(s.id, 'hi there');
    const lines = reader.scanAll(s.id).lines;
    const turnLine = lines.find((l) => l.line.kind === 'turn.appended');
    expect(turnLine).toBeDefined();
    const payload = turnLine!.line.payload as { role: string; blocks: unknown[] };
    expect(payload.role).toBe('user');
    const summary = db.query('SELECT * FROM session_turn_summary WHERE session_id = ?').get(s.id) as {
      latest_turn_role: string;
      turn_count: number;
    };
    expect(summary.latest_turn_role).toBe('user');
    expect(summary.turn_count).toBe(1);
    expect(verifier.verify(s.id).matches).toBe(true);
  });

  test('recordAssistantTurn appends turn.appended (role=assistant) + updates turn_summary', () => {
    const s = manager.create('cli');
    manager.addTask(s.id, makeTaskInput('t1'));
    manager.completeTask(s.id, 't1', { ...makeTaskResult('t1', 'completed'), answer: 'hello' });
    manager.recordAssistantTurn(s.id, 't1', { ...makeTaskResult('t1', 'completed'), answer: 'hello' });
    const summary = db.query('SELECT * FROM session_turn_summary WHERE session_id = ?').get(s.id) as {
      latest_turn_role: string;
      turn_count: number;
    };
    expect(summary.latest_turn_role).toBe('assistant');
    expect(summary.turn_count).toBe(1);
    expect(verifier.verify(s.id).matches).toBe(true);
  });

  test('seq is gapless across mixed lifecycle + turn writes', () => {
    const s = manager.create('cli');
    manager.recordUserTurn(s.id, 'first');
    manager.addTask(s.id, makeTaskInput('t1'));
    manager.completeTask(s.id, 't1', { ...makeTaskResult('t1', 'completed'), answer: 'ok' });
    manager.recordAssistantTurn(s.id, 't1', { ...makeTaskResult('t1', 'completed'), answer: 'ok' });
    manager.archive(s.id);
    const seqs = reader.scanAll(s.id).lines.map((l) => l.line.seq);
    expect(seqs).toEqual([0, 1, 2, 3, 4, 5]);
    expect(verifier.verify(s.id).matches).toBe(true);
  });

  test('updateLastLineCursor reflects the most recent append', () => {
    const s = manager.create('cli');
    manager.recordUserTurn(s.id, 'one');
    manager.recordUserTurn(s.id, 'two');
    const lines = reader.scanAll(s.id);
    const tail = lines.lines[lines.lines.length - 1]!;
    const row = db.query('SELECT last_line_id, last_line_offset FROM session_store WHERE id = ?').get(s.id) as {
      last_line_id: string;
      last_line_offset: number;
    };
    expect(row.last_line_id).toBe(tail.line.lineId);
    expect(row.last_line_offset).toBe(lines.endOffset);
  });
});

describe('SessionManager dual-write — opt-out (legacy path)', () => {
  test('without attachJsonlLayer, no JSONL files are written', () => {
    const isolatedDb = new Database(':memory:');
    isolatedDb.exec('PRAGMA foreign_keys = ON');
    new MigrationRunner().migrate(isolatedDb, ALL_MIGRATIONS);
    const isolatedStore = new SessionStore(isolatedDb);
    const isolatedLayout = { sessionsDir: mkdtempSync(join(tmpdir(), 'vinyan-legacy-')) };
    const legacyManager = new SessionManager(isolatedStore);
    const session = legacyManager.create('cli', { title: 't' });
    legacyManager.recordUserTurn(session.id, 'hi');
    const isolatedReader = new JsonlReader(isolatedLayout);
    expect(isolatedReader.scanAll(session.id).lines).toEqual([]);
    isolatedDb.close();
  });
});

describe('SessionManager dual-write — verifier', () => {
  test('verifier reports matches=true after a normal session lifecycle', () => {
    const s = manager.create('cli');
    manager.recordUserTurn(s.id, 'hi');
    manager.addTask(s.id, makeTaskInput('t'));
    manager.completeTask(s.id, 't', makeTaskResult('t', 'completed'));
    manager.recordAssistantTurn(s.id, 't', makeTaskResult('t', 'completed'));
    const report = verifier.verify(s.id);
    expect(report.matches).toBe(true);
    expect(report.deltas).toEqual([]);
    expect(report.linesScanned).toBe(5);
  });

  test('verifier flags drift when SQLite is mutated out-of-band', () => {
    const s = manager.create('cli');
    manager.updateMetadata(s.id, { title: 'A' });
    // Simulate corruption: change SQLite directly without JSONL line.
    db.run('UPDATE session_store SET title = ? WHERE id = ?', ['B', s.id]);
    const report = verifier.verify(s.id);
    expect(report.matches).toBe(false);
    expect(report.deltas.some((d) => d.field === 'title')).toBe(true);
  });

  test('verifier reports noJsonl=true for legacy sessions with no JSONL log', () => {
    // Insert a session_store row directly — simulating a pre-Phase-2 record.
    const id = 'legacy-only';
    db.run('INSERT INTO session_store (id, source, created_at, status, updated_at) VALUES (?, ?, ?, ?, ?)', [
      id,
      'cli',
      1,
      'active',
      1,
    ]);
    const report = verifier.verify(id);
    expect(report.noJsonl).toBe(true);
    expect(report.matches).toBe(true);
  });

  test('IndexRebuilder reconciles after a manual SQLite drift', () => {
    const s = manager.create('cli');
    manager.updateMetadata(s.id, { title: 'expected' });
    db.run('UPDATE session_store SET title = ? WHERE id = ?', ['drifted', s.id]);
    expect(verifier.verify(s.id).matches).toBe(false);
    rebuilder.rebuildSessionIndex(s.id);
    expect(verifier.verify(s.id).matches).toBe(true);
    const row = db.query('SELECT title FROM session_store WHERE id = ?').get(s.id) as { title: string };
    expect(row.title).toBe('expected');
  });
});
