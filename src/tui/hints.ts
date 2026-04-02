/**
 * Context-sensitive keybinding hint engine.
 *
 * Returns an array of {key, label} pairs based on current TUI state
 * (active tab, input mode, selected item, notifications).
 * Used by contextHintsBar() in renderer.ts.
 */

import type { TUIState } from './types.ts';

export interface HintEntry {
  key: string;
  label: string;
}

export function getContextHints(state: TUIState): HintEntry[] {
  // Command / filter mode — minimal hints
  if (state.inputMode === 'command') {
    return [
      { key: 'Enter', label: 'execute' },
      { key: 'Esc', label: 'cancel' },
    ];
  }
  if (state.inputMode === 'filter') {
    return [
      { key: 'Enter', label: 'apply' },
      { key: 'Esc', label: 'cancel' },
    ];
  }

  // Normal mode — build contextually
  const hints: HintEntry[] = [{ key: 'j/k', label: 'nav' }];

  // Context-sensitive action keys
  const selectedTask = state.selectedTaskId ? state.tasks.get(state.selectedTaskId) : null;
  const hasApprovalNotification = state.notifications.some((n) => n.type === 'approval' && !n.dismissed);

  if (selectedTask?.status === 'approval_required' || hasApprovalNotification) {
    hints.push({ key: 'a', label: 'approve' }, { key: 'r', label: 'reject' });
  }

  if (selectedTask?.status === 'running') {
    hints.push({ key: 'c', label: 'cancel' });
  }

  hints.push({ key: 'Enter', label: state.activeTab === 'events' ? 'detail' : 'select' });

  // Tab-specific hints
  if (state.activeTab === 'tasks') {
    hints.push({ key: 'n', label: 'new' });
  }

  if (state.activeTab === 'events') {
    hints.push({ key: 'g/G', label: 'top/bottom' }, { key: 'Ctrl+d/u', label: 'page' });
  }

  // Sorting (tasks/peers tabs)
  if (state.activeTab === 'tasks' || state.activeTab === 'peers') {
    hints.push({ key: 's', label: 'sort' });
  }

  // Notification hints
  if (state.notifications.length > 0) {
    hints.push({ key: 'Space', label: 'notification' });
  }
  if (state.notifications.length > 1) {
    hints.push({ key: '[/]', label: 'cycle' });
  }

  // Always-available
  hints.push({ key: ':', label: 'cmd' }, { key: '/', label: 'filter' }, { key: '?', label: 'help' });

  return hints;
}
