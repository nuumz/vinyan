import { describe, expect, test } from 'bun:test';
import { getContextHints } from '../../src/tui/hints.ts';
import { createInitialState } from '../../src/tui/state.ts';
import type { TaskDisplayState } from '../../src/tui/types.ts';

function makeTask(overrides: Partial<TaskDisplayState> = {}): TaskDisplayState {
  return {
    id: 'test-1',
    goal: 'Test task',
    source: 'cli',
    routingLevel: 0,
    status: 'running',
    startedAt: Date.now(),
    pipeline: { perceive: 'done', predict: 'done', plan: 'done', generate: 'running', verify: 'pending', learn: 'pending' },
    oracleVerdicts: [],
    ...overrides,
  };
}

describe('getContextHints', () => {
  test('command mode returns execute/cancel', () => {
    const state = createInitialState();
    state.inputMode = 'command';
    const hints = getContextHints(state);
    expect(hints).toEqual([
      { key: 'Enter', label: 'execute' },
      { key: 'Esc', label: 'cancel' },
    ]);
  });

  test('filter mode returns apply/cancel', () => {
    const state = createInitialState();
    state.inputMode = 'filter';
    const hints = getContextHints(state);
    expect(hints).toEqual([
      { key: 'Enter', label: 'apply' },
      { key: 'Esc', label: 'cancel' },
    ]);
  });

  test('normal mode on tasks tab includes nav, new, cmd, filter, help', () => {
    const state = createInitialState();
    state.activeTab = 'tasks';
    const hints = getContextHints(state);
    const keys = hints.map((h) => h.key);
    expect(keys).toContain('j/k');
    expect(keys).toContain('n');
    expect(keys).toContain(':');
    expect(keys).toContain('/');
    expect(keys).toContain('?');
    expect(keys).toContain('s');
  });

  test('approval-required task shows approve/reject hints', () => {
    const state = createInitialState();
    state.activeTab = 'tasks';
    const task = makeTask({ id: 'abc12', status: 'approval_required' });
    state.tasks.set('abc12', task);
    state.selectedTaskId = 'abc12';
    const hints = getContextHints(state);
    const keys = hints.map((h) => h.key);
    expect(keys).toContain('a');
    expect(keys).toContain('r');
  });

  test('running task shows cancel hint', () => {
    const state = createInitialState();
    state.activeTab = 'tasks';
    const task = makeTask({ id: 'abc12', status: 'running' });
    state.tasks.set('abc12', task);
    state.selectedTaskId = 'abc12';
    const hints = getContextHints(state);
    const keys = hints.map((h) => h.key);
    expect(keys).toContain('c');
    // Should not show approve/reject
    expect(keys).not.toContain('a');
  });

  test('notification presence adds Space hint', () => {
    const state = createInitialState();
    state.notifications = [
      { id: 1, type: 'approval', taskId: 'abc12', message: 'test', priority: 1, timestamp: Date.now(), dismissed: false },
    ];
    const hints = getContextHints(state);
    const keys = hints.map((h) => h.key);
    expect(keys).toContain('Space');
    // Also shows approval hints from notification
    expect(keys).toContain('a');
  });

  test('multiple notifications adds cycle hint', () => {
    const state = createInitialState();
    state.notifications = [
      { id: 1, type: 'approval', taskId: 'abc12', message: 'test', priority: 1, timestamp: Date.now(), dismissed: false },
      { id: 2, type: 'circuit', message: 'circuit open', priority: 3, timestamp: Date.now(), dismissed: false },
    ];
    const hints = getContextHints(state);
    const keys = hints.map((h) => h.key);
    expect(keys).toContain('[/]');
  });

  test('events tab shows page/jump hints', () => {
    const state = createInitialState();
    state.activeTab = 'events';
    const hints = getContextHints(state);
    const keys = hints.map((h) => h.key);
    expect(keys).toContain('g/G');
    expect(keys).toContain('PgDn/Up');
    expect(keys).not.toContain('n'); // n is tasks-only
    expect(keys).toContain('s'); // s is now on tasks/peers/events
  });

  test('peers tab shows sort hint', () => {
    const state = createInitialState();
    state.activeTab = 'peers';
    const hints = getContextHints(state);
    const keys = hints.map((h) => h.key);
    expect(keys).toContain('s');
  });

  test('system tab has no sort or new hints', () => {
    const state = createInitialState();
    state.activeTab = 'system';
    const hints = getContextHints(state);
    const keys = hints.map((h) => h.key);
    expect(keys).not.toContain('n');
    expect(keys).not.toContain('s');
  });
});
