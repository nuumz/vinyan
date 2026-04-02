/**
 * TUI State — state management and mutations for the interactive terminal UI.
 */

import type { EventLogEntry, NotificationEntry, PeerSortField, SortConfig, SortField, TUIState, ViewTab } from './types.ts';

// ── Initial State ───────────────────────────────────────────────────

export function createInitialState(workspace = '.'): TUIState {
  return {
    activeTab: 'tasks',
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

    successHistory: [],

    termWidth: process.stdout.columns || 120,
    termHeight: process.stdout.rows || 40,
    startedAt: Date.now(),
    dirty: true,

    eventLogScroll: 0,
    eventDetailScroll: 0,
    taskListScroll: 0,
    peerListScroll: 0,

    // New: Notifications & Feedback
    notifications: [],
    notificationIdCounter: 0,
    notificationIndex: 0,
    toasts: [],
    tabBadges: {},

    // New: Events tab
    selectedEventId: null,
    lastEventTabVisit: 0,

    // New: Sorting
    sort: {},

    // New: Real-time counters
    realtimeCounters: {},

    // New: Workspace
    workspace,

    // Loading state — TUI renders immediately, data arrives later
    loading: true,
    loadingMessage: 'Starting Vinyan...',
    bootLog: [],
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
  if (tab === 'events') {
    state.lastEventTabVisit = state.eventIdCounter;
  }
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

// ── Notification Mutations ──────────────────────────────────────────

export function pushNotification(
  state: TUIState,
  entry: Omit<NotificationEntry, 'id'>,
): void {
  state.notificationIdCounter++;
  state.notifications.push({ ...entry, id: state.notificationIdCounter });
  // Sort by priority (1 = highest) so highest-priority is always first
  state.notifications.sort((a, b) => a.priority - b.priority);
  state.dirty = true;
}

export function dismissNotification(state: TUIState, id: number): void {
  state.notifications = state.notifications.filter((n) => n.id !== id);
  // Clamp notificationIndex to valid range
  if (state.notifications.length === 0) {
    state.notificationIndex = 0;
  } else if (state.notificationIndex >= state.notifications.length) {
    state.notificationIndex = state.notifications.length - 1;
  }
  state.dirty = true;
}

export function cycleNotification(state: TUIState, direction: 1 | -1): void {
  const len = state.notifications.length;
  if (len === 0) return;
  state.notificationIndex = (state.notificationIndex + direction + len) % len;
  state.dirty = true;
}

// ── Toast Mutations ─────────────────────────────────────────────────

export function pushToast(
  state: TUIState,
  message: string,
  level: 'info' | 'success' | 'warning' | 'error' = 'info',
): void {
  state.toasts.push({ message, level, expiresAt: Date.now() + 3000 });
  state.dirty = true;
}

export function cleanExpiredToasts(state: TUIState): void {
  const now = Date.now();
  const before = state.toasts.length;
  state.toasts = state.toasts.filter((t) => t.expiresAt > now);
  if (state.toasts.length !== before) {
    state.dirty = true;
  }
}

// ── Tab Badge Mutations ─────────────────────────────────────────────

export function updateTabBadges(state: TUIState): void {
  // Tasks badge: running count, red if any approval pending
  let running = 0;
  let hasApproval = false;
  for (const task of state.tasks.values()) {
    if (task.status === 'running') running++;
    if (task.status === 'approval_required') hasApproval = true;
  }
  state.tabBadges.tasks =
    running > 0 || hasApproval ? { count: running, color: hasApproval ? 'red' : undefined } : undefined;

  // System badge: health dot (no count)
  const healthColor = state.health?.status === 'unhealthy' ? 'red' : state.health?.status === 'degraded' ? 'yellow' : 'green';
  state.tabBadges.system = { count: 0, color: healthColor };

  // Peers badge: connected count
  let connected = 0;
  for (const peer of state.peers.values()) {
    if (peer.healthState === 'connected') connected++;
  }
  state.tabBadges.peers = connected > 0 ? { count: connected } : undefined;

  // Events badge: new events since last tab visit
  const newEvents = state.eventIdCounter - state.lastEventTabVisit;
  state.tabBadges.events = newEvents > 0 ? { count: newEvents } : undefined;
}

// ── Event Selection ─────────────────────────────────────────────────

export function selectEvent(state: TUIState, eventId: number | null): void {
  state.selectedEventId = eventId;
  state.eventDetailScroll = 0;
  state.dirty = true;
}

// ── Sort Mutations ──────────────────────────────────────────────────

const SORT_FIELDS: SortField[] = ['startedAt', 'status', 'routingLevel', 'quality'];
const PEER_SORT_FIELDS: PeerSortField[] = ['trust', 'health', 'lastSeen'];
const EVENT_SORT_FIELDS: string[] = ['timestamp', 'domain'];

export function setSort(state: TUIState, tab: ViewTab, field: SortField): void {
  const current = state.sort[tab];
  if (current?.field === field) {
    // Toggle direction
    state.sort[tab] = { field, direction: current.direction === 'desc' ? 'asc' : 'desc' } as SortConfig;
  } else {
    state.sort[tab] = { field, direction: 'desc' } as SortConfig;
  }
  state.dirty = true;
}

export function cycleSortField(state: TUIState, tab: ViewTab): void {
  const fields = tab === 'peers' ? PEER_SORT_FIELDS : tab === 'events' ? EVENT_SORT_FIELDS : SORT_FIELDS;
  const current = state.sort[tab];
  const currentIdx = current ? fields.indexOf(current.field as any) : -1;
  const nextIdx = (currentIdx + 1) % fields.length;
  state.sort[tab] = { field: fields[nextIdx]!, direction: 'desc' } as SortConfig;
  state.dirty = true;
}
