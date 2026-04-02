/**
 * TUI App — main interactive application loop.
 *
 * Wires together: Screen (rendering), Input (keyboard), DataSource (events),
 * and Views (dashboard, tasks, peers) into a cohesive interactive terminal UI.
 */

import type { DataSource } from './data/source.ts';
import { parseCommand, routeKeypress, startKeyListener, type TUIAction } from './input.ts';
import { ANSI, bold, color, dim, padEnd, statusBar, tabBar } from './renderer.ts';
import { Screen, type ViewRenderer } from './screen.ts';
import {
  closeModal,
  cycleFocus,
  exitInputMode,
  openModal,
  scrollList,
  selectPeer,
  selectTask,
  switchTab,
} from './state.ts';
import type { TUIState, ViewTab } from './types.ts';
import { renderApprovalModal, renderConfirmQuit } from './views/approval-modal.ts';
import { DASHBOARD_PANEL_COUNT, renderDashboard } from './views/dashboard.ts';
import { renderHelpOverlay } from './views/help.ts';
import { PEERS_PANEL_COUNT, renderPeers } from './views/peers.ts';
import { renderTasks, TASKS_PANEL_COUNT } from './views/tasks.ts';

export interface AppConfig {
  state: TUIState;
  dataSource: DataSource;
}

const TABS: Array<{ key: string; label: string; tab: ViewTab }> = [
  { key: '1', label: 'Dashboard', tab: 'dashboard' },
  { key: '2', label: 'Tasks', tab: 'tasks' },
  { key: '3', label: 'Peers', tab: 'peers' },
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
        break;

      case 'reject':
        this.dataSource.rejectTask(action.taskId);
        closeModal(this.state);
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

      case 'noop':
        break;
    }
  }

  private handleNavigation(direction: 'up' | 'down'): void {
    const delta = direction === 'down' ? 1 : -1;

    switch (this.state.activeTab) {
      case 'dashboard':
        if (this.state.focusedPanel === 3) {
          // Event log panel — scroll
          scrollList(this.state, 'eventLog', delta);
        }
        break;

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
    }
  }

  private handleSelect(): void {
    // If there's a pending approval on the selected task, open modal
    if (this.state.activeTab === 'tasks' && this.state.selectedTaskId) {
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
  }

  private handleCommand(input: string): void {
    const cmd = parseCommand(input);
    switch (cmd.name) {
      case 'run': {
        const goal = cmd.args[0] ?? cmd.rawArg;
        if (goal) {
          this.dataSource.submitTask({
            id: `task-${Date.now().toString(36)}`,
            source: 'cli',
            goal,
            budget: { maxTokens: 10_000, maxDurationMs: 60_000, maxRetries: 3 },
          });
          switchTab(this.state, 'tasks');
        }
        break;
      }

      case 'approve':
        if (cmd.args[0]) {
          this.dataSource.approveTask(cmd.args[0]);
        }
        break;

      case 'reject':
        if (cmd.args[0]) {
          this.dataSource.rejectTask(cmd.args[0]);
        }
        break;

      case 'filter':
        this.state.filterQuery = cmd.rawArg;
        this.state.dirty = true;
        break;

      case 'clear':
        this.state.filterQuery = '';
        this.state.dirty = true;
        break;
    }
  }

  private getMaxPanels(): number {
    switch (this.state.activeTab) {
      case 'dashboard':
        return DASHBOARD_PANEL_COUNT;
      case 'tasks':
        return TASKS_PANEL_COUNT;
      case 'peers':
        return PEERS_PANEL_COUNT;
    }
  }

  // ── Frame Renderer ──────────────────────────────────────────────

  private renderFrame(state: TUIState): string {
    const { termWidth, termHeight } = state;
    const lines: string[] = [];

    // Tab bar (row 1)
    const activeTabIdx = TABS.findIndex((t) => t.tab === state.activeTab);
    lines.push(tabBar(TABS, activeTabIdx, termWidth));

    // View content (rows 2 to termHeight-2)
    let viewContent: string;
    switch (state.activeTab) {
      case 'dashboard':
        viewContent = renderDashboard(state);
        break;
      case 'tasks':
        viewContent = renderTasks(state);
        break;
      case 'peers':
        viewContent = renderPeers(state);
        break;
    }
    lines.push(viewContent);

    // Status bar (last row)
    const leftStatus = this.renderStatusLeft(state);
    const rightStatus = this.renderStatusRight(state);
    lines.push(statusBar(leftStatus, rightStatus, termWidth));

    let frame = lines.join('\n');

    // Overlay modals on top
    if (state.modal?.type === 'approval') {
      frame += renderApprovalModal(state);
    } else if (state.modal?.type === 'confirm-quit') {
      frame += renderConfirmQuit(state);
    } else if (state.modal?.type === 'help') {
      frame += renderHelpOverlay(state);
    }

    return frame;
  }

  private renderStatusLeft(state: TUIState): string {
    if (state.inputMode === 'command') {
      return ` :${state.commandBuffer}█`;
    }
    if (state.inputMode === 'filter') {
      return ` /${state.commandBuffer}█`;
    }

    // Count pending approvals
    const pending = [...state.tasks.values()].filter((t) => t.pendingApproval).length;
    const pendingBadge = pending > 0 ? color(` [${pending} pending] `, ANSI.bold, ANSI.yellow) : '';

    return ` Vinyan TUI${pendingBadge}`;
  }

  private renderStatusRight(state: TUIState): string {
    const taskCount = state.tasks.size;
    const running = [...state.tasks.values()].filter((t) => t.status === 'running').length;
    const peerCount = state.peers.size;

    return `Tasks: ${running}/${taskCount}  Peers: ${peerCount}  [?] help  [q] quit `;
  }
}
