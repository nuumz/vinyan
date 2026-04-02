import { describe, expect, test } from 'bun:test';
import { parseCommand, parseKeypress, routeKeypress } from '../../src/tui/input.ts';
import { createInitialState, enterCommandMode, openModal, pushNotification } from '../../src/tui/state.ts';

describe('parseCommand', () => {
  test('parses simple command', () => {
    const cmd = parseCommand('run');
    expect(cmd.name).toBe('run');
    expect(cmd.args).toEqual([]);
    expect(cmd.rawArg).toBe('');
  });

  test('parses command with quoted argument', () => {
    const cmd = parseCommand('run "fix the bug"');
    expect(cmd.name).toBe('run');
    expect(cmd.args).toEqual(['fix the bug']);
    expect(cmd.rawArg).toBe('"fix the bug"');
  });

  test('parses command with multiple args', () => {
    const cmd = parseCommand('approve task-123');
    expect(cmd.name).toBe('approve');
    expect(cmd.args).toEqual(['task-123']);
  });

  test('handles empty input', () => {
    const cmd = parseCommand('');
    expect(cmd.name).toBe('');
    expect(cmd.args).toEqual([]);
  });

  test('handles single-quoted strings', () => {
    const cmd = parseCommand("filter 'task:start'");
    expect(cmd.name).toBe('filter');
    expect(cmd.args).toEqual(['task:start']);
  });
});

describe('parseKeypress', () => {
  test('recognizes arrow keys', () => {
    expect(parseKeypress(Buffer.from('\x1b[A')).name).toBe('up');
    expect(parseKeypress(Buffer.from('\x1b[B')).name).toBe('down');
    expect(parseKeypress(Buffer.from('\x1b[C')).name).toBe('right');
    expect(parseKeypress(Buffer.from('\x1b[D')).name).toBe('left');
  });

  test('recognizes escape', () => {
    expect(parseKeypress(Buffer.from('\x1b')).name).toBe('escape');
  });

  test('recognizes return', () => {
    expect(parseKeypress(Buffer.from('\r')).name).toBe('return');
    expect(parseKeypress(Buffer.from('\n')).name).toBe('return');
  });

  test('recognizes tab', () => {
    expect(parseKeypress(Buffer.from('\t')).name).toBe('tab');
    expect(parseKeypress(Buffer.from('\t')).shift).toBe(false);
  });

  test('recognizes shift+tab', () => {
    const key = parseKeypress(Buffer.from('\x1b[Z'));
    expect(key.name).toBe('tab');
    expect(key.shift).toBe(true);
  });

  test('recognizes ctrl+c', () => {
    const key = parseKeypress(Buffer.from([3]));
    expect(key.name).toBe('c');
    expect(key.ctrl).toBe(true);
  });

  test('recognizes regular character', () => {
    const key = parseKeypress(Buffer.from('a'));
    expect(key.name).toBe('a');
    expect(key.ctrl).toBe(false);
  });
});

describe('routeKeypress', () => {
  test('ctrl+c always quits', () => {
    const state = createInitialState();
    const action = routeKeypress(state, { name: 'c', sequence: '', ctrl: true, shift: false });
    expect(action.type).toBe('quit');
  });

  test('1/2/3/4 switches tabs in normal mode', () => {
    const state = createInitialState();
    expect(routeKeypress(state, { name: '1', sequence: '1', ctrl: false, shift: false })).toEqual({
      type: 'switch-tab',
      tab: 'tasks',
    });
    expect(routeKeypress(state, { name: '2', sequence: '2', ctrl: false, shift: false })).toEqual({
      type: 'switch-tab',
      tab: 'system',
    });
    expect(routeKeypress(state, { name: '3', sequence: '3', ctrl: false, shift: false })).toEqual({
      type: 'switch-tab',
      tab: 'peers',
    });
    expect(routeKeypress(state, { name: '4', sequence: '4', ctrl: false, shift: false })).toEqual({
      type: 'switch-tab',
      tab: 'events',
    });
  });

  test(': enters command mode', () => {
    const state = createInitialState();
    routeKeypress(state, { name: ':', sequence: ':', ctrl: false, shift: false });
    expect(state.inputMode).toBe('command');
  });

  test('/ enters filter mode', () => {
    const state = createInitialState();
    routeKeypress(state, { name: '/', sequence: '/', ctrl: false, shift: false });
    expect(state.inputMode).toBe('filter');
  });

  test('? toggles help', () => {
    const state = createInitialState();
    const action = routeKeypress(state, { name: '?', sequence: '?', ctrl: false, shift: false });
    expect(action.type).toBe('toggle-help');
  });

  test('escape closes modal', () => {
    const state = createInitialState();
    openModal(state, { type: 'help' });
    const action = routeKeypress(state, { name: 'escape', sequence: '\x1b', ctrl: false, shift: false });
    expect(action.type).toBe('back');
  });

  test('a in approval modal approves', () => {
    const state = createInitialState();
    openModal(state, { type: 'approval', taskId: 'task-1', riskScore: 0.8, reason: 'test' });
    const action = routeKeypress(state, { name: 'a', sequence: 'a', ctrl: false, shift: false });
    expect(action).toEqual({ type: 'approve', taskId: 'task-1' });
  });

  test('r in approval modal rejects', () => {
    const state = createInitialState();
    openModal(state, { type: 'approval', taskId: 'task-1', riskScore: 0.8, reason: 'test' });
    const action = routeKeypress(state, { name: 'r', sequence: 'r', ctrl: false, shift: false });
    expect(action).toEqual({ type: 'reject', taskId: 'task-1' });
  });

  test('j/k navigates in normal mode', () => {
    const state = createInitialState();
    expect(routeKeypress(state, { name: 'j', sequence: 'j', ctrl: false, shift: false })).toEqual({
      type: 'navigate',
      direction: 'down',
    });
    expect(routeKeypress(state, { name: 'k', sequence: 'k', ctrl: false, shift: false })).toEqual({
      type: 'navigate',
      direction: 'up',
    });
  });

  test('Ctrl+d/u for page scroll', () => {
    const state = createInitialState();
    expect(routeKeypress(state, { name: 'd', sequence: '\x04', ctrl: true, shift: false })).toEqual({
      type: 'page-scroll',
      direction: 'down',
    });
    expect(routeKeypress(state, { name: 'u', sequence: '\x15', ctrl: true, shift: false })).toEqual({
      type: 'page-scroll',
      direction: 'up',
    });
  });

  test('g/G for jump top/bottom', () => {
    const state = createInitialState();
    expect(routeKeypress(state, { name: 'g', sequence: 'g', ctrl: false, shift: false })).toEqual({
      type: 'jump',
      target: 'top',
    });
    expect(routeKeypress(state, { name: 'g', sequence: 'G', ctrl: false, shift: true })).toEqual({
      type: 'jump',
      target: 'bottom',
    });
  });

  test('Space focuses notification when present', () => {
    const state = createInitialState();
    pushNotification(state, { type: 'approval', taskId: 'task-1', message: 'test', priority: 1, timestamp: Date.now(), dismissed: false });
    const action = routeKeypress(state, { name: 'space', sequence: ' ', ctrl: false, shift: false });
    expect(action.type).toBe('focus-notification');
  });

  test('Space selects when no notification', () => {
    const state = createInitialState();
    const action = routeKeypress(state, { name: 'space', sequence: ' ', ctrl: false, shift: false });
    expect(action.type).toBe('select');
  });

  test('[ and ] cycle notifications', () => {
    const state = createInitialState();
    expect(routeKeypress(state, { name: '[', sequence: '[', ctrl: false, shift: false })).toEqual({
      type: 'cycle-notification',
      direction: -1,
    });
    expect(routeKeypress(state, { name: ']', sequence: ']', ctrl: false, shift: false })).toEqual({
      type: 'cycle-notification',
      direction: 1,
    });
  });

  test('n on tasks tab creates new task', () => {
    const state = createInitialState();
    state.activeTab = 'tasks';
    expect(routeKeypress(state, { name: 'n', sequence: 'n', ctrl: false, shift: false }).type).toBe('new-task');
  });

  test('s on tasks tab triggers sort cycle', () => {
    const state = createInitialState();
    state.activeTab = 'tasks';
    expect(routeKeypress(state, { name: 's', sequence: 's', ctrl: false, shift: false }).type).toBe('sort-cycle');
  });

  test('a approves notification target when present', () => {
    const state = createInitialState();
    pushNotification(state, { type: 'approval', taskId: 'task-99', message: 'test', priority: 1, timestamp: Date.now(), dismissed: false });
    const action = routeKeypress(state, { name: 'a', sequence: 'a', ctrl: false, shift: false });
    expect(action).toEqual({ type: 'approve', taskId: 'task-99' });
  });

  test('r rejects notification target when present, else refreshes', () => {
    const state = createInitialState();
    // No notification → refresh
    expect(routeKeypress(state, { name: 'r', sequence: 'r', ctrl: false, shift: false }).type).toBe('refresh');
    // With notification → reject
    pushNotification(state, { type: 'approval', taskId: 'task-99', message: 'test', priority: 1, timestamp: Date.now(), dismissed: false });
    expect(routeKeypress(state, { name: 'r', sequence: 'r', ctrl: false, shift: false })).toEqual({
      type: 'reject',
      taskId: 'task-99',
    });
  });

  test('c cancels running task (with confirmation modal)', () => {
    const state = createInitialState();
    state.tasks.set('t1', { id: 't1', goal: '', source: 'cli', routingLevel: 0, status: 'running', startedAt: 0, pipeline: { perceive: 'done', predict: 'done', plan: 'done', generate: 'running', verify: 'pending', learn: 'pending' }, oracleVerdicts: [] });
    state.selectedTaskId = 't1';
    const action = routeKeypress(state, { name: 'c', sequence: 'c', ctrl: false, shift: false });
    // Now opens a confirm-cancel modal instead of directly cancelling
    expect(action).toEqual({ type: 'noop' });
    expect(state.modal).toEqual({ type: 'confirm-cancel', taskId: 't1' });
  });
});
