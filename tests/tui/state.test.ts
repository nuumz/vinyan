import { describe, expect, test } from 'bun:test';
import {
  appendToBuffer,
  backspaceBuffer,
  closeModal,
  createInitialState,
  cycleFocus,
  enterCommandMode,
  enterFilterMode,
  exitInputMode,
  openModal,
  pushEvent,
  scrollList,
  selectPeer,
  selectTask,
  switchTab,
  updateTermSize,
} from '../../src/tui/state.ts';
import type { EventLogEntry } from '../../src/tui/types.ts';

describe('createInitialState', () => {
  test('returns default state', () => {
    const state = createInitialState();
    expect(state.activeTab).toBe('dashboard');
    expect(state.focusedPanel).toBe(0);
    expect(state.inputMode).toBe('normal');
    expect(state.commandBuffer).toBe('');
    expect(state.filterQuery).toBe('');
    expect(state.modal).toBeNull();
    expect(state.eventLog).toEqual([]);
    expect(state.tasks.size).toBe(0);
    expect(state.peers.size).toBe(0);
    expect(state.dirty).toBe(true);
  });
});

describe('pushEvent', () => {
  test('adds event with incrementing ID', () => {
    const state = createInitialState();
    const entry: Omit<EventLogEntry, 'id'> = {
      timestamp: Date.now(),
      domain: 'task',
      event: 'task:start',
      summary: 'L2 test task',
      icon: '>',
      colorCode: '\x1b[34m',
      payload: {},
    };
    pushEvent(state, entry);
    expect(state.eventLog).toHaveLength(1);
    expect(state.eventLog[0]!.id).toBe(1);
    expect(state.dirty).toBe(true);

    pushEvent(state, entry);
    expect(state.eventLog).toHaveLength(2);
    expect(state.eventLog[1]!.id).toBe(2);
  });

  test('caps at eventLogMaxSize', () => {
    const state = createInitialState();
    state.eventLogMaxSize = 5;
    const entry: Omit<EventLogEntry, 'id'> = {
      timestamp: Date.now(),
      domain: 'task',
      event: 'test',
      summary: '',
      icon: '.',
      colorCode: '',
      payload: {},
    };
    for (let i = 0; i < 10; i++) pushEvent(state, entry);
    expect(state.eventLog).toHaveLength(5);
    // First ID should be 6 (earliest 5 were evicted)
    expect(state.eventLog[0]!.id).toBe(6);
  });
});

describe('switchTab', () => {
  test('changes tab and resets focus', () => {
    const state = createInitialState();
    state.focusedPanel = 3;
    switchTab(state, 'tasks');
    expect(state.activeTab).toBe('tasks');
    expect(state.focusedPanel).toBe(0);
    expect(state.dirty).toBe(true);
  });
});

describe('cycleFocus', () => {
  test('cycles forward with wrapping', () => {
    const state = createInitialState();
    cycleFocus(state, 4, 1);
    expect(state.focusedPanel).toBe(1);
    cycleFocus(state, 4, 1);
    expect(state.focusedPanel).toBe(2);
    cycleFocus(state, 4, 1);
    expect(state.focusedPanel).toBe(3);
    cycleFocus(state, 4, 1);
    expect(state.focusedPanel).toBe(0); // wraps
  });

  test('cycles backward with wrapping', () => {
    const state = createInitialState();
    cycleFocus(state, 4, -1);
    expect(state.focusedPanel).toBe(3); // wraps backward
  });
});

describe('input mode', () => {
  test('enterCommandMode sets mode and clears buffer', () => {
    const state = createInitialState();
    state.commandBuffer = 'leftover';
    enterCommandMode(state);
    expect(state.inputMode).toBe('command');
    expect(state.commandBuffer).toBe('');
  });

  test('enterFilterMode sets mode', () => {
    const state = createInitialState();
    enterFilterMode(state);
    expect(state.inputMode).toBe('filter');
  });

  test('exitInputMode returns to normal', () => {
    const state = createInitialState();
    enterCommandMode(state);
    exitInputMode(state);
    expect(state.inputMode).toBe('normal');
    expect(state.commandBuffer).toBe('');
  });

  test('appendToBuffer and backspaceBuffer', () => {
    const state = createInitialState();
    appendToBuffer(state, 'a');
    appendToBuffer(state, 'b');
    expect(state.commandBuffer).toBe('ab');
    backspaceBuffer(state);
    expect(state.commandBuffer).toBe('a');
    backspaceBuffer(state);
    expect(state.commandBuffer).toBe('');
    backspaceBuffer(state); // no crash on empty
    expect(state.commandBuffer).toBe('');
  });
});

describe('selection', () => {
  test('selectTask and selectPeer', () => {
    const state = createInitialState();
    selectTask(state, 'task-1');
    expect(state.selectedTaskId).toBe('task-1');
    selectTask(state, null);
    expect(state.selectedTaskId).toBeNull();

    selectPeer(state, 'peer-1');
    expect(state.selectedPeerId).toBe('peer-1');
  });
});

describe('scrollList', () => {
  test('scrolls with minimum of 0', () => {
    const state = createInitialState();
    scrollList(state, 'eventLog', 5);
    expect(state.eventLogScroll).toBe(5);
    scrollList(state, 'eventLog', -10);
    expect(state.eventLogScroll).toBe(0); // clamped to 0
  });
});

describe('modal', () => {
  test('openModal and closeModal', () => {
    const state = createInitialState();
    openModal(state, { type: 'help' });
    expect(state.modal).toEqual({ type: 'help' });
    closeModal(state);
    expect(state.modal).toBeNull();
  });
});
