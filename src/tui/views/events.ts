/**
 * Events View — Tab 4: Full-screen event browsing with payload inspection.
 * Left pane: event log list. Right pane: selected event detail with JSON payload.
 */

import { ANSI, bold, color, dim, formatTimeShort, padEnd, panel, sideBySide, truncate } from '../renderer.ts';
import type { TUIState } from '../types.ts';

export const EVENTS_PANEL_COUNT = 2;

export function renderEvents(state: TUIState): string {
  const { termWidth, termHeight } = state;
  const leftWidth = Math.floor(termWidth * 0.55);
  const rightWidth = termWidth - leftWidth - 1;
  const panelHeight = termHeight - 4; // header + tab bar + notification + hints

  const listPanel = renderEventList(state, leftWidth, panelHeight, state.focusedPanel === 0);
  const detailPanel = renderEventDetail(state, rightWidth, panelHeight, state.focusedPanel === 1);

  return sideBySide(listPanel, detailPanel);
}

// ── Event List (Left) ───────────────────────────────────────────────

function renderEventList(state: TUIState, width: number, height: number, focused: boolean): string {
  const visibleRows = height - 3;
  const events = state.filterQuery
    ? state.eventLog.filter((e) => e.domain.includes(state.filterQuery) || e.event.includes(state.filterQuery))
    : state.eventLog;

  const startIdx = Math.max(0, events.length - visibleRows - state.eventLogScroll);
  const slice = events.slice(startIdx, startIdx + visibleRows);

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

  if (events.length > visibleRows) {
    const remaining = events.length - startIdx - visibleRows;
    if (remaining > 0) {
      lines[lines.length - 1] = dim(`  ▼ ${remaining} more events`);
    }
  }

  const title = state.filterQuery
    ? `Events [/${state.filterQuery}] (${events.length})`
    : `Events (${events.length})`;

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

  // Payload
  lines.push(bold('Payload:'));
  if (entry.payload) {
    try {
      const formatted = JSON.stringify(entry.payload, null, 2);
      const payloadLines = formatted.split('\n');
      const maxPayloadRows = height - 10;
      for (let i = 0; i < Math.min(payloadLines.length, maxPayloadRows); i++) {
        lines.push(truncate(dim(payloadLines[i]!), innerW));
      }
      if (payloadLines.length > maxPayloadRows) {
        lines.push(dim(`  ... ${payloadLines.length - maxPayloadRows} more lines`));
      }
    } catch {
      lines.push(dim('  (unable to format payload)'));
    }
  } else {
    lines.push(dim('  (no payload)'));
  }

  return panel(`Event #${selectedId}`, lines.join('\n'), width, height, focused);
}
