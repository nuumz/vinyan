/**
 * Input — keyboard handler, command parser, and input router for the TUI.
 *
 * Reads raw keypresses from stdin and dispatches actions based on
 * the current inputMode and activeTab.
 */

import {
  appendToBuffer,
  backspaceBuffer,
  enterCommandMode,
  enterFilterMode,
  exitInputMode,
  openModal,
} from './state.ts';
import type { TUIState, ViewTab } from './types.ts';

// ── Action Types ────────────────────────────────────────────────────

export type TUIAction =
  | { type: 'quit' }
  | { type: 'switch-tab'; tab: ViewTab }
  | { type: 'cycle-focus'; direction: 1 | -1 }
  | { type: 'navigate'; direction: 'up' | 'down' }
  | { type: 'select' }
  | { type: 'back' }
  | { type: 'command'; command: string }
  | { type: 'filter'; query: string }
  | { type: 'approve'; taskId: string }
  | { type: 'reject'; taskId: string }
  | { type: 'toggle-help' }
  | { type: 'refresh' }
  | { type: 'page-scroll'; direction: 'up' | 'down' }
  | { type: 'jump'; target: 'top' | 'bottom' }
  | { type: 'cancel-task'; taskId: string }
  | { type: 'focus-notification' }
  | { type: 'cycle-notification'; direction: 1 | -1 }
  | { type: 'new-task' }
  | { type: 'sort-cycle' }
  | { type: 'noop' };

// ── Command Parser ──────────────────────────────────────────────────

export interface ParsedCommand {
  name: string;
  args: string[];
  rawArg: string;
}

export function parseCommand(input: string): ParsedCommand {
  const trimmed = input.trim();
  // Match command name and the rest as a raw argument
  const match = trimmed.match(/^(\S+)\s*(.*)/);
  if (!match) return { name: '', args: [], rawArg: '' };

  const name = match[1]!;
  const rawArg = match[2] ?? '';
  // Split args, respecting quoted strings
  const args: string[] = [];
  const re = /"([^"]+)"|'([^']+)'|(\S+)/g;
  for (const m of rawArg.matchAll(re)) {
    args.push(m[1] ?? m[2] ?? m[3] ?? '');
  }

  return { name, args, rawArg };
}

// ── Keypress Reader ─────────────────────────────────────────────────

export interface KeypressInfo {
  name: string;
  sequence: string;
  ctrl: boolean;
  shift: boolean;
}

/** Parse a raw stdin buffer into keypress info. */
export function parseKeypress(buf: Buffer): KeypressInfo {
  const seq = buf.toString('utf-8');
  const ctrl = buf.length === 1 && buf[0]! < 27;

  // Special sequences
  if (seq === '\x1b[A') return { name: 'up', sequence: seq, ctrl: false, shift: false };
  if (seq === '\x1b[B') return { name: 'down', sequence: seq, ctrl: false, shift: false };
  if (seq === '\x1b[C') return { name: 'right', sequence: seq, ctrl: false, shift: false };
  if (seq === '\x1b[D') return { name: 'left', sequence: seq, ctrl: false, shift: false };
  if (seq === '\x1b[Z') return { name: 'tab', sequence: seq, ctrl: false, shift: true }; // Shift+Tab
  if (seq === '\x1b[5~') return { name: 'pageup', sequence: seq, ctrl: false, shift: false };
  if (seq === '\x1b[6~') return { name: 'pagedown', sequence: seq, ctrl: false, shift: false };
  if (seq === '\x1b') return { name: 'escape', sequence: seq, ctrl: false, shift: false };
  if (seq === '\r' || seq === '\n') return { name: 'return', sequence: seq, ctrl: false, shift: false };
  if (seq === '\t') return { name: 'tab', sequence: seq, ctrl: false, shift: false };
  if (seq === '\x7f' || seq === '\b') return { name: 'backspace', sequence: seq, ctrl: false, shift: false };
  if (seq === ' ') return { name: 'space', sequence: seq, ctrl: false, shift: false };

  // Ctrl+C
  if (buf.length === 1 && buf[0] === 3) return { name: 'c', sequence: seq, ctrl: true, shift: false };
  // Ctrl+D
  if (buf.length === 1 && buf[0] === 4) return { name: 'd', sequence: seq, ctrl: true, shift: false };

  // Regular character
  const name = ctrl ? String.fromCharCode(buf[0]! + 96) : seq;
  return { name, sequence: seq, ctrl, shift: false };
}

// ── Input Router ────────────────────────────────────────────────────

/** Route a keypress to a TUI action based on current state. */
export function routeKeypress(state: TUIState, key: KeypressInfo): TUIAction {
  // Ctrl+C always quits
  if (key.ctrl && key.name === 'c') return { type: 'quit' };

  // Modal mode — only modal-specific keys work
  if (state.modal) {
    return routeModalKey(state, key);
  }

  // Command/filter mode — buffer input
  if (state.inputMode === 'command' || state.inputMode === 'filter') {
    return routeBufferKey(state, key);
  }

  // Normal mode
  return routeNormalKey(state, key);
}

function routeModalKey(state: TUIState, key: KeypressInfo): TUIAction {
  if (key.name === 'escape') return { type: 'back' };

  if (state.modal?.type === 'approval' && state.modal.taskId) {
    if (key.name === 'a') return { type: 'approve', taskId: state.modal.taskId };
    if (key.name === 'r') return { type: 'reject', taskId: state.modal.taskId };
  }

  if (state.modal?.type === 'confirm-quit') {
    if (key.name === 'y') return { type: 'quit' };
    if (key.name === 'n' || key.name === 'escape') return { type: 'back' };
  }

  if (state.modal?.type === 'confirm-cancel' && state.modal.taskId) {
    if (key.name === 'y') return { type: 'cancel-task', taskId: state.modal.taskId };
    if (key.name === 'n' || key.name === 'escape') return { type: 'back' };
  }

  if (state.modal?.type === 'help') {
    if (key.name === '?' || key.name === 'escape') return { type: 'toggle-help' };
  }

  return { type: 'noop' };
}

function routeBufferKey(state: TUIState, key: KeypressInfo): TUIAction {
  if (key.name === 'escape') return { type: 'back' };
  if (key.name === 'backspace') {
    backspaceBuffer(state);
    return { type: 'noop' };
  }
  if (key.name === 'return') {
    const buffer = state.commandBuffer;
    const wasFilter = state.inputMode === 'filter';
    exitInputMode(state);
    if (buffer.length > 0) {
      return wasFilter ? { type: 'filter', query: buffer } : { type: 'command', command: buffer };
    }
    return { type: 'noop' };
  }
  // Printable characters
  if (key.sequence.length === 1 && key.sequence.charCodeAt(0) >= 32) {
    appendToBuffer(state, key.sequence);
    return { type: 'noop' };
  }
  return { type: 'noop' };
}

function routeNormalKey(state: TUIState, key: KeypressInfo): TUIAction {
  // Tab switching: 1-4
  if (key.name === '1') return { type: 'switch-tab', tab: 'tasks' };
  if (key.name === '2') return { type: 'switch-tab', tab: 'system' };
  if (key.name === '3') return { type: 'switch-tab', tab: 'peers' };
  if (key.name === '4') return { type: 'switch-tab', tab: 'events' };

  // Navigation
  if (key.name === 'tab') return { type: 'cycle-focus', direction: key.shift ? -1 : 1 };
  if (key.name === 'j' || key.name === 'down') return { type: 'navigate', direction: 'down' };
  if (key.name === 'k' || key.name === 'up') return { type: 'navigate', direction: 'up' };
  if (key.name === 'return') return { type: 'select' };
  if (key.name === 'escape') return { type: 'back' };

  // Page scroll & jump (PgUp/PgDn, Ctrl+d/u, g, G)
  if (key.name === 'pagedown') return { type: 'page-scroll', direction: 'down' };
  if (key.name === 'pageup') return { type: 'page-scroll', direction: 'up' };
  if (key.ctrl && key.name === 'd') return { type: 'page-scroll', direction: 'down' };
  if (key.ctrl && key.name === 'u') return { type: 'page-scroll', direction: 'up' };
  if (key.name === 'g' && !key.shift) return { type: 'jump', target: 'top' };
  if (key.name === 'G' || (key.name === 'g' && key.shift)) return { type: 'jump', target: 'bottom' };

  // Notification cycling
  if (key.name === '[') return { type: 'cycle-notification', direction: -1 };
  if (key.name === ']') return { type: 'cycle-notification', direction: 1 };

  // Space: focus notification if present, else select
  if (key.name === 'space') {
    const hasNotification = state.notifications.some((n) => !n.dismissed);
    return hasNotification ? { type: 'focus-notification' } : { type: 'select' };
  }

  // Context-sensitive: a/r — approve/reject
  // Priority: notification target > selected task
  const pendingNotif = state.notifications.find((n) => !n.dismissed && n.type === 'approval');
  const selectedTask = state.selectedTaskId ? state.tasks.get(state.selectedTaskId) : undefined;

  if (key.name === 'a') {
    const targetId = pendingNotif?.taskId ?? (selectedTask?.pendingApproval ? selectedTask.id : undefined);
    if (targetId) return { type: 'approve', taskId: targetId };
  }
  if (key.name === 'r') {
    const targetId = pendingNotif?.taskId ?? (selectedTask?.pendingApproval ? selectedTask.id : undefined);
    if (targetId) return { type: 'reject', taskId: targetId };
    // Fallback: refresh
    return { type: 'refresh' };
  }

  // Cancel running task (with confirmation)
  if (key.name === 'c' && selectedTask?.status === 'running') {
    openModal(state, { type: 'confirm-cancel', taskId: selectedTask.id });
    return { type: 'noop' };
  }

  // New task (Tasks tab only)
  if (key.name === 'n' && state.activeTab === 'tasks') return { type: 'new-task' };

  // Sort cycle (Tasks/Peers/Events tabs)
  if (key.name === 's' && (state.activeTab === 'tasks' || state.activeTab === 'peers' || state.activeTab === 'events')) {
    return { type: 'sort-cycle' };
  }

  // Mode entry
  if (key.name === ':') {
    enterCommandMode(state);
    return { type: 'noop' };
  }
  if (key.name === '/') {
    enterFilterMode(state);
    return { type: 'noop' };
  }

  // Help
  if (key.name === '?') return { type: 'toggle-help' };

  // Quit
  if (key.name === 'q') {
    const hasRunning = [...state.tasks.values()].some((t) => t.status === 'running');
    if (hasRunning) {
      openModal(state, { type: 'confirm-quit' });
      return { type: 'noop' };
    }
    return { type: 'quit' };
  }

  return { type: 'noop' };
}

// ── Stdin Stream Setup ──────────────────────────────────────────────

/**
 * Start reading raw keypresses from stdin.
 * Returns a cleanup function.
 *
 * ESC ambiguity: raw mode may split arrow/escape sequences across data events
 * (e.g. \x1b arrives first, then [A). We buffer a lone \x1b for 50ms —
 * if the next data event arrives within that window we merge and re-parse;
 * if the timeout fires first we dispatch it as a real ESC keypress.
 */
export function startKeyListener(onKey: (key: KeypressInfo) => void): () => void {
  if (!process.stdin.isTTY) return () => {};

  process.stdin.setRawMode(true);
  process.stdin.resume();

  let escTimer: ReturnType<typeof setTimeout> | null = null;

  const dispatch = (data: Buffer) => {
    onKey(parseKeypress(data));
  };

  const handler = (data: Buffer) => {
    // If we have a pending ESC, check if this continues the sequence
    if (escTimer !== null) {
      clearTimeout(escTimer);
      escTimer = null;
      // Merge: \x1b + new bytes = full escape sequence
      const merged = Buffer.concat([Buffer.from('\x1b'), data]);
      dispatch(merged);
      return;
    }

    // Lone \x1b — hold for 50ms to detect escape sequences split across events
    const seq = data.toString('utf-8');
    if (seq === '\x1b') {
      escTimer = setTimeout(() => {
        escTimer = null;
        dispatch(data);
      }, 50);
      return;
    }

    dispatch(data);
  };

  process.stdin.on('data', handler);

  return () => {
    if (escTimer !== null) {
      clearTimeout(escTimer);
      escTimer = null;
    }
    process.stdin.removeListener('data', handler);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  };
}
