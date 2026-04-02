/**
 * Quick diagnostic test — verify DataSource subscription + task/event state updates.
 */
import { describe, expect, test } from 'bun:test';
import { EventBus, type VinyanBusEvents } from '../../src/core/bus.ts';
import { EmbeddedDataSource } from '../../src/tui/data/source.ts';
import { createInitialState } from '../../src/tui/state.ts';
import { renderTasks } from '../../src/tui/views/tasks.ts';

function makeMockOrchestrator(bus: EventBus<VinyanBusEvents>) {
  return {
    bus,
    executeTask: async () => ({ id: 'x', status: 'completed' }),
    approvalGate: null,
    sleepCycleRunner: null,
    patternStore: null,
    close: () => {},
  } as any;
}

describe('EmbeddedDataSource subscriptions', () => {
  test('task:start adds to state.tasks', () => {
    const bus = new EventBus<VinyanBusEvents>();
    const state = createInitialState('/tmp');
    const ds = new EmbeddedDataSource(state, makeMockOrchestrator(bus));
    ds.start();

    expect(state.tasks.size).toBe(0);

    bus.emit('task:start', {
      input: { id: 't1', source: 'cli', goal: 'test goal', budget: {} },
      routing: { level: 0, riskScore: 0.1 },
    } as any);

    expect(state.tasks.size).toBe(1);
    expect(state.tasks.get('t1')?.goal).toBe('test goal');
    expect(state.tasks.get('t1')?.status).toBe('running');
    expect(state.selectedTaskId).toBe('t1');
    expect(state.stateGeneration).toBeGreaterThan(0);

    ds.stop();
  });

  test('task:complete updates task status', () => {
    const bus = new EventBus<VinyanBusEvents>();
    const state = createInitialState('/tmp');
    const ds = new EmbeddedDataSource(state, makeMockOrchestrator(bus));
    ds.start();

    bus.emit('task:start', {
      input: { id: 't1', source: 'cli', goal: 'test', budget: {} },
      routing: {},
    } as any);
    bus.emit('task:complete', {
      result: { id: 't1', status: 'completed', qualityScore: { composite: 0.8 } },
    } as any);

    expect(state.tasks.get('t1')?.status).toBe('completed');
    expect(state.tasks.get('t1')?.qualityScore).toBe(0.8);

    ds.stop();
  });

  test('events are pushed to eventLog', () => {
    const bus = new EventBus<VinyanBusEvents>();
    const state = createInitialState('/tmp');
    const ds = new EmbeddedDataSource(state, makeMockOrchestrator(bus));
    ds.start();

    bus.emit('task:start', {
      input: { id: 't1', source: 'cli', goal: 'test', budget: {} },
      routing: {},
    } as any);

    expect(state.eventLog.length).toBeGreaterThan(0);

    ds.stop();
  });

  test('LOG_ONLY events push to eventLog when defaultVisible', () => {
    const bus = new EventBus<VinyanBusEvents>();
    const state = createInitialState('/tmp');
    const ds = new EmbeddedDataSource(state, makeMockOrchestrator(bus));
    ds.start();

    // worker:complete has defaultVisible: false, use an event that's visible
    bus.emit('oracle:contradiction', { taskId: 't1' } as any);

    expect(state.eventLog.length).toBeGreaterThan(0);

    ds.stop();
  });

  test('renderTasks shows task after bus event', () => {
    const bus = new EventBus<VinyanBusEvents>();
    const state = createInitialState('/tmp');
    state.termWidth = 120;
    state.termHeight = 40;
    const ds = new EmbeddedDataSource(state, makeMockOrchestrator(bus));
    ds.start();

    // First render — no tasks
    const before = renderTasks(state);
    expect(before).toContain('Tasks (0)');

    // Add a task
    bus.emit('task:start', {
      input: { id: 't1', source: 'cli', goal: 'test goal', budget: {} },
      routing: { level: 0, riskScore: 0.1 },
    } as any);

    // Second render — should show task
    const after = renderTasks(state);
    expect(after).toContain('Tasks (1)');

    ds.stop();
  });
});
