/**
 * Dashboard View — Tab 1: System overview with 4 panels.
 *
 * Layout:
 *   ┌─ System Health ──┐ ┌─ Pipeline / Metrics ──┐
 *   │                   │ │                        │
 *   └───────────────────┘ └────────────────────────┘
 *   ┌─ Fleet & Evolution ┐ ┌─ Event Log ───────────┐
 *   │                     │ │                        │
 *   └─────────────────────┘ └────────────────────────┘
 */

import {
  ANSI,
  bold,
  color,
  dim,
  formatDuration,
  formatTimeShort,
  gateDot,
  gauge,
  panel,
  sideBySide,
  sparkline,
  truncate,
} from '../renderer.ts';
import type { TUIState } from '../types.ts';

export function renderDashboard(state: TUIState): string {
  const { termWidth } = state;
  const leftWidth = Math.floor(termWidth * 0.42);
  const rightWidth = termWidth - leftWidth - 1;
  const panelHeight = Math.floor((state.termHeight - 4) / 2); // -4 for tab bar + status bar

  const healthPanel = renderHealthPanel(state, leftWidth, panelHeight, state.focusedPanel === 0);
  const metricsPanel = renderMetricsPanel(state, rightWidth, panelHeight, state.focusedPanel === 1);
  const fleetPanel = renderFleetPanel(state, leftWidth, panelHeight, state.focusedPanel === 2);
  const eventPanel = renderEventLogPanel(state, rightWidth, panelHeight, state.focusedPanel === 3);

  const topRow = sideBySide(healthPanel, metricsPanel);
  const bottomRow = sideBySide(fleetPanel, eventPanel);

  return `${topRow}\n${bottomRow}`;
}

export const DASHBOARD_PANEL_COUNT = 4;

// ── System Health Panel ─────────────────────────────────────────────

function renderHealthPanel(state: TUIState, width: number, height: number, focused: boolean): string {
  const lines: string[] = [];
  const h = state.health;
  const uptime = Date.now() - state.startedAt;

  // Status line
  const statusText = h?.status ?? 'unknown';
  const statusColor = statusText === 'healthy' ? ANSI.green : statusText === 'degraded' ? ANSI.yellow : ANSI.red;
  lines.push(`Status: ${color(statusText.toUpperCase(), ANSI.bold, statusColor)}  Uptime: ${formatDuration(uptime)}`);
  lines.push('');

  // Database
  const dbSize = h?.checks.database.sizeMB;
  const dbOk = h?.checks.database.ok ?? true;
  lines.push(`DB: ${dbOk ? (dbSize != null ? `${dbSize.toFixed(1)} MB` : 'OK') : color('ERROR', ANSI.red)}`);

  // Shadow queue
  const sqDepth = h?.checks.shadowQueue.depth ?? 0;
  const sqOk = h?.checks.shadowQueue.ok ?? true;
  lines.push(`Shadow Queue: ${sqOk ? String(sqDepth) : color(String(sqDepth), ANSI.yellow)}`);

  // Circuit breakers
  const cbOpen = h?.checks.circuitBreakers.openCount ?? 0;
  lines.push(`Circuit Breakers: ${cbOpen === 0 ? dim('0 open') : color(`${cbOpen} open`, ANSI.red)}`);
  lines.push('');

  // Data gates
  const dg = state.metrics?.dataGates;
  lines.push(bold('Data Gates:'));
  lines.push(` ${gateDot(dg?.sleepCycle ?? false, 'Sleep Cycle')}`);
  lines.push(` ${gateDot(dg?.skillFormation ?? false, 'Skill Formation')}`);
  lines.push(` ${gateDot(dg?.evolutionEngine ?? false, 'Evolution Engine')}`);
  lines.push(` ${gateDot(dg?.fleetRouting ?? false, 'Fleet Routing')}`);

  return panel('System Health', lines.join('\n'), width, height, focused);
}

// ── Metrics Panel ───────────────────────────────────────────────────

function renderMetricsPanel(state: TUIState, width: number, height: number, focused: boolean): string {
  const lines: string[] = [];
  const m = state.metrics;

  if (!m) {
    lines.push(dim('No metrics available yet.'));
    lines.push(dim('Waiting for first task...'));
    return panel('Traces & Quality', lines.join('\n'), width, height, focused);
  }

  const innerW = width - 4;
  const barW = Math.max(10, innerW - 25);

  lines.push(`Traces: ${bold(String(m.traces.total))}  Task Types: ${m.traces.distinctTaskTypes}`);
  lines.push(`Success: ${gauge(m.traces.successRate, barW, `${(m.traces.successRate * 100).toFixed(0)}%`)}`);
  if (state.successHistory.length > 1) {
    lines.push(`History: ${sparkline(state.successHistory, Math.min(barW, state.successHistory.length))}`);
  }
  lines.push(`Quality: ${gauge(m.traces.avgQualityComposite, barW, m.traces.avgQualityComposite.toFixed(2))}`);
  lines.push('');

  // Routing distribution
  lines.push(bold('Routing Distribution:'));
  const dist = m.traces.routingDistribution;
  const total = Object.values(dist).reduce((a, b) => a + b, 0) || 1;
  for (let level = 0; level <= 3; level++) {
    const count = dist[level] ?? 0;
    const pct = count / total;
    lines.push(` L${level}: ${gauge(pct, Math.max(5, barW - 8))} ${count}`);
  }
  lines.push('');

  // Workers summary
  lines.push(
    `Workers: ${color(String(m.workers.active), ANSI.green)} active` +
      `  ${color(String(m.workers.probation), ANSI.yellow)} probation` +
      `  ${color(String(m.workers.demoted), ANSI.red)} demoted`,
  );

  return panel('Traces & Quality', lines.join('\n'), width, height, focused);
}

// ── Fleet & Evolution Panel ─────────────────────────────────────────

function renderFleetPanel(state: TUIState, width: number, height: number, focused: boolean): string {
  const lines: string[] = [];
  const m = state.metrics;

  if (!m) {
    lines.push(dim('Waiting for data...'));
    return panel('Fleet & Evolution', lines.join('\n'), width, height, focused);
  }

  lines.push(bold('Rules:'));
  lines.push(
    ` ${color(String(m.rules.active), ANSI.green)} active` +
      `  ${color(String(m.rules.probation), ANSI.yellow)} probation` +
      `  ${dim(`${String(m.rules.retired)} retired`)}`,
  );

  lines.push(bold('Skills:'));
  lines.push(
    ` ${color(String(m.skills.active), ANSI.green)} active` +
      `  ${color(String(m.skills.probation), ANSI.yellow)} probation` +
      `  ${dim(`${String(m.skills.demoted)} demoted`)}`,
  );
  lines.push('');

  lines.push(`Patterns: ${bold(String(m.patterns.total))}  Sleep Cycles: ${m.patterns.sleepCyclesRun}`);
  lines.push('');

  // Evolution metrics summary
  if (m.evolution) {
    const evo = m.evolution;
    lines.push(
      `Rules: ${bold(String(evo.evolutionEngine.rulesActive))} active / ${evo.evolutionEngine.rulesTotal} total`,
    );
    lines.push(`Quality: ${evo.overall.qualityTrend.toFixed(2)}  Routing: ${evo.overall.routingEfficiency.toFixed(2)}`);
  }

  return panel('Fleet & Evolution', lines.join('\n'), width, height, focused);
}

// ── Event Log Panel ─────────────────────────────────────────────────

function renderEventLogPanel(state: TUIState, width: number, height: number, focused: boolean): string {
  const visibleRows = height - 3; // panel border + title
  const events = state.filterQuery
    ? state.eventLog.filter((e) => e.domain.includes(state.filterQuery) || e.event.includes(state.filterQuery))
    : state.eventLog;

  const startIdx = Math.max(0, events.length - visibleRows - state.eventLogScroll);
  const slice = events.slice(startIdx, startIdx + visibleRows);

  const innerW = width - 2;
  const lines: string[] = [];
  for (const entry of slice) {
    const ts = dim(formatTimeShort(entry.timestamp));
    const domain = color(entry.domain.padEnd(7), entry.colorCode);
    const summary = entry.summary;
    const line = `${ts} ${entry.icon} ${domain} ${summary}`;
    lines.push(truncate(line, innerW));
  }

  // Pad remaining rows
  while (lines.length < visibleRows) {
    lines.push('');
  }

  // Footer with event count
  if (events.length > visibleRows) {
    const remaining = events.length - startIdx - visibleRows;
    if (remaining > 0) {
      lines[lines.length - 1] = dim(`  ▼ ${remaining} more events`);
    }
  }

  const title = state.filterQuery ? `Event Log [/${state.filterQuery}]` : `Event Log (${events.length})`;

  return panel(title, lines.join('\n'), width, height, focused);
}
