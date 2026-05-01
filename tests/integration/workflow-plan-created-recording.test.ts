/**
 * End-to-end integration: `planWorkflow` → bus → TaskEventRecorder → SQLite.
 *
 * Wires the real recorder + store + bus and runs the actual planner with a
 * mock LLM provider. Asserts that `workflow:plan_created` lands in
 * `task_events` with the right `task_id`, `session_id`, and payload shape —
 * not just that the bus emit fires (covered by the unit test) and not just
 * that the recorder accepts the event type (covered by the recorder coverage
 * test). This is the gate that confirms the manifest entry, the payload
 * type, and the planner's emit-site identity threading all line up.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createBus, type VinyanBus } from '../../src/core/bus.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { TaskEventStore } from '../../src/db/task-event-store.ts';
import {
  attachTaskEventRecorder,
  type TaskEventRecorderHandle,
} from '../../src/orchestrator/observability/task-event-recorder.ts';
import { planWorkflow } from '../../src/orchestrator/workflow/workflow-planner.ts';

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

const SUCCESS_PLAN = JSON.stringify({
  goal: 'analyze the data',
  steps: [
    {
      id: 'step1',
      description: 'gather context',
      strategy: 'knowledge-query',
      dependencies: [],
    },
    {
      id: 'step2',
      description: 'reason over context',
      strategy: 'llm-reasoning',
      dependencies: ['step1'],
    },
  ],
  synthesisPrompt: 'Combine results.',
});

describe('integration: workflow:plan_created → task_events', () => {
  test('LLM-success path persists a row with taskId, sessionId, full steps', async () => {
    const llmRegistry = {
      selectByTier: () => ({
        id: 'mock',
        generate: async () => ({ content: SUCCESS_PLAN, tokensUsed: { input: 100, output: 200 } }),
      }),
    };

    await planWorkflow(
      {
        knowledgeDeps: {},
        bus,
        llmRegistry: llmRegistry as any,
      },
      {
        goal: 'analyze the data',
        taskId: 'task-int-1',
        sessionId: 'session-int-1',
      },
    );

    handle.flush();

    const events = store.listForTask('task-int-1');
    const planCreated = events.find((e) => e.eventType === 'workflow:plan_created');
    expect(planCreated).toBeDefined();
    expect(planCreated!.taskId).toBe('task-int-1');
    expect(planCreated!.sessionId).toBe('session-int-1');

    const payload = planCreated!.payload as {
      goal: string;
      origin: string;
      attempts: number;
      steps: Array<{ id: string; description: string; strategy: string; dependencies: string[] }>;
    };
    expect(payload.goal).toBe('analyze the data');
    expect(payload.origin).toBe('llm');
    expect(payload.attempts).toBe(1);
    expect(payload.steps).toHaveLength(2);
    expect(payload.steps[0]!.id).toBe('step1');
    expect(payload.steps[1]!.dependencies).toEqual(['step1']);
  });

  test('fallback path (no provider) persists a row with origin=fallback, attempts=0', async () => {
    await planWorkflow(
      { knowledgeDeps: {}, bus },
      {
        goal: 'no provider available',
        taskId: 'task-int-fallback',
        sessionId: 'session-int-fallback',
      },
    );

    handle.flush();

    const events = store.listForTask('task-int-fallback');
    const planCreated = events.find((e) => e.eventType === 'workflow:plan_created');
    expect(planCreated).toBeDefined();
    const payload = planCreated!.payload as {
      origin: string;
      attempts: number;
      steps: Array<unknown>;
    };
    expect(payload.origin).toBe('fallback');
    expect(payload.attempts).toBe(0);
    expect(payload.steps.length).toBeGreaterThan(0);
  });

  test('fallback path (LLM throws twice) persists a row with origin=fallback, attempts=2', async () => {
    const llmRegistry = {
      selectByTier: () => ({
        id: 'mock',
        generate: async () => ({ content: 'totally not json', tokensUsed: { input: 1, output: 1 } }),
      }),
    };

    await planWorkflow(
      {
        knowledgeDeps: {},
        bus,
        llmRegistry: llmRegistry as any,
      },
      {
        goal: 'will fall back twice',
        taskId: 'task-int-fail',
      },
    );

    handle.flush();

    const events = store.listForTask('task-int-fail');
    const planCreated = events.find((e) => e.eventType === 'workflow:plan_created');
    expect(planCreated).toBeDefined();
    expect(planCreated!.sessionId).toBeUndefined();
    const payload = planCreated!.payload as { origin: string; attempts: number };
    expect(payload.origin).toBe('fallback');
    expect(payload.attempts).toBe(2);
  });
});
