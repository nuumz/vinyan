/**
 * TaskEventRecorder — verifies bus → store batching, allow-list filtering,
 * FIFO overflow handling, and string truncation.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createBus, type VinyanBus } from '../../../src/core/bus.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../../src/db/migrations/index.ts';
import { TaskEventStore } from '../../../src/db/task-event-store.ts';
import {
  attachTaskEventRecorder,
  type TaskEventRecorderHandle,
} from '../../../src/orchestrator/observability/task-event-recorder.ts';

let db: Database;
let store: TaskEventStore;
let bus: VinyanBus;
let handle: TaskEventRecorderHandle;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  store = new TaskEventStore(db);
  bus = createBus();
});

afterEach(() => {
  handle?.detach();
  db.close();
});

describe('TaskEventRecorder', () => {
  test('persists allow-listed events keyed by taskId', () => {
    handle = attachTaskEventRecorder(bus, store, { flushIntervalMs: 10_000 });

    bus.emit('phase:timing', { taskId: 't-1', phase: 'plan', durationMs: 12, routingLevel: 2 });
    bus.emit('agent:thinking', { taskId: 't-1', turnId: 'turn-1', rationale: 'hello' });

    handle.flush();
    const events = store.listForTask('t-1');
    expect(events.map((e) => e.eventType)).toEqual(['phase:timing', 'agent:thinking']);
    expect((events[0]?.payload as { phase: string }).phase).toBe('plan');
  });

  test('skips events without a taskId', () => {
    handle = attachTaskEventRecorder(bus, store, { flushIntervalMs: 10_000 });
    // session-scoped event with no taskId — recorder should drop.
    bus.emit('phase:timing', { phase: 'plan', durationMs: 5 } as never);
    handle.flush();
    // No task to query, so just assert nothing was written for any task.
    const row = db.prepare('SELECT COUNT(*) AS n FROM task_events').get() as { n: number };
    expect(row.n).toBe(0);
  });

  test('skips events not on the allow-list', () => {
    handle = attachTaskEventRecorder(bus, store, { flushIntervalMs: 10_000 });
    // `degradation:triggered` is in the manifest with record:false.
    bus.emit('degradation:triggered', { taskId: 't-x', reason: 'test' } as never);
    handle.flush();
    const row = db.prepare('SELECT COUNT(*) AS n FROM task_events').get() as { n: number };
    expect(row.n).toBe(0);
  });

  test('truncates oversized string payload fields', () => {
    handle = attachTaskEventRecorder(bus, store, { flushIntervalMs: 10_000, maxStringChars: 16 });
    const huge = 'x'.repeat(64);
    bus.emit('agent:thinking', { taskId: 't-2', turnId: 'turn-2', rationale: huge });
    handle.flush();
    const events = store.listForTask('t-2');
    const rationale = (events[0]?.payload as { rationale: string }).rationale;
    expect(rationale.length).toBeLessThan(huge.length);
    expect(rationale).toContain('truncated');
  });

  test('drops oldest buffered event on overflow (FIFO)', () => {
    handle = attachTaskEventRecorder(bus, store, {
      bufferLimit: 2,
      flushIntervalMs: 10_000,
    });
    bus.emit('phase:timing', { taskId: 't-3', phase: 'a', durationMs: 1, routingLevel: 2 });
    bus.emit('phase:timing', { taskId: 't-3', phase: 'b', durationMs: 1, routingLevel: 2 });
    bus.emit('phase:timing', { taskId: 't-3', phase: 'c', durationMs: 1, routingLevel: 2 });
    expect(handle.droppedCount()).toBe(1);
    handle.flush();
    const phases = store.listForTask('t-3').map((e) => (e.payload as { phase: string }).phase);
    // Oldest ('a') was dropped; newest two survived.
    expect(phases).toEqual(['b', 'c']);
  });

  test('backfills sessionId from prior task:start when later events omit it', () => {
    // Reproduces the agentic-workflow loss: workflow-executor emits
    // `agent:plan_update` / `workflow:plan_ready` / `workflow:delegate_dispatched`
    // without a top-level `sessionId`, so without backfill those rows persist
    // as `session_id=NULL` and the task-tree query filters them out on read.
    handle = attachTaskEventRecorder(bus, store, { flushIntervalMs: 10_000 });

    bus.emit('task:start', {
      input: { id: 't-4', sessionId: 'sess-A', goal: 'g', taskType: 'reasoning' },
      routing: { level: 0, model: 'pending', budgetTokens: 0, latencyBudgetMs: 0 },
    } as never);
    // Subsequent event omits sessionId — should still inherit 'sess-A'.
    bus.emit('agent:plan_update', {
      taskId: 't-4',
      steps: [{ id: 'step1', label: 'plan', status: 'pending' }],
    } as never);

    handle.flush();
    const events = store.listForTask('t-4');
    expect(events.length).toBe(2);
    for (const e of events) {
      expect(e.sessionId).toBe('sess-A');
    }
  });

  test('caches sessionId per-task so different tasks do not cross-contaminate', () => {
    handle = attachTaskEventRecorder(bus, store, { flushIntervalMs: 10_000 });

    bus.emit('task:start', {
      input: { id: 't-5', sessionId: 'sess-A', goal: 'g', taskType: 'reasoning' },
      routing: { level: 0, model: 'pending', budgetTokens: 0, latencyBudgetMs: 0 },
    } as never);
    bus.emit('task:start', {
      input: { id: 't-6', sessionId: 'sess-B', goal: 'g', taskType: 'reasoning' },
      routing: { level: 0, model: 'pending', budgetTokens: 0, latencyBudgetMs: 0 },
    } as never);
    // No sessionId — must get t-5's session, not t-6's.
    bus.emit('agent:plan_update', { taskId: 't-5', steps: [] } as never);
    bus.emit('agent:plan_update', { taskId: 't-6', steps: [] } as never);

    handle.flush();
    expect(store.listForTask('t-5').every((e) => e.sessionId === 'sess-A')).toBe(true);
    expect(store.listForTask('t-6').every((e) => e.sessionId === 'sess-B')).toBe(true);
  });

  test('priority eviction: drops streaming deltas before lifecycle events', () => {
    // Buffer = 2. Pre-fill with one stream delta (LOW) + one lifecycle
    // event (HIGH). When a third HIGH-priority event arrives, the LOW
    // delta should be evicted and both HIGH events should survive.
    handle = attachTaskEventRecorder(bus, store, {
      bufferLimit: 2,
      flushIntervalMs: 10_000,
    });
    bus.emit('llm:stream_delta', { taskId: 't-7', kind: 'content', text: 'token1' } as never);
    bus.emit('workflow:step_start', {
      taskId: 't-7',
      stepId: 'step1',
      strategy: 'delegate-sub-agent',
      description: 'do work',
    } as never);
    bus.emit('workflow:step_complete', {
      taskId: 't-7',
      stepId: 'step1',
      status: 'completed',
      strategy: 'delegate-sub-agent',
      durationMs: 10,
      tokensConsumed: 0,
    } as never);

    expect(handle.droppedCount()).toBe(1);
    handle.flush();
    const types = store.listForTask('t-7').map((e) => e.eventType);
    // Stream delta evicted; both workflow events survived.
    expect(types).toEqual(['workflow:step_start', 'workflow:step_complete']);
  });

  test('pre-seeds sub-task session on delegate_dispatched so out-of-order sub-task events still record session_id', () => {
    // Closes the multi-agent `[no activity captured]` regression:
    // workflow-executor dispatches a delegate, then `await executeTask(subInput)`
    // hands control to an inner orchestrator. If the first sub-task event the
    // recorder sees is NOT `task:start` (e.g. an agent-loop tool event lands
    // first because the persona started immediately), the recorder's per-task
    // session cache misses on the sub-task id and the row persists with
    // `session_id=NULL`. The replay endpoint's session-guarded tree query then
    // silently drops it — UI shows DONE rows with no captured tool history.
    handle = attachTaskEventRecorder(bus, store, { flushIntervalMs: 10_000 });

    bus.emit('task:start', {
      input: { id: 't-parent', sessionId: 'sess-X', goal: 'g', taskType: 'reasoning' },
      routing: { level: 0, model: 'pending', budgetTokens: 0, latencyBudgetMs: 0 },
    } as never);
    bus.emit('workflow:delegate_dispatched', {
      taskId: 't-parent',
      stepId: 'step1',
      agentId: 'architect',
      subTaskId: 't-parent-delegate-step1',
    } as never);
    // Sub-task's first event reaches the recorder BEFORE its own
    // task:start (the race we are fixing). No sessionId in payload —
    // recorder must backfill from the pre-seeded sub-task entry.
    bus.emit('agent:tool_started', {
      taskId: 't-parent-delegate-step1',
      turnId: 'sub-turn-1',
      toolCallId: 'tc-1',
      toolName: 'shell_exec',
    } as never);

    handle.flush();

    const subEvents = store.listForTask('t-parent-delegate-step1');
    expect(subEvents.length).toBe(1);
    expect(subEvents[0]?.eventType).toBe('agent:tool_started');
    // The bug surfaced as `session_id=NULL` here. With the pre-seed
    // fix, the sub-task event inherits the parent's session.
    expect(subEvents[0]?.sessionId).toBe('sess-X');
  });

  test('does not pre-seed when delegate_dispatched payload omits subTaskId', () => {
    // Defensive: a malformed dispatch event without subTaskId must not
    // crash or pollute the cache with an empty key. Subsequent sub-task
    // events behave as before (lookup miss → NULL session_id).
    handle = attachTaskEventRecorder(bus, store, { flushIntervalMs: 10_000 });

    bus.emit('task:start', {
      input: { id: 't-parent2', sessionId: 'sess-Y', goal: 'g', taskType: 'reasoning' },
      routing: { level: 0, model: 'pending', budgetTokens: 0, latencyBudgetMs: 0 },
    } as never);
    bus.emit('workflow:delegate_dispatched', {
      taskId: 't-parent2',
      stepId: 'step1',
      agentId: 'architect',
      // subTaskId intentionally omitted
    } as never);

    handle.flush();
    // The dispatch event itself is recorded under the parent — that path
    // is unaffected by the missing subTaskId.
    const parentEvents = store.listForTask('t-parent2');
    expect(parentEvents.map((e) => e.eventType)).toContain('workflow:delegate_dispatched');
    for (const e of parentEvents) {
      expect(e.sessionId).toBe('sess-Y');
    }
  });

  test('pre-seed is idempotent — repeated dispatches do not overwrite an existing sub-task session', () => {
    // Once a sub-task has cached its real session (either via the
    // pre-seed or via its own task:start), a duplicate dispatch event
    // (replay, retry, race) must not clobber the entry with stale data.
    handle = attachTaskEventRecorder(bus, store, { flushIntervalMs: 10_000 });

    bus.emit('task:start', {
      input: { id: 't-parent3', sessionId: 'sess-Z', goal: 'g', taskType: 'reasoning' },
      routing: { level: 0, model: 'pending', budgetTokens: 0, latencyBudgetMs: 0 },
    } as never);
    bus.emit('workflow:delegate_dispatched', {
      taskId: 't-parent3',
      stepId: 'step1',
      agentId: 'architect',
      subTaskId: 't-parent3-delegate-step1',
    } as never);
    // Sub-task's own task:start with explicit (correct) session.
    bus.emit('task:start', {
      input: {
        id: 't-parent3-delegate-step1',
        sessionId: 'sess-Z',
        goal: 'g',
        taskType: 'reasoning',
      },
      routing: { level: 0, model: 'pending', budgetTokens: 0, latencyBudgetMs: 0 },
    } as never);
    bus.emit('agent:tool_started', {
      taskId: 't-parent3-delegate-step1',
      turnId: 'sub-turn-1',
      toolCallId: 'tc-2',
      toolName: 'shell_exec',
    } as never);

    handle.flush();
    const subEvents = store.listForTask('t-parent3-delegate-step1');
    expect(subEvents.length).toBe(2);
    for (const e of subEvents) {
      expect(e.sessionId).toBe('sess-Z');
    }
  });

  test('priority eviction: falls back to FIFO when buffer is all high-priority', () => {
    handle = attachTaskEventRecorder(bus, store, {
      bufferLimit: 2,
      flushIntervalMs: 10_000,
    });
    bus.emit('workflow:step_start', { taskId: 't-8', stepId: 'a', strategy: 'x', description: 'a' } as never);
    bus.emit('workflow:step_start', { taskId: 't-8', stepId: 'b', strategy: 'x', description: 'b' } as never);
    bus.emit('workflow:step_start', { taskId: 't-8', stepId: 'c', strategy: 'x', description: 'c' } as never);

    expect(handle.droppedCount()).toBe(1);
    handle.flush();
    const stepIds = store
      .listForTask('t-8')
      .map((e) => (e.payload as { stepId: string }).stepId);
    // No LOW events to evict — falls back to oldest-first FIFO.
    expect(stepIds).toEqual(['b', 'c']);
  });
});
