/**
 * TUI Session Persistence — saves/restores user preferences across TUI restarts.
 *
 * Persisted: activeTab, sort config, eventLogMaxSize, filterQuery.
 * NOT persisted: tasks, events, peers (live runtime state).
 *
 * File: <workspace>/.vinyan/tui-session.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SortConfig, TUIState, ViewTab } from './types.ts';

/** Shape of the persisted session file. */
interface TUISession {
  activeTab: ViewTab;
  sort: Partial<Record<ViewTab, SortConfig>>;
  eventLogMaxSize: number;
  filterQuery: string;
  tabFilters: Partial<Record<ViewTab, string>>;
}

const VALID_TABS: ReadonlySet<string> = new Set(['tasks', 'system', 'peers', 'events']);

function sessionPath(workspace: string): string {
  return join(workspace, '.vinyan', 'tui-session.json');
}

/** Restore session preferences into TUI state. Returns true if restored. */
export function restoreSession(state: TUIState, workspace: string): boolean {
  const path = sessionPath(workspace);
  if (!existsSync(path)) return false;

  try {
    const raw = readFileSync(path, 'utf-8');
    const data = JSON.parse(raw) as Partial<TUISession>;

    if (typeof data.activeTab === 'string' && VALID_TABS.has(data.activeTab)) {
      state.activeTab = data.activeTab;
    }
    if (data.sort && typeof data.sort === 'object') {
      state.sort = data.sort;
    }
    if (typeof data.eventLogMaxSize === 'number' && data.eventLogMaxSize > 0) {
      state.eventLogMaxSize = data.eventLogMaxSize;
    }
    if (typeof data.filterQuery === 'string') {
      state.filterQuery = data.filterQuery;
    }
    if (data.tabFilters && typeof data.tabFilters === 'object') {
      state.tabFilters = data.tabFilters as Partial<Record<ViewTab, string>>;
      // Restore the active tab's filter
      state.filterQuery = state.tabFilters[state.activeTab] ?? state.filterQuery;
    }
    return true;
  } catch {
    // Corrupted file — ignore and start fresh
    return false;
  }
}

/** Save current session preferences to disk. Best-effort, never throws. */
export function saveSession(state: TUIState, workspace: string): void {
  const path = sessionPath(workspace);
  // Sync current tab's filter before saving
  const tabFilters = { ...state.tabFilters, [state.activeTab]: state.filterQuery };
  const data: TUISession = {
    activeTab: state.activeTab,
    sort: state.sort,
    eventLogMaxSize: state.eventLogMaxSize,
    filterQuery: state.filterQuery,
    tabFilters,
  };

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  } catch {
    // Best-effort — disk full, read-only fs, etc.
  }
}
