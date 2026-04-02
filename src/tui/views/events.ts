/**
 * Events View — Tab 4: Full-screen event browsing with payload inspection.
 * Left pane: event log list. Right pane: selected event detail with JSON payload.
 */

import { ANSI, bold, color, dim, formatTimeShort, padEnd, panel, sideBySide, truncate } from '../renderer.ts';
import type { EventLogEntry, EventSortField, SortConfig, TUIState } from '../types.ts';

export const EVENTS_PANEL_COUNT = 2;

export function renderEvents(state: TUIState): string {
  const { termWidth, termHeight } = state;
  const leftWidth = Math.floor(termWidth * 0.55);
  const rightWidth = termWidth - leftWidth - 1;
  const panelHeight = termHeight - 4; // header + spacing (1/2) + tab bar + hints

  const sorted = getCachedSortedEvents(state.eventLog, state.sort.events as SortConfig<EventSortField> | undefined);
  const listPanel = renderEventList(state, sorted, leftWidth, panelHeight, state.focusedPanel === 0);
  const detailPanel = renderEventDetail(state, rightWidth, panelHeight, state.focusedPanel === 1);

  return sideBySide(listPanel, detailPanel);
}

// ── Sort ────────────────────────────────────────────────────────────

function sortEvents(events: EventLogEntry[], sort?: SortConfig<EventSortField>): EventLogEntry[] {
  if (!sort) return events;
  const dir = sort.direction === 'asc' ? 1 : -1;
  return [...events].sort((a, b) => {
    switch (sort.field) {
      case 'domain':
        return dir * a.domain.localeCompare(b.domain);
      case 'timestamp':
      default:
        return dir * (a.timestamp - b.timestamp);
    }
  });
}

// ── Memoization Cache ────────────────────────────────────────────────

let _sortCache: {
  length: number;
  sortField: string | undefined;
  sortDir: string | undefined;
  result: EventLogEntry[];
} | null = null;

function getCachedSortedEvents(events: EventLogEntry[], sort?: SortConfig<EventSortField>): EventLogEntry[] {
  const field = sort?.field;
  const dir = sort?.direction;

  if (
    _sortCache &&
    _sortCache.length === events.length &&
    _sortCache.sortField === field &&
    _sortCache.sortDir === dir &&
    // Safety: never return empty cache when events exist
    (_sortCache.result.length > 0 || events.length === 0)
  ) {
    return _sortCache.result;
  }

  const result = sortEvents(events, sort);
  _sortCache = { length: events.length, sortField: field, sortDir: dir, result };
  return result;
}

let _filterCache: {
  sourceLength: number;
  sortField: string;
  sortDir: string;
  filterQuery: string;
  result: EventLogEntry[];
} | null = null;

function getCachedFilteredEvents(
  events: EventLogEntry[],
  filterQuery: string,
  sortField: string,
  sortDir: string,
): EventLogEntry[] {
  if (
    _filterCache &&
    _filterCache.sourceLength === events.length &&
    _filterCache.sortField === sortField &&
    _filterCache.sortDir === sortDir &&
    _filterCache.filterQuery === filterQuery &&
    // Safety: never return empty cache when source has events
    (_filterCache.result.length > 0 || events.length === 0 || filterQuery !== '')
  ) {
    return _filterCache.result;
  }

  const result = filterQuery
    ? events.filter((e) => e.domain.includes(filterQuery) || e.event.includes(filterQuery))
    : events;
  _filterCache = { sourceLength: events.length, sortField, sortDir, filterQuery, result };
  return result;
}

// ── Event List (Left) ───────────────────────────────────────────────

function renderEventList(state: TUIState, events: EventLogEntry[], width: number, height: number, focused: boolean): string {
  const visibleRows = height - 3;
  const sortConfig = state.sort.events;
  const filtered = getCachedFilteredEvents(events, state.filterQuery, sortConfig?.field ?? '', sortConfig?.direction ?? '');

  const startIdx = Math.max(0, filtered.length - visibleRows - state.eventLogScroll);
  const slice = filtered.slice(startIdx, startIdx + visibleRows);

  const innerW = width - 2;
  const lines: string[] = [];

  for (let i = 0; i < slice.length; i++) {
    const entry = slice[i]!;
    const selected = entry.id === state.selectedEventId;
    const prefix = selected ? color('▸', ANSI.cyan) : ' ';
    const ts = dim(formatTimeShort(entry.timestamp));
    const domain = color(padEnd(entry.domain, 7), entry.colorCode);
    const summary = entry.summary;
    const line = `${prefix}${ts} ${entry.icon} ${domain} ${summary}`;
    lines.push(truncate(line, innerW));
  }

  while (lines.length < visibleRows) lines.push('');

  if (filtered.length > visibleRows) {
    const remaining = filtered.length - startIdx - visibleRows;
    if (remaining > 0) {
      lines[lines.length - 1] = dim(`  ▼ ${remaining} more events`);
    }
  }

  const title = state.filterQuery
    ? `Events [/${state.filterQuery}] (${filtered.length})`
    : `Events (${filtered.length})`;

  return panel(title, lines.join('\n'), width, height, focused);
}

// ── Event Detail (Right) ────────────────────────────────────────────

function renderEventDetail(state: TUIState, width: number, height: number, focused: boolean): string {
  const selectedId = state.selectedEventId;
  if (selectedId == null) {
    return panel('Event Detail', dim('Select an event to view details.'), width, height, focused);
  }

  const entry = state.eventLog.find((e) => e.id === selectedId);
  if (!entry) {
    return panel('Event Detail', dim('Event not found.'), width, height, focused);
  }

  const lines: string[] = [];
  const innerW = width - 4;

  lines.push(`${bold('Event:')} ${entry.event}`);
  lines.push(`${bold('Time:')}  ${formatTimeShort(entry.timestamp)}`);
  lines.push(`${bold('Domain:')} ${entry.domain}`);
  lines.push('');

  // Structured detail for known event types
  const detail = formatEventDetail(entry, innerW);
  if (detail.length > 0) {
    for (const line of detail) {
      lines.push(truncate(line, innerW));
    }
    lines.push('');
  }

  // Payload — build all lines (scrollable)
  lines.push(bold('Payload:'));
  if (entry.payload) {
    try {
      const formatted = JSON.stringify(entry.payload, null, 2);
      for (const pl of formatted.split('\n')) {
        lines.push(truncate(dim(pl), innerW));
      }
    } catch {
      lines.push(dim('  (unable to format payload)'));
    }
  } else {
    lines.push(dim('  (no payload)'));
  }

  // Apply scroll window
  const visibleRows = height - 3; // panel border + title
  const scrollOffset = Math.min(state.eventDetailScroll, Math.max(0, lines.length - visibleRows));
  const visible = lines.slice(scrollOffset, scrollOffset + visibleRows);

  // Scroll indicator
  const hasMore = lines.length > visibleRows;
  const scrollHint = hasMore
    ? dim(` [${scrollOffset + 1}-${Math.min(scrollOffset + visibleRows, lines.length)}/${lines.length}]`)
    : '';

  return panel(`Event #${selectedId}${scrollHint}`, visible.join('\n'), width, height, focused);
}

// ── Structured Detail Extraction ────────────────────────────────────

function formatEventDetail(entry: EventLogEntry, _maxW: number): string[] {
  const p = entry.payload as Record<string, unknown> | undefined;
  if (!p) return [];

  const lines: string[] = [];
  const kv = (label: string, value: unknown) => {
    if (value == null || value === '' || value === 'none') return;
    const s = typeof value === 'number' ? (Number.isNaN(value) ? '—' : String(value)) : String(value);
    lines.push(`${bold(label + ':')} ${s}`);
  };

  switch (entry.event) {
    case 'task:start': {
      const input = p.input as Record<string, unknown> | undefined;
      const routing = p.routing as Record<string, unknown> | undefined;
      kv('Task', input?.id);
      kv('Goal', input?.goal);
      kv('Source', input?.source);
      kv('Level', routing?.level);
      kv('Model', routing?.model);
      const budget = input?.budget as Record<string, unknown> | undefined;
      if (budget) {
        kv('Token Budget', budget.maxTokens);
        kv('Time Budget', `${budget.maxDurationMs}ms`);
      }
      break;
    }
    case 'task:complete': {
      const result = p.result as Record<string, unknown> | undefined;
      const trace = result?.trace as Record<string, unknown> | undefined;
      kv('Task', result?.id);
      kv('Status', result?.status);
      const qs = result?.qualityScore as Record<string, unknown> | undefined;
      const composite = typeof qs === 'object' && qs !== null ? qs.composite : qs;
      const qNum = typeof composite === 'number' && !Number.isNaN(composite) ? composite : null;
      if (qNum != null) kv('Quality', qNum.toFixed(2));
      kv('Worker', trace?.workerId);
      kv('Model', trace?.modelUsed);
      kv('Tokens', trace?.tokensConsumed);
      kv('Level', trace?.routingLevel);
      kv('Signature', trace?.taskTypeSignature);
      break;
    }
    case 'task:escalate':
      kv('From Level', p.fromLevel);
      kv('To Level', p.toLevel);
      kv('Reason', p.reason);
      break;
    case 'task:approval_required':
      kv('Task', p.taskId);
      kv('Risk Score', p.riskScore);
      kv('Reason', p.reason);
      break;
    case 'oracle:verdict': {
      const v = p.verdict as Record<string, unknown> | undefined;
      kv('Oracle', p.oracleName);
      kv('Verified', v?.verified);
      kv('Confidence', v?.confidence);
      if (v?.reason) kv('Reason', v.reason);
      break;
    }
    case 'worker:error':
      kv('Worker', p.workerId);
      kv('Error', p.error);
      break;
    case 'peer:connected':
      kv('Peer', p.peerId);
      kv('URL', p.url);
      break;
    case 'sleep:cycleComplete':
      kv('Patterns', p.patternsFound);
      kv('Rules', p.rulesGenerated);
      kv('Skills', p.skillsCreated);
      break;
    default:
      // No structured extraction — raw payload shown below
      break;
  }

  return lines;
}
