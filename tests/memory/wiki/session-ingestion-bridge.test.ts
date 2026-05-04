/**
 * Memory Wiki — session ingestion bridge contract.
 *
 * Pins the bridge's three triggers (`session:archived`, `session:compacted`,
 * `task:complete`), the per-session debounce on `task:complete`, and the
 * graceful-degrade behavior on unknown sessions / missing payloads.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createBus } from '../../../src/core/bus.ts';
import { migration001 } from '../../../src/db/migrations/001_initial_schema.ts';
import { MigrationRunner } from '../../../src/db/migrations/migration-runner.ts';
import { SessionStore } from '../../../src/db/session-store.ts';
import { MemoryWikiIngestor } from '../../../src/memory/wiki/ingest.ts';
import { PageWriter } from '../../../src/memory/wiki/page-writer.ts';
import {
  attachSessionIngestionBridge,
  type SessionIngestionTrigger,
} from '../../../src/memory/wiki/session-ingestion-bridge.ts';
import { MemoryWikiStore } from '../../../src/memory/wiki/store.ts';
import type { ExecutionTrace, TaskResult } from '../../../src/orchestrator/types.ts';

function makeResult(taskId: string, sessionId: string, status: TaskResult['status'] = 'completed'): TaskResult {
  return {
    id: taskId,
    status,
    mutations: [],
    trace: {
      id: `${taskId}-trace`,
      taskId,
      sessionId,
      timestamp: 1_700_000_000_000,
      routingLevel: 0,
      approach: 'baseline',
      oracleVerdicts: {},
      modelUsed: 'fast',
      tokensConsumed: 100,
      durationMs: 50,
      outcome: 'success',
      affectedFiles: [],
    } as ExecutionTrace,
  };
}

function freshDb(): Database {
  const db = new Database(':memory:');
  new MigrationRunner().migrate(db, [migration001]);
  return db;
}

function plantSession(sessionStore: SessionStore, id: string, title?: string): void {
  sessionStore.insertSession({
    id,
    source: 'cli',
    created_at: 1000,
    status: 'active',
    working_memory_json: null,
    compaction_json: null,
    updated_at: 2000,
    title: title ?? null,
    description: null,
    archived_at: null,
    deleted_at: null,
  });
  sessionStore.insertTask({
    session_id: id,
    task_id: `${id}-task-1`,
    task_input_json: JSON.stringify({ id: `${id}-task-1`, goal: 'do thing' }),
    status: 'completed',
    result_json: null,
    created_at: 1100,
    updated_at: 1200,
    archived_at: null,
  });
}

interface FakeTimer {
  fn: () => void;
  ms: number;
  cancelled: boolean;
}

function makeFakeScheduler() {
  const pending: FakeTimer[] = [];
  return {
    pending,
    schedule: (fn: () => void, ms: number) => {
      const t: FakeTimer = { fn, ms, cancelled: false };
      pending.push(t);
      return {
        cancel: () => {
          t.cancelled = true;
        },
      };
    },
    fireLast: () => {
      // Run the most recent uncancelled timer (mimics the debounce: only
      // the most-recent timer for a given session is the live one).
      for (let i = pending.length - 1; i >= 0; i--) {
        const t = pending[i]!;
        if (!t.cancelled) {
          t.cancelled = true;
          t.fn();
          return true;
        }
      }
      return false;
    },
  };
}

function countTraceSourcesForSession(db: Database, sessionId: string): number {
  // The bridge ingests session sources; sessionId is threaded through
  // memory_wiki_sources.session_id.
  const row = db
    .query("SELECT COUNT(*) AS c FROM memory_wiki_sources WHERE kind = 'session' AND session_id = ?")
    .get(sessionId) as { c: number } | null;
  return row?.c ?? 0;
}

describe('attachSessionIngestionBridge — task:complete trigger', () => {
  test('task:complete with sessionId on result schedules a debounced re-ingest', () => {
    const db = freshDb();
    const sessionStore = new SessionStore(db);
    plantSession(sessionStore, 'sess-A', 'Session A');
    const clock = () => 1_700_000_000_000;
    const store = new MemoryWikiStore(db, { clock });
    const writer = new PageWriter({ store, clock });
    const ingestor = new MemoryWikiIngestor({ store, writer, clock });
    const bus = createBus();
    const sched = makeFakeScheduler();

    const bridge = attachSessionIngestionBridge({
      bus,
      sessionStore,
      ingestor,
      defaultProfile: 'default',
      dispatcher: (fn) => fn(),
      scheduleDebounce: sched.schedule,
    });

    bus.emit('task:complete', { result: makeResult('sess-A-task-1', 'sess-A') });

    // No source yet — debouncer pending.
    expect(countTraceSourcesForSession(db, 'sess-A')).toBe(0);
    expect(sched.pending.filter((t) => !t.cancelled).length).toBe(1);

    sched.fireLast();
    expect(countTraceSourcesForSession(db, 'sess-A')).toBe(1);

    bridge.off();
  });

  test('multiple task:complete within the window collapse to one ingest', () => {
    const db = freshDb();
    const sessionStore = new SessionStore(db);
    plantSession(sessionStore, 'sess-B');
    const clock = () => 1_700_000_000_000;
    const store = new MemoryWikiStore(db, { clock });
    const writer = new PageWriter({ store, clock });
    const ingestor = new MemoryWikiIngestor({ store, writer, clock });
    const bus = createBus();
    const sched = makeFakeScheduler();

    const bridge = attachSessionIngestionBridge({
      bus,
      sessionStore,
      ingestor,
      defaultProfile: 'default',
      dispatcher: (fn) => fn(),
      scheduleDebounce: sched.schedule,
    });

    // Three rapid task:complete events for the same session.
    for (let i = 0; i < 3; i++) {
      bus.emit('task:complete', { result: makeResult(`sess-B-task-${i}`, 'sess-B') });
    }

    // The first two debouncers are cancelled; only the most recent fires.
    const live = sched.pending.filter((t) => !t.cancelled);
    expect(live.length).toBe(1);
    sched.fireLast();
    expect(countTraceSourcesForSession(db, 'sess-B')).toBe(1);
    bridge.off();
  });

  test('task:complete without a sessionId is ignored', () => {
    const db = freshDb();
    const sessionStore = new SessionStore(db);
    const clock = () => 1_700_000_000_000;
    const store = new MemoryWikiStore(db, { clock });
    const writer = new PageWriter({ store, clock });
    const ingestor = new MemoryWikiIngestor({ store, writer, clock });
    const bus = createBus();
    const sched = makeFakeScheduler();

    const bridge = attachSessionIngestionBridge({
      bus,
      sessionStore,
      ingestor,
      defaultProfile: 'default',
      dispatcher: (fn) => fn(),
      scheduleDebounce: sched.schedule,
    });

    // No sessionId anywhere — bridge must skip silently.
    const orphan = makeResult('t-detached', '');
    // Strip trace.sessionId so the extractor returns undefined.
    (orphan.trace as { sessionId?: string }).sessionId = undefined;
    bus.emit('task:complete', { result: orphan });
    expect(sched.pending.length).toBe(0);
    bridge.off();
  });

  test('off() cancels pending debounce timers', () => {
    const db = freshDb();
    const sessionStore = new SessionStore(db);
    plantSession(sessionStore, 'sess-C');
    const clock = () => 1_700_000_000_000;
    const store = new MemoryWikiStore(db, { clock });
    const writer = new PageWriter({ store, clock });
    const ingestor = new MemoryWikiIngestor({ store, writer, clock });
    const bus = createBus();
    const sched = makeFakeScheduler();

    const bridge = attachSessionIngestionBridge({
      bus,
      sessionStore,
      ingestor,
      defaultProfile: 'default',
      dispatcher: (fn) => fn(),
      scheduleDebounce: sched.schedule,
    });

    bus.emit('task:complete', { result: makeResult('sess-C-task-1', 'sess-C') });
    expect(sched.pending.filter((t) => !t.cancelled).length).toBe(1);

    bridge.off();
    expect(sched.pending.every((t) => t.cancelled)).toBe(true);
  });

  test('debounceMs=0 ingests synchronously on every task:complete', () => {
    const db = freshDb();
    const sessionStore = new SessionStore(db);
    plantSession(sessionStore, 'sess-D');
    const clock = () => 1_700_000_000_000;
    const store = new MemoryWikiStore(db, { clock });
    const writer = new PageWriter({ store, clock });
    const ingestor = new MemoryWikiIngestor({ store, writer, clock });
    const bus = createBus();

    const bridge = attachSessionIngestionBridge({
      bus,
      sessionStore,
      ingestor,
      defaultProfile: 'default',
      dispatcher: (fn) => fn(),
      taskCompleteDebounceMs: 0,
    });

    bus.emit('task:complete', { result: makeResult('sess-D-task-1', 'sess-D') });
    // Immediate ingest with no debounce — content-addressed source row
    // exists right after the emit.
    expect(countTraceSourcesForSession(db, 'sess-D')).toBe(1);
    bridge.off();
  });

  test('archive trigger still ingests immediately (microtask path unchanged)', async () => {
    const db = freshDb();
    const sessionStore = new SessionStore(db);
    plantSession(sessionStore, 'sess-E');
    const clock = () => 1_700_000_000_000;
    const store = new MemoryWikiStore(db, { clock });
    const writer = new PageWriter({ store, clock });
    const ingestor = new MemoryWikiIngestor({ store, writer, clock });
    const bus = createBus();
    const observed: SessionIngestionTrigger[] = [];

    const bridge = attachSessionIngestionBridge({
      bus,
      sessionStore,
      ingestor,
      defaultProfile: 'default',
      dispatcher: (fn) => fn(),
      onError: (trigger, _id) => observed.push(trigger),
    });

    bus.emit('session:archived', { sessionId: 'sess-E' });
    expect(countTraceSourcesForSession(db, 'sess-E')).toBe(1);
    bridge.off();
  });
});
