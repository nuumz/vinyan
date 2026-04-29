/**
 * Recorder coverage for workflow events that previously slipped through
 * because they lacked taskId. With the manifest unifying SSE + record,
 * and step events now carrying taskId, these must all persist so the
 * UI can replay process state from history.
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
  handle = attachTaskEventRecorder(bus, store, { flushIntervalMs: 10_000 });
});

afterEach(() => {
  handle.detach();
  db.close();
});

describe('TaskEventRecorder — workflow event coverage', () => {
  test('persists workflow:step_complete (now carries taskId)', () => {
    bus.emit('workflow:step_complete', {
      taskId: 't-1',
      sessionId: 's-1',
      stepId: 'step-a',
      status: 'completed',
      strategy: 'direct-tool',
      durationMs: 10,
      tokensConsumed: 0,
    });
    handle.flush();

    const events = store.listForTask('t-1');
    expect(events.map((e) => e.eventType)).toContain('workflow:step_complete');
    const step = events.find((e) => e.eventType === 'workflow:step_complete');
    expect(step?.sessionId).toBe('s-1');
    expect((step?.payload as { stepId: string }).stepId).toBe('step-a');
  });

  test('persists workflow:human_input_needed and workflow:human_input_provided', () => {
    bus.emit('workflow:human_input_needed', {
      taskId: 't-2',
      sessionId: 's-2',
      stepId: 'h1',
      question: 'pick a file',
    });
    bus.emit('workflow:human_input_provided', {
      taskId: 't-2',
      sessionId: 's-2',
      stepId: 'h1',
      value: 'src/foo.ts',
    });
    handle.flush();

    const events = store.listForTask('t-2').map((e) => e.eventType);
    expect(events).toContain('workflow:human_input_needed');
    expect(events).toContain('workflow:human_input_provided');
  });

  test('persists delegate dispatched/completed/timeout for sub-agent rows', () => {
    bus.emit('workflow:delegate_dispatched', {
      taskId: 't-3',
      stepId: 'd1',
      agentId: 'planner',
      subTaskId: 'sub-1',
      stepDescription: 'plan the refactor',
    });
    bus.emit('workflow:delegate_completed', {
      taskId: 't-3',
      stepId: 'd1',
      subTaskId: 'sub-1',
      agentId: 'planner',
      status: 'skipped',
      outputPreview: '',
      tokensUsed: 0,
    });
    handle.flush();

    const events = store.listForTask('t-3');
    expect(events.map((e) => e.eventType)).toEqual(['workflow:delegate_dispatched', 'workflow:delegate_completed']);
    const completed = events[1]?.payload as { status: string };
    // Acceptance criteria: a `skipped` delegate must replay as skipped,
    // never permanent pending.
    expect(completed.status).toBe('skipped');
  });

  test('historical replay reconstructs the same step ordering as live SSE', () => {
    // Emit a realistic mini-workflow.
    bus.emit('workflow:step_start', {
      taskId: 't-4',
      sessionId: 's-4',
      stepId: 'a',
      strategy: 'direct-tool',
      description: 'read file',
    });
    bus.emit('workflow:step_complete', {
      taskId: 't-4',
      sessionId: 's-4',
      stepId: 'a',
      status: 'completed',
      strategy: 'direct-tool',
      durationMs: 5,
      tokensConsumed: 0,
    });
    bus.emit('workflow:step_start', {
      taskId: 't-4',
      sessionId: 's-4',
      stepId: 'b',
      strategy: 'delegate-sub-agent',
      description: 'review',
    });
    handle.flush();

    const replay = store.listForTask('t-4').map((e) => e.eventType);
    expect(replay).toEqual(['workflow:step_start', 'workflow:step_complete', 'workflow:step_start']);
  });

  test('non-recorded events are never subscribed to (RECORDED_EVENTS allow-list)', () => {
    // Belt-and-suspenders for the manifest contract: events flagged
    // `record: false` (e.g. evolution:rulePromoted, scope='global') must
    // NOT be persisted to task_events even when their payload carries
    // a stray taskId — they aren't on the recorder's bus.on() list at
    // all, and the recorder's manifest-scope guard would catch them if
    // they were. This test pins the public contract.
    bus.emit('evolution:rulePromoted', {
      taskId: 't-scope',
      ruleId: 'r1',
    } as never);
    handle.flush();

    const events = store.listForTask('t-scope');
    expect(events.length).toBe(0);
  });
});
