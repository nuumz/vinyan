/**
 * TUI App — main interactive application loop.
 *
 * Wires together: Screen (rendering), Input (keyboard), DataSource (events),
 * and Views (dashboard, tasks, peers) into a cohesive interactive terminal UI.
 */

import type { DataSource } from './data/source.ts';
import { getContextHints } from './hints.ts';
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
        }
        break;

      case 'peers':
        if (this.state.focusedPanel === 0) {
          const peers = [...this.state.peers.keys()];
          const currentIdx = this.state.selectedPeerId ? peers.indexOf(this.state.selectedPeerId) : -1;
          const newIdx = Math.max(0, Math.min(peers.length - 1, currentIdx + delta));
          selectPeer(this.state, peers[newIdx] ?? null);
        }
        break;

      case 'events': {
        const log = this.state.eventLog;
        if (log.length === 0) break;
        const currentIdx = this.state.selectedEventId
          ? log.findIndex((e) => e.id === this.state.selectedEventId)
          : -1;
        const newIdx = Math.max(0, Math.min(log.length - 1, currentIdx + delta));
        selectEvent(this.state, log[newIdx]?.id ?? null);
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
          }
        }
        break;

      case 'events':
        // Selection toggles detail pane — already handled by selectedEventId
        // If no event selected, select first
        if (!this.state.selectedEventId && this.state.eventLog.length > 0) {
          selectEvent(this.state, this.state.eventLog[0]!.id);
        }
        break;

      case 'peers':
        // Peers detail pane already shows selected peer info
        if (!this.state.selectedPeerId) {
          const firstPeer = [...this.state.peers.keys()][0];
          if (firstPeer) selectPeer(this.state, firstPeer);
        }
        break;
    }
  }

  private handlePageScroll(direction: 'up' | 'down'): void {
    const delta = Math.floor(this.state.termHeight / 2);
    const applyScroll = (key: 'eventLogScroll' | 'taskListScroll' | 'peerListScroll') => {
      const current = this.state[key];
      this.state[key] = direction === 'down' ? current + delta : Math.max(0, current - delta);
      this.state.dirty = true;
    };

    switch (this.state.activeTab) {
      case 'events':
        applyScroll('eventLogScroll');
        break;
      case 'tasks':
        applyScroll('taskListScroll');
        break;
      case 'peers':
        applyScroll('peerListScroll');
        break;
    }
  }

  private handleJump(target: 'top' | 'bottom'): void {
    switch (this.state.activeTab) {
      case 'events':
        this.state.eventLogScroll = target === 'top' ? 0 : Math.max(0, this.state.eventLog.length - 1);
        this.state.dirty = true;
        break;
      case 'tasks': {
        this.state.taskListScroll = target === 'top' ? 0 : Math.max(0, this.state.tasks.size - 1);
        this.state.dirty = true;
        break;
      }
      case 'peers': {
        this.state.peerListScroll = target === 'top' ? 0 : Math.max(0, this.state.peers.size - 1);
        this.state.dirty = true;
        break;
      }
    }
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
          pushToast(this.state, `Set ${key}=${value}`, 'info');
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

    // Row N-1: Notification bar — pending actions / toast feedback
    lines.push(notificationBar(state, termWidth));

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
