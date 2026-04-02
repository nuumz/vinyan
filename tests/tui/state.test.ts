import { describe, expect, test } from 'bun:test';
import {
  appendToBuffer,
  backspaceBuffer,
  cleanExpiredToasts,
  closeModal,
  createInitialState,
  cycleFocus,
  cycleNotification,
  cycleSortField,
  dismissNotification,
  enterCommandMode,
  enterFilterMode,
  exitInputMode,
  openModal,
  pushEvent,
  pushNotification,
  pushToast,
  scrollList,
  selectEvent,
  selectPeer,
  selectTask,
  setSort,
  switchTab,
  updateTabBadges,
  updateTermSize,
} from '../../src/tui/state.ts';
import type { EventLogEntry } from '../../src/tui/types.ts';

describe('createInitialState', () => {
  test('returns default state with tasks as default tab', () => {
    const state = createInitialState();
    expect(state.activeTab).toBe('tasks');
    expect(state.focusedPanel).toBe(0);
    expect(state.inputMode).toBe('normal');
    expect(state.commandBuffer).toBe('');
    expect(state.filterQuery).toBe('');
    expect(state.modal).toBeNull();
    expect(state.eventLog).toEqual([]);
    expect(state.tasks.size).toBe(0);
    expect(state.peers.size).toBe(0);
    expect(state.dirty).toBe(true);
    // New fields
    expect(state.notifications).toEqual([]);
    expect(state.notificationIdCounter).toBe(0);
    expect(state.notificationIndex).toBe(0);
    expect(state.toasts).toEqual([]);
    expect(state.tabBadges).toEqual({});
    expect(state.selectedEventId).toBeNull();
    expect(state.lastEventTabVisit).toBe(0);
    expect(state.sort).toEqual({});
    expect(state.realtimeCounters).toEqual({});
    expect(state.workspace).toBe('.');
  });

  test('accepts workspace parameter', () => {
    const state = createInitialState('/my/project');
    expect(state.workspace).toBe('/my/project');
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

// ── New Mutation Tests ──────────────────────────────────────────────

describe('switchTab resets event badge', () => {
  test('switching to events tab updates lastEventTabVisit', () => {
    const state = createInitialState();
    state.eventIdCounter = 42;
    switchTab(state, 'events');
    expect(state.activeTab).toBe('events');
    expect(state.lastEventTabVisit).toBe(42);
  });

  test('switching to other tabs does not update lastEventTabVisit', () => {
    const state = createInitialState();
    state.eventIdCounter = 42;
    switchTab(state, 'tasks');
    expect(state.lastEventTabVisit).toBe(0); // unchanged from initial
  });
});

describe('pushNotification', () => {
  test('adds notification with auto-incrementing ID', () => {
    const state = createInitialState();
    pushNotification(state, { type: 'approval', taskId: 'task-1', message: 'test', priority: 1, timestamp: Date.now(), dismissed: false });
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]!.id).toBe(1);
    expect(state.notificationIdCounter).toBe(1);
  });

  test('sorts by priority (highest first)', () => {
    const state = createInitialState();
    pushNotification(state, { type: 'alert', message: 'low', priority: 4, timestamp: Date.now(), dismissed: false });
    pushNotification(state, { type: 'approval', taskId: 't1', message: 'high', priority: 1, timestamp: Date.now(), dismissed: false });
    expect(state.notifications[0]!.type).toBe('approval');
    expect(state.notifications[1]!.type).toBe('alert');
  });
});

describe('dismissNotification', () => {
  test('removes notification by id and clamps index', () => {
    const state = createInitialState();
    pushNotification(state, { type: 'approval', message: 'a', priority: 1, timestamp: Date.now(), dismissed: false });
    pushNotification(state, { type: 'circuit', message: 'b', priority: 3, timestamp: Date.now(), dismissed: false });
    state.notificationIndex = 1;
    dismissNotification(state, state.notifications[1]!.id);
    expect(state.notifications).toHaveLength(1);
    expect(state.notificationIndex).toBe(0); // clamped
  });

  test('handles dismissing last notification', () => {
    const state = createInitialState();
    pushNotification(state, { type: 'approval', message: 'a', priority: 1, timestamp: Date.now(), dismissed: false });
    dismissNotification(state, 1);
    expect(state.notifications).toHaveLength(0);
    expect(state.notificationIndex).toBe(0);
  });
});

describe('cycleNotification', () => {
  test('cycles forward with wrapping', () => {
    const state = createInitialState();
    pushNotification(state, { type: 'approval', message: 'a', priority: 1, timestamp: Date.now(), dismissed: false });
    pushNotification(state, { type: 'circuit', message: 'b', priority: 3, timestamp: Date.now(), dismissed: false });
    expect(state.notificationIndex).toBe(0);
    cycleNotification(state, 1);
    expect(state.notificationIndex).toBe(1);
    cycleNotification(state, 1);
    expect(state.notificationIndex).toBe(0); // wraps
  });

  test('does nothing with no notifications', () => {
    const state = createInitialState();
    cycleNotification(state, 1);
    expect(state.notificationIndex).toBe(0);
  });
});

describe('pushToast and cleanExpiredToasts', () => {
  test('pushToast adds toast with expiry', () => {
    const state = createInitialState();
    pushToast(state, 'Approved', 'success');
    expect(state.toasts).toHaveLength(1);
    expect(state.toasts[0]!.message).toBe('Approved');
    expect(state.toasts[0]!.level).toBe('success');
    expect(state.toasts[0]!.expiresAt).toBeGreaterThan(Date.now());
  });

  test('cleanExpiredToasts removes expired toasts', () => {
    const state = createInitialState();
    state.toasts = [
      { message: 'old', level: 'info', expiresAt: Date.now() - 1000 },
      { message: 'new', level: 'info', expiresAt: Date.now() + 5000 },
    ];
    state.dirty = false;
    cleanExpiredToasts(state);
    expect(state.toasts).toHaveLength(1);
    expect(state.toasts[0]!.message).toBe('new');
    expect(state.dirty).toBe(true);
  });

  test('cleanExpiredToasts does not mark dirty if nothing changed', () => {
    const state = createInitialState();
    state.toasts = [{ message: 'active', level: 'info', expiresAt: Date.now() + 5000 }];
    state.dirty = false;
    cleanExpiredToasts(state);
    expect(state.dirty).toBe(false);
  });
});

describe('updateTabBadges', () => {
  test('computes task badges', () => {
    const state = createInitialState();
    state.tasks.set('t1', { id: 't1', goal: '', source: 'cli', routingLevel: 0, status: 'running', startedAt: 0, pipeline: { perceive: 'done', predict: 'done', plan: 'done', generate: 'running', verify: 'pending', learn: 'pending' }, oracleVerdicts: [] });
    state.tasks.set('t2', { id: 't2', goal: '', source: 'cli', routingLevel: 0, status: 'approval_required', startedAt: 0, pipeline: { perceive: 'done', predict: 'done', plan: 'done', generate: 'done', verify: 'done', learn: 'pending' }, oracleVerdicts: [] });
    updateTabBadges(state);
    expect(state.tabBadges.tasks?.count).toBe(1); // 1 running
    expect(state.tabBadges.tasks?.color).toBe('red'); // approval pending
  });

  test('computes events badge from event counter', () => {
    const state = createInitialState();
    state.eventIdCounter = 50;
    state.lastEventTabVisit = 10;
    updateTabBadges(state);
    expect(state.tabBadges.events?.count).toBe(40);
  });
});

describe('selectEvent', () => {
  test('sets selectedEventId', () => {
    const state = createInitialState();
    selectEvent(state, 42);
    expect(state.selectedEventId).toBe(42);
    expect(state.dirty).toBe(true);
  });
});

describe('setSort and cycleSortField', () => {
  test('setSort sets field with desc default', () => {
    const state = createInitialState();
    setSort(state, 'tasks', 'status');
    expect(state.sort.tasks).toEqual({ field: 'status', direction: 'desc' });
  });

  test('setSort toggles direction on same field', () => {
    const state = createInitialState();
    setSort(state, 'tasks', 'status');
    setSort(state, 'tasks', 'status');
    expect(state.sort.tasks).toEqual({ field: 'status', direction: 'asc' });
  });

  test('cycleSortField cycles through fields', () => {
    const state = createInitialState();
    cycleSortField(state, 'tasks');
    expect(state.sort.tasks?.field).toBe('startedAt');
    cycleSortField(state, 'tasks');
    expect(state.sort.tasks?.field).toBe('status');
    cycleSortField(state, 'tasks');
    expect(state.sort.tasks?.field).toBe('routingLevel');
    cycleSortField(state, 'tasks');
    expect(state.sort.tasks?.field).toBe('quality');
    cycleSortField(state, 'tasks');
    expect(state.sort.tasks?.field).toBe('startedAt'); // wraps
  });
});
