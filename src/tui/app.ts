/**
 * TUI App — main interactive application loop.
 *
 * Wires together: Screen (rendering), Input (keyboard), DataSource (events),
 * and Views (dashboard, tasks, peers) into a cohesive interactive terminal UI.
 */

import type { DataSource } from './data/source.ts';
import { getContextHints } from './hints.ts';
import { saveSession } from './session.ts';
import { parseCommand, routeKeypress, startKeyListener, type TUIAction } from './input.ts';
import {
  ANSI,
  bold,
  color,
  contextHintsBar,
  dim,
  headerBar,
  notificationBar,
  tabBarWithBadges,
  terminalSizeGuard,
} from './renderer.ts';
import { Screen, type ViewRenderer } from './screen.ts';
import {
  cleanExpiredToasts,
  closeModal,
  cycleFocus,
  cycleNotification,
  cycleSortField,
  dismissNotification,
  exitInputMode,
  enterCommandMode,
  openModal,
  pushToast,
  selectEvent,
  selectPeer,
  selectTask,
  switchTab,
  updateTabBadges,
} from './state.ts';
import type { TUIState, ViewTab } from './types.ts';
import { renderApprovalModal, renderConfirmCancel, renderConfirmQuit } from './views/approval-modal.ts';
import { EVENTS_PANEL_COUNT, renderEvents } from './views/events.ts';
import { renderHelpOverlay } from './views/help.ts';
import { PEERS_PANEL_COUNT, renderPeers } from './views/peers.ts';
import { SYSTEM_PANEL_COUNT, renderSystem } from './views/system.ts';
import { renderTasks, TASKS_PANEL_COUNT } from './views/tasks.ts';

export interface AppConfig {
  state: TUIState;
  dataSource?: DataSource;
}

const TABS: Array<{ key: string; label: string; tab: ViewTab }> = [
  { key: '1', label: 'Tasks', tab: 'tasks' },
  { key: '2', label: 'System', tab: 'system' },
  { key: '3', label: 'Peers', tab: 'peers' },
  { key: '4', label: 'Events', tab: 'events' },
];

export class App {
  private state: TUIState;
  private dataSource: DataSource | null;
  private screen: Screen;
  private stopKeyListener: (() => void) | null = null;
  private running = false;
  private onCleanup: (() => void) | null = null;

  // Console capture — prevents raw stdout from bleeding into TUI
  private originalConsole: {
    log: typeof console.log;
    warn: typeof console.warn;
    error: typeof console.error;
  } | null = null;

  // Cached Map.keys() arrays — invalidate when collection size changes
  private _taskKeysCache: string[] = [];
  private _taskKeysSize = 0;
  private _peerKeysCache: string[] = [];
  private _peerKeysSize = 0;

  constructor(config: AppConfig) {
    this.state = config.state;
    this.dataSource = config.dataSource ?? null;

    const viewRenderer: ViewRenderer = (s) => this.renderFrame(s);
    this.screen = new Screen(this.state, viewRenderer);
  }

  /** Wire the data source after construction (for deferred loading). */
  wireDataSource(ds: DataSource): void {
    this.dataSource = ds;
    ds.start();
    this.state.loading = false;
    this.state.loadingMessage = '';
    this.state.dirty = true;
  }

  /** Register a cleanup callback (e.g. orchestrator.close). */
  onShutdown(fn: () => void): void {
    this.onCleanup = fn;
  }

  /** Intercept console output — route to bootLog instead of raw stdout. */
  private captureConsole(): void {
    this.originalConsole = {
      log: console.log,
      warn: console.warn,
      error: console.error,
    };

    const capture = (level: 'log' | 'warn' | 'error') => (...args: unknown[]) => {
      const message = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      this.state.bootLog.push({ message, level, timestamp: Date.now() });
      if (this.state.bootLog.length > 50) this.state.bootLog.shift();
      this.state.dirty = true;
    };

    console.log = capture('log');
    console.warn = capture('warn');
    console.error = capture('error');
  }

  /** Restore original console methods. */
  private restoreConsole(): void {
    if (this.originalConsole) {
      console.log = this.originalConsole.log;
      console.warn = this.originalConsole.warn;
      console.error = this.originalConsole.error;
      this.originalConsole = null;
    }
  }

  /** Start the interactive TUI. Returns when the user quits. */
  async run(): Promise<void> {
    this.running = true;

    // Capture console before anything else — prevents log bleed on loading screen
    this.captureConsole();

    // Start data source if already available
    if (this.dataSource) {
      this.dataSource.start();
      this.state.loading = false;
    }

    // Start rendering immediately — shows loading screen or real content
    this.screen.start();

    // Start keyboard input — responsive even during loading
    this.stopKeyListener = startKeyListener((key) => {
      const action = routeKeypress(this.state, key);
      this.handleAction(action);
    });

    // Wait until quit
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (!this.running) {
          clearInterval(check);
          resolve();
        }
      }, 100);
    });

    // Cleanup
    this.shutdown();
  }

  private shutdown(): void {
    this.restoreConsole();
    saveSession(this.state, this.state.workspace);
    this.stopKeyListener?.();
    this.screen.stop();
    this.dataSource?.stop();
    this.onCleanup?.();
  }

  // ── Action Handler ──────────────────────────────────────────────

  private handleAction(action: TUIAction): void {
    // During loading, only allow quit, help, and back
    if (this.state.loading) {
      switch (action.type) {
        case 'quit':
          this.running = false;
          return;
        case 'toggle-help':
          if (this.state.modal?.type === 'help') {
            closeModal(this.state);
          } else {
            openModal(this.state, { type: 'help' });
          }
          return;
        case 'back':
          if (this.state.modal) closeModal(this.state);
          return;
        default:
          // Swallow other actions during loading — no toast spam
          return;
      }
    }

    switch (action.type) {
      case 'quit':
        this.running = false;
        break;

      case 'switch-tab':
        switchTab(this.state, action.tab);
        break;

      case 'cycle-focus': {
        const maxPanels = this.getMaxPanels();
        cycleFocus(this.state, maxPanels, action.direction);
        break;
      }

      case 'navigate':
        this.handleNavigation(action.direction);
        break;

      case 'select':
        this.handleSelect();
        break;

      case 'back':
        if (this.state.modal) {
          closeModal(this.state);
        } else if (this.state.inputMode !== 'normal') {
          exitInputMode(this.state);
        }
        break;

      case 'command':
        this.handleCommand(action.command);
        break;

      case 'filter':
        this.state.filterQuery = action.query;
        this.state.tabFilters[this.state.activeTab] = action.query;
        this.state.dirty = true;
        break;

      case 'approve':
        this.dataSource?.approveTask(action.taskId);
        closeModal(this.state);
        // Dismiss matching notification
        const approveNotif = this.state.notifications.find((n) => n.taskId === action.taskId && !n.dismissed);
        if (approveNotif) dismissNotification(this.state, approveNotif.id);
        pushToast(this.state, `✓ Approved ${action.taskId}`, 'success');
        break;

      case 'reject':
        this.dataSource?.rejectTask(action.taskId);
        closeModal(this.state);
        const rejectNotif = this.state.notifications.find((n) => n.taskId === action.taskId && !n.dismissed);
        if (rejectNotif) dismissNotification(this.state, rejectNotif.id);
        pushToast(this.state, `✗ Rejected ${action.taskId}`, 'warning');
        break;

      case 'toggle-help':
        if (this.state.modal?.type === 'help') {
          closeModal(this.state);
        } else {
          openModal(this.state, { type: 'help' });
        }
        break;

      case 'refresh':
        this.state.dirty = true;
        break;

      case 'page-scroll':
        this.handlePageScroll(action.direction);
        break;

      case 'jump':
        this.handleJump(action.target);
        break;

      case 'cancel-task':
        this.dataSource?.cancelTask(action.taskId);
        closeModal(this.state);
        pushToast(this.state, `⊘ Cancel requested: ${action.taskId}`, 'info');
        break;

      case 'focus-notification': {
        const pending = this.state.notifications.filter((n) => !n.dismissed);
        const idx = Math.min(this.state.notificationIndex, pending.length - 1);
        const target = pending[idx];
        if (target?.taskId) {
          switchTab(this.state, 'tasks');
          selectTask(this.state, target.taskId);
        }
        break;
      }

      case 'cycle-notification':
        cycleNotification(this.state, action.direction);
        break;

      case 'new-task':
        enterCommandMode(this.state);
        this.state.commandBuffer = 'run ';
        this.state.dirty = true;
        break;

      case 'sort-cycle':
        cycleSortField(this.state, this.state.activeTab);
        break;

      case 'noop':
        break;
    }
  }

  private handleNavigation(direction: 'up' | 'down'): void {
    const delta = direction === 'down' ? 1 : -1;
    const { activeTab, focusedPanel } = this.state;

    if (activeTab === 'events') {
      if (focusedPanel === 1) {
        // Detail pane scroll
        this.state.eventDetailScroll = Math.max(0, this.state.eventDetailScroll + delta);
        this.state.dirty = true;
        return;
      }
      this.navigateEventList(delta, -1);
      return;
    }

    if (focusedPanel !== 0 || (activeTab !== 'tasks' && activeTab !== 'peers')) return;
    const nav = this.getNavConfig(activeTab);
    const currentIdx = nav.selectedId ? nav.keys.indexOf(nav.selectedId) : -1;
    this.navigateList(nav.keys, currentIdx + delta, nav.select, nav.scrollKey, nav.maxVisible);
  }

  private handleSelect(): void {
    switch (this.state.activeTab) {
      case 'tasks':
        if (this.state.selectedTaskId) {
          const task = this.state.tasks.get(this.state.selectedTaskId);
          if (task?.pendingApproval) {
            openModal(this.state, {
              type: 'approval',
              taskId: task.id,
              riskScore: task.pendingApproval.riskScore,
              reason: task.pendingApproval.reason,
            });
            return;
          }
        }
        // Toggle to detail pane
        cycleFocus(this.state, this.getMaxPanels(), 1);
        break;

      case 'events': {
        const visibleLog = this.getVisibleEventLog();
        if (!this.state.selectedEventId && visibleLog.length > 0) {
          selectEvent(this.state, visibleLog[0]!.id);
        }
        // Toggle to detail pane
        cycleFocus(this.state, this.getMaxPanels(), 1);
        break;
      }

      case 'peers':
        if (!this.state.selectedPeerId) {
          const firstPeer = this.getPeerKeys()[0];
          if (firstPeer) selectPeer(this.state, firstPeer);
        }
        // Toggle to detail pane
        cycleFocus(this.state, this.getMaxPanels(), 1);
        break;
    }
  }

  private handlePageScroll(direction: 'up' | 'down'): void {
    const viewH = this.state.termHeight - 4;
    const pageDelta = Math.max(1, Math.floor(viewH / 2));
    const delta = direction === 'down' ? pageDelta : -pageDelta;
    const { activeTab, focusedPanel } = this.state;

    if (activeTab === 'events') {
      if (focusedPanel === 1) {
        this.state.eventDetailScroll = Math.max(0, this.state.eventDetailScroll + delta);
        this.state.dirty = true;
        return;
      }
      this.navigateEventList(delta, 0);
      return;
    }

    if (activeTab !== 'tasks' && activeTab !== 'peers') return;
    const nav = this.getNavConfig(activeTab);
    const currentIdx = nav.selectedId ? nav.keys.indexOf(nav.selectedId) : 0;
    this.navigateList(nav.keys, currentIdx + delta, nav.select, nav.scrollKey, nav.maxVisible);
  }

  private handleJump(target: 'top' | 'bottom'): void {
    if (this.state.activeTab === 'events') {
      const log = this.getVisibleEventLog();
      if (log.length === 0) return;
      const idx = target === 'top' ? 0 : log.length - 1;
      selectEvent(this.state, log[idx]!.id);
      this.autoScrollEvents(idx, log.length);
      return;
    }

    const tab = this.state.activeTab;
    if (tab !== 'tasks' && tab !== 'peers') return;
    const nav = this.getNavConfig(tab);
    if (nav.keys.length === 0) return;
    const idx = target === 'top' ? 0 : nav.keys.length - 1;
    this.navigateList(nav.keys, idx, nav.select, nav.scrollKey, nav.maxVisible);
  }

  // ── Navigation helpers ──────────────────────────────────────────

  private getTaskKeys(): string[] {
    if (this.state.tasks.size !== this._taskKeysSize) {
      this._taskKeysCache = [...this.state.tasks.keys()];
      this._taskKeysSize = this.state.tasks.size;
    }
    return this._taskKeysCache;
  }

  private getPeerKeys(): string[] {
    if (this.state.peers.size !== this._peerKeysSize) {
      this._peerKeysCache = [...this.state.peers.keys()];
      this._peerKeysSize = this.state.peers.size;
    }
    return this._peerKeysCache;
  }

  private getNavConfig(tab: 'tasks' | 'peers') {
    const viewH = this.state.termHeight - 4;
    if (tab === 'tasks') {
      return {
        keys: this.getTaskKeys(),
        selectedId: this.state.selectedTaskId,
        select: (id: string | null) => selectTask(this.state, id),
        scrollKey: 'taskListScroll' as const,
        maxVisible: Math.max(1, Math.floor((viewH - 3) / 2)),
      };
    }
    return {
      keys: this.getPeerKeys(),
      selectedId: this.state.selectedPeerId,
      select: (id: string | null) => selectPeer(this.state, id),
      scrollKey: 'peerListScroll' as const,
      maxVisible: Math.max(1, viewH - 4),
    };
  }

  /** Generic list navigation: clamp target index, select item, auto-scroll. */
  private navigateList(
    keys: string[],
    targetIdx: number,
    select: (id: string | null) => void,
    scrollKey: 'taskListScroll' | 'peerListScroll',
    maxVisible: number,
  ): void {
    if (keys.length === 0) return;
    const idx = Math.max(0, Math.min(keys.length - 1, targetIdx));
    select(keys[idx] ?? null);
    if (idx < this.state[scrollKey]) {
      this.state[scrollKey] = idx;
    } else if (idx >= this.state[scrollKey] + maxVisible) {
      this.state[scrollKey] = idx - maxVisible + 1;
    }
    this.state.dirty = true;
  }

  /** Returns the filtered (and sorted) event list matching the current filterQuery — same order as the rendered list. */
  private getVisibleEventLog(): import('./types.ts').EventLogEntry[] {
    const { eventLog, filterQuery, sort } = this.state;
    const sortConfig = sort.events as import('./types.ts').SortConfig<import('./types.ts').EventSortField> | undefined;
    let result = eventLog;
    // Apply same sort as renderEvents
    if (sortConfig) {
      const dir = sortConfig.direction === 'asc' ? 1 : -1;
      result = [...result].sort((a, b) =>
        sortConfig.field === 'domain' ? dir * a.domain.localeCompare(b.domain) : dir * (a.timestamp - b.timestamp),
      );
    }
    // Apply filter
    if (filterQuery) {
      result = result.filter((e) => e.domain.includes(filterQuery) || e.event.includes(filterQuery));
    }
    return result;
  }

  /** Navigate event list with reverse-scroll awareness. */
  private navigateEventList(delta: number, noSelectionDefault: number): void {
    const log = this.getVisibleEventLog();
    if (log.length === 0) return;
    const currentIdx = this.state.selectedEventId
      ? log.findIndex((e) => e.id === this.state.selectedEventId)
      : noSelectionDefault;
    const newIdx = Math.max(0, Math.min(log.length - 1, currentIdx + delta));
    selectEvent(this.state, log[newIdx]?.id ?? null);
    this.autoScrollEvents(newIdx, log.length);
  }

  /** Keep selected event visible (events show newest at bottom). */
  private autoScrollEvents(idx: number, total: number): void {
    const viewH = this.state.termHeight - 4;
    const maxVisible = Math.max(1, viewH - 3);
    // Events use reverse scroll: eventLogScroll = offset from bottom
    const bottomIdx = total - 1;
    const distFromBottom = bottomIdx - idx;
    if (distFromBottom < this.state.eventLogScroll) {
      this.state.eventLogScroll = distFromBottom;
    } else if (distFromBottom >= this.state.eventLogScroll + maxVisible) {
      this.state.eventLogScroll = distFromBottom - maxVisible + 1;
    }
    this.state.dirty = true;
  }

  private handleCommand(input: string): void {
    const cmd = parseCommand(input);
    switch (cmd.name) {
      case 'run': {
        const goal = cmd.args[0] ?? cmd.rawArg;
        if (goal) {
          // Extract --level N flag
          const levelMatch = cmd.rawArg.match(/--level\s+(\d+)/);
          const level = levelMatch ? Number.parseInt(levelMatch[1]!, 10) : undefined;
          this.dataSource?.submitTask({
            id: `task-${Date.now().toString(36)}`,
            source: 'cli',
            goal: goal.replace(/--level\s+\d+/, '').trim(),
            budget: { maxTokens: 10_000, maxDurationMs: 60_000, maxRetries: 3 },
            ...(level != null && { routingLevel: level }),
          });
          switchTab(this.state, 'tasks');
        }
        break;
      }

      case 'approve': {
        const taskId = cmd.args[0] ?? this.getNotificationTargetId();
        if (taskId) {
          this.dataSource?.approveTask(taskId);
          pushToast(this.state, `Approved ${taskId}`, 'success');
        }
        break;
      }

      case 'reject': {
        const taskId = cmd.args[0] ?? this.getNotificationTargetId();
        if (taskId) {
          this.dataSource?.rejectTask(taskId);
          pushToast(this.state, `Rejected ${taskId}`, 'success');
        }
        break;
      }

      case 'cancel': {
        const taskId = cmd.args[0] ?? this.state.selectedTaskId;
        if (taskId) {
          this.dataSource?.cancelTask(taskId);
          pushToast(this.state, `Cancelled ${taskId}`, 'success');
        }
        break;
      }

      case 'sort': {
        const field = cmd.args[0];
        if (field) {
          const tab = this.state.activeTab;
          this.state.sort[tab] = { field: field as any, direction: 'desc' };
          this.state.dirty = true;
          pushToast(this.state, `Sort: ${field} desc`, 'info');
        }
        break;
      }

      case 'set': {
        const [key, value] = cmd.args;
        if (key && value) {
          switch (key) {
            case 'eventLogMaxSize': {
              const n = Number.parseInt(value, 10);
              if (!Number.isNaN(n) && n > 0) {
                this.state.eventLogMaxSize = n;
                pushToast(this.state, `Set eventLogMaxSize=${n}`, 'info');
              } else {
                pushToast(this.state, `Invalid value: ${value}`, 'warning');
              }
              break;
            }
            default:
              pushToast(this.state, `Unknown key: ${key}`, 'warning');
          }
        } else {
          pushToast(this.state, 'Usage: :set <key> <value>', 'warning');
        }
        break;
      }

      case 'filter':
        this.state.filterQuery = cmd.rawArg;
        this.state.tabFilters[this.state.activeTab] = cmd.rawArg;
        this.state.dirty = true;
        break;

      case 'sleep':
        this.dataSource?.triggerSleepCycle();
        break;

      case 'export':
        this.dataSource?.exportPatterns(cmd.rawArg || 'vinyan-patterns.json');
        break;

      case 'clear':
        this.state.filterQuery = '';
        this.state.tabFilters[this.state.activeTab] = '';
        this.state.dirty = true;
        break;
    }
  }

  /** Get the taskId from the current notification (for approve/reject default). */
  private getNotificationTargetId(): string | undefined {
    const { notifications, notificationIndex } = this.state;
    const pending = notifications.filter((n) => !n.dismissed);
    return pending[notificationIndex]?.taskId;
  }

  private getMaxPanels(): number {
    switch (this.state.activeTab) {
      case 'tasks':
        return TASKS_PANEL_COUNT;
      case 'system':
        return SYSTEM_PANEL_COUNT;
      case 'peers':
        return PEERS_PANEL_COUNT;
      case 'events':
        return EVENTS_PANEL_COUNT;
      default:
        return 1;
    }
  }

  // ── Frame Renderer ──────────────────────────────────────────────

  // Braille spinner frames (advances every ~100ms via dirty flag)
  private static SPINNER = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];
  private spinnerTick = 0;
  private lastSpinnerMs = 0;

  /** Render the loading splash screen — shown while orchestrator initializes. */
  private renderLoadingScreen(state: TUIState): string {
    const { termWidth, termHeight } = state;
    const now = Date.now();
    // Advance spinner every ~100ms — no setTimeout needed, the render loop drives this
    if (now - this.lastSpinnerMs >= 100) {
      this.spinnerTick++;
      this.lastSpinnerMs = now;
    }
    const frame = App.SPINNER[this.spinnerTick % App.SPINNER.length]!;

    // Boot log lines (last N entries that fit)
    const maxLogLines = Math.min(state.bootLog.length, Math.max(0, termHeight - 14));
    const logSlice = state.bootLog.slice(-maxLogLines);
    const logLines: string[] = [];
    if (logSlice.length > 0) {
      logLines.push('');
      for (const entry of logSlice) {
        const prefix = entry.level === 'error' ? color('✗', ANSI.red)
          : entry.level === 'warn' ? color('!', ANSI.yellow)
          : dim('·');
        // Truncate to fit terminal width with padding
        const maxMsgW = Math.max(20, termWidth - 10);
        const msg = entry.message.length > maxMsgW
          ? entry.message.slice(0, maxMsgW - 1) + '…'
          : entry.message;
        logLines.push(`  ${prefix} ${dim(msg)}`);
      }
    }

    // Build centered content
    const logo = [
      '',
      bold(color('  V I N Y A N', ANSI.cyan)),
      dim('  Epistemic Orchestration'),
      '',
      `  ${color(frame, ANSI.cyan)} ${state.loadingMessage || 'Initializing...'}`,
      ...logLines,
      '',
      dim('  ? Help   q Quit'),
      '',
    ];

    // Center vertically
    const contentH = logo.length;
    const topPad = Math.max(0, Math.floor((termHeight - contentH) / 2));
    const leftPad = Math.max(0, Math.floor((termWidth - 36) / 2));
    const pad = ' '.repeat(leftPad);

    const lines: string[] = [];
    for (let i = 0; i < topPad; i++) lines.push('');
    for (const line of logo) lines.push(pad + line);

    let result = lines.join('\n');

    // Help overlay still works during loading
    if (state.modal?.type === 'help') {
      result += renderHelpOverlay(state);
    }

    return result;
  }

  private renderFrame(state: TUIState): string {
    const { termWidth, termHeight } = state;

    // Terminal size guard
    const sizeGuard = terminalSizeGuard(termWidth, termHeight);
    if (sizeGuard) return sizeGuard;

    // Loading screen — shown while orchestrator initializes
    if (state.loading) {
      return this.renderLoadingScreen(state);
    }

    // Pre-render maintenance
    cleanExpiredToasts(state);
    updateTabBadges(state);

    const lines: string[] = [];

    // Row 1: Header bar — health + counts + clock
    lines.push(headerBar(state, termWidth));
    lines.push('');

    // Row 2: Tab bar with badges
    lines.push(tabBarWithBadges(TABS, state.activeTab, state.tabBadges, termWidth));

    // Row 3+: View content (left/right split handled by each view)
    let viewContent: string;
    switch (state.activeTab) {
      case 'tasks':
        viewContent = renderTasks(state);
        break;
      case 'system':
        viewContent = renderSystem(state);
        break;
      case 'peers':
        viewContent = renderPeers(state);
        break;
      case 'events':
        viewContent = renderEvents(state);
        break;
    }
    lines.push(viewContent);

    // Row N-1: Notification bar — only rendered when there's an active toast or pending notification
    const notif = notificationBar(state, termWidth);
    if (notif) lines.push(notif);

    // Row N: Context hints — dynamic keybinding hints (+ command buffer in command/filter mode)
    const hints = getContextHints(state);
    lines.push(contextHintsBar(state.inputMode, hints, termWidth, state.commandBuffer));

    let frame = lines.join('\n');

    // Overlay modals on top
    if (state.modal?.type === 'approval') {
      frame += renderApprovalModal(state);
    } else if (state.modal?.type === 'confirm-quit') {
      frame += renderConfirmQuit(state);
    } else if (state.modal?.type === 'confirm-cancel') {
      frame += renderConfirmCancel(state);
    } else if (state.modal?.type === 'help') {
      frame += renderHelpOverlay(state);
    }

    return frame;
  }
}
