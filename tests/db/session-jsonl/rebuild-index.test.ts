/**
 * IndexRebuilder — Phase 1 unit tests.
 *
 * Exercises: golden JSONL → expected SQLite index state, idempotence,
 * malformed-line tolerance, edge cases (no `session.created` line,
 * task lifecycle, turn summary).
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migration001 } from '../../../src/db/migrations/001_initial_schema.ts';
import { migration036 } from '../../../src/db/migrations/036_session_jsonl_index.ts';
import { MigrationRunner } from '../../../src/db/migrations/migration-runner.ts';
import { JsonlAppender } from '../../../src/db/session-jsonl/appender.ts';
import { makeFsyncPolicy } from '../../../src/db/session-jsonl/fsync-policy.ts';
import { IndexRebuilder } from '../../../src/db/session-jsonl/rebuild-index.ts';

function setupDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, [migration001, migration036]);
  return db;
}

function makeLayout(): { sessionsDir: string } {
  return { sessionsDir: mkdtempSync(join(tmpdir(), 'vinyan-rebuild-')) };
}

function newAppender(layout: { sessionsDir: string }) {
  let n = 0;
  return new JsonlAppender({
    layout,
    policy: makeFsyncPolicy('none'),
    now: () => 1_700_000_000_000 + n,
    newId: () => `id-${++n}`,
  });
}

describe('IndexRebuilder', () => {
  test('writes a session_store row that mirrors the JSONL fold', async () => {
    const db = setupDb();
    const layout = makeLayout();
    const appender = newAppender(layout);

    await appender.append('s1', {
      kind: 'session.created',
      payload: { source: 'cli', title: 'My Session', description: 'desc' },
      actor: { kind: 'cli' },
    });
    await appender.append('s1', {
      kind: 'session.metadata.updated',
      payload: { title: 'Renamed' },
      actor: { kind: 'user' },
    });

    const rebuilder = new IndexRebuilder(db, layout);
    const report = rebuilder.rebuildSessionIndex('s1');
    expect(report.linesRead).toBe(2);
    expect(report.errors).toBe(0);

    const row = db.query('SELECT * FROM session_store WHERE id = ?').get('s1') as {
      id: string;
      source: string;
      status: string;
      title: string;
      description: string;
      last_line_id: string;
      last_line_offset: number;
    };
    expect(row.id).toBe('s1');
    expect(row.source).toBe('cli');
    expect(row.title).toBe('Renamed');
    expect(row.description).toBe('desc');
    expect(row.status).toBe('active');
    expect(report.lastLineId).not.toBeNull();
    expect(row.last_line_id).toBe(report.lastLineId as string);
    expect(row.last_line_offset).toBe(report.endOffset);
  });

  test('folds task lifecycle into session_tasks (created + status.changed + result)', async () => {
    const db = setupDb();
    const layout = makeLayout();
    const appender = newAppender(layout);

    await appender.append('s2', {
      kind: 'session.created',
      payload: { source: 'cli' },
      actor: { kind: 'cli' },
    });
    await appender.append('s2', {
      kind: 'task.created',
      payload: { taskId: 'task-1', input: { goal: 'do thing' } },
      actor: { kind: 'orchestrator' },
    });
    await appender.append('s2', {
      kind: 'task.status.changed',
      payload: { taskId: 'task-1', from: 'pending', to: 'running' },
      actor: { kind: 'orchestrator' },
    });
    await appender.append('s2', {
      kind: 'task.status.changed',
      payload: { taskId: 'task-1', from: 'running', to: 'completed', result: { ok: true } },
      actor: { kind: 'orchestrator' },
    });

    new IndexRebuilder(db, layout).rebuildSessionIndex('s2');

    const tasks = db
      .query('SELECT task_id, status, result_json FROM session_tasks WHERE session_id = ?')
      .all('s2') as Array<{ task_id: string; status: string; result_json: string }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.task_id).toBe('task-1');
    expect(tasks[0]?.status).toBe('completed');
    expect(JSON.parse(tasks[0]?.result_json ?? '{}')).toEqual({ ok: true });
  });

  test('updates session_turn_summary with latest turn metadata', async () => {
    const db = setupDb();
    const layout = makeLayout();
    const appender = newAppender(layout);

    await appender.append('s3', {
      kind: 'session.created',
      payload: { source: 'cli' },
      actor: { kind: 'cli' },
    });
    await appender.append('s3', {
      kind: 'turn.appended',
      payload: { turnId: 'tu', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
      actor: { kind: 'user' },
    });
    await appender.append('s3', {
      kind: 'turn.appended',
      payload: { turnId: 'ta', role: 'assistant', blocks: [{ type: 'text', text: 'hello' }] },
      actor: { kind: 'agent' },
    });

    new IndexRebuilder(db, layout).rebuildSessionIndex('s3');

    const summary = db.query('SELECT * FROM session_turn_summary WHERE session_id = ?').get('s3') as {
      session_id: string;
      latest_turn_id: string;
      latest_turn_role: string;
      latest_turn_blocks_preview: string;
      turn_count: number;
    };
    expect(summary.session_id).toBe('s3');
    expect(summary.latest_turn_role).toBe('assistant');
    expect(summary.latest_turn_id).toBe('ta');
    expect(summary.turn_count).toBe(2);
    expect(JSON.parse(summary.latest_turn_blocks_preview)).toEqual([{ type: 'text', text: 'hello' }]);
  });

  test('archive / unarchive / delete / restore reflect on the row', async () => {
    const db = setupDb();
    const layout = makeLayout();
    const appender = newAppender(layout);

    await appender.append('s4', { kind: 'session.created', payload: { source: 'cli' }, actor: { kind: 'cli' } });
    await appender.append('s4', { kind: 'session.archived', payload: {}, actor: { kind: 'user' } });
    new IndexRebuilder(db, layout).rebuildSessionIndex('s4');
    let row = db.query('SELECT archived_at, deleted_at FROM session_store WHERE id = ?').get('s4') as {
      archived_at: number | null;
      deleted_at: number | null;
    };
    expect(row.archived_at).not.toBeNull();
    expect(row.deleted_at).toBeNull();

    await appender.append('s4', { kind: 'session.unarchived', payload: {}, actor: { kind: 'user' } });
    await appender.append('s4', { kind: 'session.deleted', payload: {}, actor: { kind: 'user' } });
    new IndexRebuilder(db, layout).rebuildSessionIndex('s4');
    row = db.query('SELECT archived_at, deleted_at FROM session_store WHERE id = ?').get('s4') as {
      archived_at: number | null;
      deleted_at: number | null;
    };
    expect(row.archived_at).toBeNull();
    expect(row.deleted_at).not.toBeNull();
  });

  test('rebuild is idempotent — running twice yields the same row', async () => {
    const db = setupDb();
    const layout = makeLayout();
    const appender = newAppender(layout);

    await appender.append('s5', {
      kind: 'session.created',
      payload: { source: 'cli', title: 'idem' },
      actor: { kind: 'cli' },
    });
    await appender.append('s5', {
      kind: 'task.created',
      payload: { taskId: 'tk', input: {} },
      actor: { kind: 'orchestrator' },
    });

    const rebuilder = new IndexRebuilder(db, layout);
    rebuilder.rebuildSessionIndex('s5');
    const firstSession = db.query('SELECT * FROM session_store WHERE id = ?').get('s5');
    const firstTasks = db.query('SELECT * FROM session_tasks WHERE session_id = ?').all('s5');
    rebuilder.rebuildSessionIndex('s5');
    const secondSession = db.query('SELECT * FROM session_store WHERE id = ?').get('s5');
    const secondTasks = db.query('SELECT * FROM session_tasks WHERE session_id = ?').all('s5');
    expect(secondSession).toEqual(firstSession);
    expect(secondTasks).toEqual(firstTasks);
  });

  test('skips folding when there is no session.created line', async () => {
    const db = setupDb();
    const layout = makeLayout();
    const appender = newAppender(layout);

    // No session.created — only an orphan turn line.
    await appender.append('s6', {
      kind: 'turn.appended',
      payload: { turnId: 'orphan', role: 'user', blocks: [] },
      actor: { kind: 'user' },
    });
    new IndexRebuilder(db, layout).rebuildSessionIndex('s6');
    const row = db.query('SELECT id FROM session_store WHERE id = ?').get('s6');
    expect(row).toBeNull();
  });

  test('rebuildAll iterates every existing session_store row', async () => {
    const db = setupDb();
    const layout = makeLayout();
    const appender = newAppender(layout);

    await appender.append('a', { kind: 'session.created', payload: { source: 'cli' }, actor: { kind: 'cli' } });
    await appender.append('b', { kind: 'session.created', payload: { source: 'api' }, actor: { kind: 'api' } });
    const rebuilder = new IndexRebuilder(db, layout);
    rebuilder.rebuildSessionIndex('a');
    rebuilder.rebuildSessionIndex('b');
    const reports = rebuilder.rebuildAll();
    expect(reports.map((r) => r.sessionId).sort()).toEqual(['a', 'b']);
  });
});
