import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInitialState } from '../../src/tui/state.ts';
import { restoreSession, saveSession } from '../../src/tui/session.ts';

describe('TUI session persistence', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'vinyan-session-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  test('saveSession writes tui-session.json', () => {
    const state = createInitialState(workspace);
    state.activeTab = 'events';
    state.eventLogMaxSize = 500;
    state.filterQuery = 'task';
    state.sort = { tasks: { field: 'status', direction: 'asc' } };

    saveSession(state, workspace);

    const path = join(workspace, '.vinyan', 'tui-session.json');
    expect(existsSync(path)).toBe(true);

    const data = JSON.parse(readFileSync(path, 'utf-8'));
    expect(data.activeTab).toBe('events');
    expect(data.eventLogMaxSize).toBe(500);
    expect(data.filterQuery).toBe('task');
    expect(data.sort.tasks.field).toBe('status');
  });

  test('restoreSession loads saved preferences', () => {
    const state1 = createInitialState(workspace);
    state1.activeTab = 'peers';
    state1.eventLogMaxSize = 200;
    state1.filterQuery = 'err';
    state1.sort = { events: { field: 'status', direction: 'desc' } };
    saveSession(state1, workspace);

    const state2 = createInitialState(workspace);
    expect(state2.activeTab).toBe('tasks'); // default

    const restored = restoreSession(state2, workspace);
    expect(restored).toBe(true);
    expect(state2.activeTab).toBe('peers');
    expect(state2.eventLogMaxSize).toBe(200);
    expect(state2.filterQuery).toBe('err');
    expect(state2.sort.events?.field).toBe('status');
  });

  test('restoreSession returns false when no file exists', () => {
    const state = createInitialState(workspace);
    expect(restoreSession(state, workspace)).toBe(false);
    expect(state.activeTab).toBe('tasks'); // unchanged
  });

  test('restoreSession handles corrupted file gracefully', () => {
    const { mkdirSync, writeFileSync } = require('node:fs');
    mkdirSync(join(workspace, '.vinyan'), { recursive: true });
    writeFileSync(join(workspace, '.vinyan', 'tui-session.json'), '{broken json!!', 'utf-8');

    const state = createInitialState(workspace);
    expect(restoreSession(state, workspace)).toBe(false);
    expect(state.activeTab).toBe('tasks'); // unchanged
  });

  test('restoreSession ignores invalid activeTab', () => {
    const { mkdirSync, writeFileSync } = require('node:fs');
    mkdirSync(join(workspace, '.vinyan'), { recursive: true });
    writeFileSync(
      join(workspace, '.vinyan', 'tui-session.json'),
      JSON.stringify({ activeTab: 'invalid_tab', eventLogMaxSize: 300 }),
      'utf-8',
    );

    const state = createInitialState(workspace);
    restoreSession(state, workspace);
    expect(state.activeTab).toBe('tasks'); // invalid tab ignored
    expect(state.eventLogMaxSize).toBe(300); // valid field applied
  });

  test('round-trip preserves all settings', () => {
    const state1 = createInitialState(workspace);
    state1.activeTab = 'system';
    state1.eventLogMaxSize = 42;
    state1.filterQuery = 'worker:error';
    state1.sort = {
      tasks: { field: 'status', direction: 'desc' },
      peers: { field: 'quality', direction: 'asc' },
    };

    saveSession(state1, workspace);

    const state2 = createInitialState(workspace);
    restoreSession(state2, workspace);

    expect(state2.activeTab).toBe('system');
    expect(state2.eventLogMaxSize).toBe(42);
    expect(state2.filterQuery).toBe('worker:error');
    expect(state2.sort).toEqual({
      tasks: { field: 'status', direction: 'desc' },
      peers: { field: 'quality', direction: 'asc' },
    });
  });
});
