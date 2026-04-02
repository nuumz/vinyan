/**
 * TUI State — state management and mutations for the interactive terminal UI.
 */

import type { EventLogEntry, TUIState, ViewTab } from './types.ts';

// ── Initial State ───────────────────────────────────────────────────

export function createInitialState(): TUIState {
  return {
    activeTab: 'dashboard',
    focusedPanel: 0,
    inputMode: 'normal',
    commandBuffer: '',
    filterQuery: '',
    modal: null,

    health: null,
    metrics: null,
    eventLog: [],
    eventLogMaxSize: 1000,
    eventIdCounter: 0,

    tasks: new Map(),
    selectedTaskId: null,

    peers: new Map(),
    selectedPeerId: null,

    termWidth: process.stdout.columns || 120,
    termHeight: process.stdout.rows || 40,
    startedAt: Date.now(),
    dirty: true,

    eventLogScroll: 0,
    taskListScroll: 0,
    peerListScroll: 0,
  };
}

// ── State Mutations ─────────────────────────────────────────────────

export function pushEvent(state: TUIState, entry: Omit<EventLogEntry, 'id'>): void {
  state.eventIdCounter++;
  state.eventLog.push({ ...entry, id: state.eventIdCounter });
  if (state.eventLog.length > state.eventLogMaxSize) {
    state.eventLog.shift();
  }
  state.dirty = true;
}

export function switchTab(state: TUIState, tab: ViewTab): void {
  state.activeTab = tab;
  state.focusedPanel = 0;
  state.dirty = true;
}

export function cycleFocus(state: TUIState, maxPanels: number, direction: 1 | -1 = 1): void {
  state.focusedPanel = (state.focusedPanel + direction + maxPanels) % maxPanels;
  state.dirty = true;
}

export function enterCommandMode(state: TUIState): void {
  state.inputMode = 'command';
  state.commandBuffer = '';
  state.dirty = true;
}

export function enterFilterMode(state: TUIState): void {
  state.inputMode = 'filter';
  state.commandBuffer = '';
  state.dirty = true;
}

export function exitInputMode(state: TUIState): void {
  state.inputMode = 'normal';
  state.commandBuffer = '';
  state.dirty = true;
}

export function appendToBuffer(state: TUIState, char: string): void {
  state.commandBuffer += char;
  state.dirty = true;
}

export function backspaceBuffer(state: TUIState): void {
  state.commandBuffer = state.commandBuffer.slice(0, -1);
  state.dirty = true;
}

export function selectTask(state: TUIState, taskId: string | null): void {
  state.selectedTaskId = taskId;
  state.dirty = true;
}

export function selectPeer(state: TUIState, peerId: string | null): void {
  state.selectedPeerId = peerId;
  state.dirty = true;
}

export function scrollList(state: TUIState, list: 'eventLog' | 'taskList' | 'peerList', delta: number): void {
  const key = `${list}Scroll` as keyof TUIState;
  const current = state[key] as number;
  state[key as 'eventLogScroll' | 'taskListScroll' | 'peerListScroll'] = Math.max(0, current + delta);
  state.dirty = true;
}

export function openModal(state: TUIState, modal: TUIState['modal']): void {
  state.modal = modal;
  state.dirty = true;
}

export function closeModal(state: TUIState): void {
  state.modal = null;
  state.dirty = true;
}

export function markClean(state: TUIState): void {
  state.dirty = false;
}

export function updateTermSize(state: TUIState): void {
  const w = process.stdout.columns || 120;
  const h = process.stdout.rows || 40;
  if (w !== state.termWidth || h !== state.termHeight) {
    state.termWidth = w;
    state.termHeight = h;
    state.dirty = true;
  }
}
