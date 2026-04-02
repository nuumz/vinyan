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
  contextHintsBar,
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
  dataSource: DataSource;
}

const TABS: Array<{ key: string; label: string; tab: ViewTab }> = [
  { key: '1', label: 'Tasks', tab: 'tasks' },
  { key: '2', label: 'System', tab: 'system' },
  { key: '3', label: 'Peers', tab: 'peers' },
  { key: '4', label: 'Events', tab: 'events' },
];

export class App {
  private state: TUIState;
  private dataSource: DataSource;
  private screen: Screen;
  private stopKeyListener: (() => void) | null = null;
  private running = false;

  constructor(config: AppConfig) {
    this.state = config.state;
    this.dataSource = config.dataSource;

    const viewRenderer: ViewRenderer = (s) => this.renderFrame(s);
    this.screen = new Screen(this.state, viewRenderer);
  }

  /** Start the interactive TUI. Returns when the user quits. */
  async run(): Promise<void> {
    this.running = true;

    // Start data source
    this.dataSource.start();

    // Start rendering
    this.screen.start();

    // Start keyboard input
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
    saveSession(this.state, this.state.workspace);
    this.stopKeyListener?.();
    this.screen.stop();
    this.dataSource.stop();
  }

  // ── Action Handler ──────────────────────────────────────────────

  private handleAction(action: TUIAction): void {
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
        this.state.dirty = true;
        break;

      case 'approve':
        this.dataSource.approveTask(action.taskId);
        closeModal(this.state);
        // Dismiss matching notification
        const approveNotif = this.state.notifications.find((n) => n.taskId === action.taskId && !n.dismissed);
        if (approveNotif) dismissNotification(this.state, approveNotif.id);
        pushToast(this.state, `✓ Approved ${action.taskId}`, 'success');
        break;

      case 'reject':
        this.dataSource.rejectTask(action.taskId);
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
        this.dataSource.cancelTask(action.taskId);
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

    switch (this.state.activeTab) {
      case 'tasks':
        if (this.state.focusedPanel === 0) {
          // Task list — select next/prev task
          const tasks = [...this.state.tasks.keys()];
          const currentIdx = this.state.selectedTaskId ? tasks.indexOf(this.state.selectedTaskId) : -1;
          const newIdx = Math.max(0, Math.min(tasks.length - 1, currentIdx + delta));
          selectTask(this.state, tasks[newIdx] ?? null);
          this.autoScrollTasks(newIdx);
        }
        break;

      case 'peers':
        if (this.state.focusedPanel === 0) {
          const peers = [...this.state.peers.keys()];
          const currentIdx = this.state.selectedPeerId ? peers.indexOf(this.state.selectedPeerId) : -1;
          const newIdx = Math.max(0, Math.min(peers.length - 1, currentIdx + delta));
          selectPeer(this.state, peers[newIdx] ?? null);
          this.autoScrollPeers(newIdx);
        }
        break;

      case 'events': {
        if (this.state.focusedPanel === 1) {
          // Detail pane scroll
          this.state.eventDetailScroll = Math.max(0, this.state.eventDetailScroll + delta);
          this.state.dirty = true;
          break;
        }
        const log = this.state.eventLog;
        if (log.length === 0) break;
        const currentIdx = this.state.selectedEventId
          ? log.findIndex((e) => e.id === this.state.selectedEventId)
          : -1;
        const newIdx = Math.max(0, Math.min(log.length - 1, currentIdx + delta));
        selectEvent(this.state, log[newIdx]?.id ?? null);
        this.autoScrollEvents(newIdx, log.length);
        break;
      }
    }
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

      case 'events':
        if (!this.state.selectedEventId && this.state.eventLog.length > 0) {
          selectEvent(this.state, this.state.eventLog[0]!.id);
        }
        // Toggle to detail pane
        cycleFocus(this.state, this.getMaxPanels(), 1);
        break;

      case 'peers':
        if (!this.state.selectedPeerId) {
          const firstPeer = [...this.state.peers.keys()][0];
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

    switch (this.state.activeTab) {
      case 'tasks': {
        const tasks = [...this.state.tasks.keys()];
        const maxVisible = Math.max(1, Math.floor((viewH - 3) / 2));
        const currentIdx = this.state.selectedTaskId ? tasks.indexOf(this.state.selectedTaskId) : 0;
        const newIdx = direction === 'down'
          ? Math.min(tasks.length - 1, currentIdx + pageDelta)
          : Math.max(0, currentIdx - pageDelta);
        selectTask(this.state, tasks[newIdx] ?? null);
        this.autoScrollTasks(newIdx);
        break;
      }
      case 'peers': {
        const peers = [...this.state.peers.keys()];
        const currentIdx = this.state.selectedPeerId ? peers.indexOf(this.state.selectedPeerId) : 0;
        const newIdx = direction === 'down'
          ? Math.min(peers.length - 1, currentIdx + pageDelta)
          : Math.max(0, currentIdx - pageDelta);
        selectPeer(this.state, peers[newIdx] ?? null);
        this.autoScrollPeers(newIdx);
        break;
      }
      case 'events': {
        if (this.state.focusedPanel === 1) {
          const delta = direction === 'down' ? pageDelta : -pageDelta;
          this.state.eventDetailScroll = Math.max(0, this.state.eventDetailScroll + delta);
          this.state.dirty = true;
          break;
        }
        const log = this.state.eventLog;
        const currentIdx = this.state.selectedEventId
          ? log.findIndex((e) => e.id === this.state.selectedEventId) : 0;
        const newIdx = direction === 'down'
          ? Math.min(log.length - 1, currentIdx + pageDelta)
          : Math.max(0, currentIdx - pageDelta);
        selectEvent(this.state, log[newIdx]?.id ?? null);
        this.autoScrollEvents(newIdx, log.length);
        break;
      }
    }
  }

  private handleJump(target: 'top' | 'bottom'): void {
    switch (this.state.activeTab) {
      case 'events': {
        const log = this.state.eventLog;
        if (log.length === 0) break;
        const idx = target === 'top' ? 0 : log.length - 1;
        selectEvent(this.state, log[idx]!.id);
        this.autoScrollEvents(idx, log.length);
        break;
      }
      case 'tasks': {
        const tasks = [...this.state.tasks.keys()];
        if (tasks.length === 0) break;
        const idx = target === 'top' ? 0 : tasks.length - 1;
        selectTask(this.state, tasks[idx] ?? null);
        this.autoScrollTasks(idx);
        break;
      }
      case 'peers': {
        const peers = [...this.state.peers.keys()];
        if (peers.length === 0) break;
        const idx = target === 'top' ? 0 : peers.length - 1;
        selectPeer(this.state, peers[idx] ?? null);
        this.autoScrollPeers(idx);
        break;
      }
    }
  }

  // ── Auto-scroll helpers ─────────────────────────────────────────

  /** Keep selected task visible (each task = 2 rows). */
  private autoScrollTasks(idx: number): void {
    const viewH = this.state.termHeight - 4;
    const maxVisible = Math.max(1, Math.floor((viewH - 3) / 2));
    if (idx < this.state.taskListScroll) {
      this.state.taskListScroll = idx;
    } else if (idx >= this.state.taskListScroll + maxVisible) {
      this.state.taskListScroll = idx - maxVisible + 1;
    }
    this.state.dirty = true;
  }

  /** Keep selected peer visible. */
  private autoScrollPeers(idx: number): void {
    const viewH = this.state.termHeight - 4;
    const maxVisible = Math.max(1, viewH - 4); // header + empty rows
    if (idx < this.state.peerListScroll) {
      this.state.peerListScroll = idx;
    } else if (idx >= this.state.peerListScroll + maxVisible) {
      this.state.peerListScroll = idx - maxVisible + 1;
    }
    this.state.dirty = true;
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
          this.dataSource.submitTask({
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
          this.dataSource.approveTask(taskId);
          pushToast(this.state, `Approved ${taskId}`, 'success');
        }
        break;
      }

      case 'reject': {
        const taskId = cmd.args[0] ?? this.getNotificationTargetId();
        if (taskId) {
          this.dataSource.rejectTask(taskId);
          pushToast(this.state, `Rejected ${taskId}`, 'success');
        }
        break;
      }

      case 'cancel': {
        const taskId = cmd.args[0] ?? this.state.selectedTaskId;
        if (taskId) {
          this.dataSource.cancelTask(taskId);
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
        this.state.dirty = true;
        break;

      case 'sleep':
        this.dataSource.triggerSleepCycle();
        break;

      case 'export':
        this.dataSource.exportPatterns(cmd.rawArg || 'vinyan-patterns.json');
        break;

      case 'clear':
        this.state.filterQuery = '';
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

  private renderFrame(state: TUIState): string {
    const { termWidth, termHeight } = state;

    // Terminal size guard
    const sizeGuard = terminalSizeGuard(termWidth, termHeight);
    if (sizeGuard) return sizeGuard;

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
