/**
 * Tests for Crash Recovery — TaskCheckpointStore.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { TaskCheckpointStore } from '../../src/db/task-checkpoint-store.ts';

function makeStore(): TaskCheckpointStore {
  return new TaskCheckpointStore(new Database(':memory:'));
}

describe('TaskCheckpointStore', () => {
  test('save + findDispatched returns saved checkpoint', () => {
    const store = makeStore();
    store.save({
      taskId: 'task-1',
      inputJson: '{"id":"task-1","goal":"test"}',
      routingLevel: 2,
      planJson: null,
      perceptionJson: null,
      attemptCount: 1,
    });

    const dispatched = store.findDispatched();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.taskId).toBe('task-1');
    expect(dispatched[0]!.routingLevel).toBe(2);
    expect(dispatched[0]!.status).toBe('dispatched');
    expect(dispatched[0]!.attemptCount).toBe(1);
  });

  test('complete marks as completed, no longer in findDispatched', () => {
    const store = makeStore();
    store.save({
      taskId: 'task-1',
      inputJson: '{}',
      routingLevel: 1,
      planJson: null,
      perceptionJson: null,
      attemptCount: 1,
    });

    store.complete('task-1');
    const dispatched = store.findDispatched();
    expect(dispatched).toHaveLength(0);
  });

  test('fail marks as failed with reason', () => {
    const store = makeStore();
    store.save({
      taskId: 'task-1',
      inputJson: '{}',
      routingLevel: 1,
      planJson: null,
      perceptionJson: null,
      attemptCount: 1,
    });

    store.fail('task-1', 'oracle gate failed');
    const dispatched = store.findDispatched();
    expect(dispatched).toHaveLength(0);
  });

  test('abandon marks as abandoned', () => {
    const store = makeStore();
    store.save({
      taskId: 'task-1',
      inputJson: '{}',
      routingLevel: 1,
      planJson: null,
      perceptionJson: null,
      attemptCount: 1,
    });

    store.abandon('task-1');
    const dispatched = store.findDispatched();
    expect(dispatched).toHaveLength(0);
  });

  test('findDispatched only returns dispatched status', () => {
    const store = makeStore();

    store.save({ taskId: 't1', inputJson: '{}', routingLevel: 1, planJson: null, perceptionJson: null, attemptCount: 1 });
    store.save({ taskId: 't2', inputJson: '{}', routingLevel: 1, planJson: null, perceptionJson: null, attemptCount: 1 });
    store.save({ taskId: 't3', inputJson: '{}', routingLevel: 1, planJson: null, perceptionJson: null, attemptCount: 1 });

    store.complete('t1');
    store.fail('t2', 'error');

    const dispatched = store.findDispatched();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.taskId).toBe('t3');
  });

  test('cleanup removes old completed/failed/abandoned entries', () => {
    const db = new Database(':memory:');
    const store = new TaskCheckpointStore(db);

    store.save({ taskId: 't1', inputJson: '{}', routingLevel: 1, planJson: null, perceptionJson: null, attemptCount: 1 });
    store.complete('t1');

    // Manually backdate the updated_at to simulate old entry
    db.exec(`UPDATE task_checkpoints SET updated_at = datetime('now', '-2 days') WHERE task_id = 't1'`);

    const cleaned = store.cleanup(24 * 60 * 60 * 1000); // 24h
    expect(cleaned).toBe(1);
  });

  test('cleanup does not remove recent entries', () => {
    const store = makeStore();
    store.save({ taskId: 't1', inputJson: '{}', routingLevel: 1, planJson: null, perceptionJson: null, attemptCount: 1 });
    store.complete('t1');

    const cleaned = store.cleanup(24 * 60 * 60 * 1000);
    expect(cleaned).toBe(0); // just completed, not old enough
  });

  test('save with same taskId overwrites (INSERT OR REPLACE)', () => {
    const store = makeStore();

    store.save({ taskId: 't1', inputJson: '{"v":1}', routingLevel: 1, planJson: null, perceptionJson: null, attemptCount: 1 });
    store.save({ taskId: 't1', inputJson: '{"v":2}', routingLevel: 2, planJson: null, perceptionJson: null, attemptCount: 2 });

    const dispatched = store.findDispatched();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.routingLevel).toBe(2);
    expect(dispatched[0]!.attemptCount).toBe(2);
    expect(dispatched[0]!.inputJson).toBe('{"v":2}');
  });

  test('planJson and perceptionJson are preserved', () => {
    const store = makeStore();
    store.save({
      taskId: 't1',
      inputJson: '{}',
      routingLevel: 2,
      planJson: '{"nodeCount":3}',
      perceptionJson: '{"targetFiles":["a.ts"]}',
      attemptCount: 1,
    });

    const dispatched = store.findDispatched();
    expect(dispatched[0]!.planJson).toBe('{"nodeCount":3}');
    expect(dispatched[0]!.perceptionJson).toBe('{"targetFiles":["a.ts"]}');
  });

  test('factory startup pattern: find interrupted → abandon', () => {
    const store = makeStore();

    // Simulate 3 tasks dispatched before crash
    store.save({ taskId: 't1', inputJson: '{"id":"t1"}', routingLevel: 1, planJson: null, perceptionJson: null, attemptCount: 1 });
    store.save({ taskId: 't2', inputJson: '{"id":"t2"}', routingLevel: 2, planJson: null, perceptionJson: null, attemptCount: 1 });
    store.save({ taskId: 't3', inputJson: '{"id":"t3"}', routingLevel: 1, planJson: null, perceptionJson: null, attemptCount: 1 });

    // t1 completed before crash
    store.complete('t1');

    // Simulate restart: find dispatched and abandon
    const interrupted = store.findDispatched();
    expect(interrupted).toHaveLength(2);

    for (const task of interrupted) {
      store.abandon(task.taskId);
    }

    // No more dispatched tasks
    expect(store.findDispatched()).toHaveLength(0);
  });
});
