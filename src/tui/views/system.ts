/**
 * System View — Tab 2: Health (left) + Metrics (right).
 * Replaces the 4-quadrant dashboard with a 2-pane left-right layout.
 */

import {
  ANSI,
  bold,
  color,
  dim,
  formatDuration,
  gateDot,
  gauge,
  padEnd,
  panel,
  sideBySide,
  sparkline,
} from '../renderer.ts';
import type { TUIState } from '../types.ts';

export const SYSTEM_PANEL_COUNT = 2;

export function renderSystem(state: TUIState): string {
  const { termWidth, termHeight } = state;
  const leftWidth = Math.floor(termWidth * 0.55);
  const rightWidth = termWidth - leftWidth - 1;
  const panelHeight = termHeight - 4; // header + tab bar + notification + hints

  const healthPanel = renderHealthPanel(state, leftWidth, panelHeight, state.focusedPanel === 0);
  const metricsPanel = renderMetricsPanel(state, rightWidth, panelHeight, state.focusedPanel === 1);

  return sideBySide(healthPanel, metricsPanel);
}

// ── System Health Panel (Left) ──────────────────────────────────────

function renderHealthPanel(state: TUIState, width: number, height: number, focused: boolean): string {
  const lines: string[] = [];
  const h = state.health;
  const uptime = Date.now() - state.startedAt;

  // Status line
  const statusText = h?.status ?? 'unknown';
  const statusColor = statusText === 'healthy' ? ANSI.green : statusText === 'degraded' ? ANSI.yellow : ANSI.red;
  lines.push(`Status: ${color(statusText.toUpperCase(), ANSI.bold, statusColor)}   Uptime: ${formatDuration(uptime)}`);
  lines.push('');

  // Database
  const dbSize = h?.checks.database.sizeMB;
  const dbOk = h?.checks.database.ok ?? true;
  lines.push(`Database: ${dbOk ? (dbSize != null ? `${dbSize.toFixed(1)} MB ✓` : 'OK ✓') : color('ERROR', ANSI.red)}`);

  // Shadow queue
  const sqDepth = h?.checks.shadowQueue.depth ?? 0;
  const sqOk = h?.checks.shadowQueue.ok ?? true;
  lines.push(`Shadow Queue: ${sqOk ? `${sqDepth} ✓` : color(String(sqDepth), ANSI.yellow)}`);

  // Circuit breakers
  const cbOpen = h?.checks.circuitBreakers.openCount ?? 0;
  lines.push(`Circuit Breakers: ${cbOpen === 0 ? '0 open ✓' : color(`${cbOpen} open`, ANSI.red)}`);
  lines.push('');

  // Data gates
  const dg = state.metrics?.dataGates;
  lines.push(bold('Data Gates:'));
  lines.push(` ${gateDot(dg?.sleepCycle ?? false, 'Sleep Cycle')}`);
  lines.push(` ${gateDot(dg?.skillFormation ?? false, 'Skill Formation')}`);
  lines.push(` ${gateDot(dg?.evolutionEngine ?? false, 'Evolution Engine')}`);
  lines.push(` ${gateDot(dg?.fleetRouting ?? false, 'Fleet Routing')}`);
  lines.push('');

  // Real-time counters
  const counters = state.realtimeCounters;
  if (Object.keys(counters).length > 0) {
    lines.push(bold('Real-time Counters:'));
    for (const [key, value] of Object.entries(counters)) {
      lines.push(` ${padEnd(key, 20)} ${value.toLocaleString()}`);
    }
  }

  return panel('System Health', lines.join('\n'), width, height, focused);
}

// ── Metrics & Fleet Panel (Right) ───────────────────────────────────

function renderMetricsPanel(state: TUIState, width: number, height: number, focused: boolean): string {
  const lines: string[] = [];
  const m = state.metrics;

  if (!m) {
    lines.push(dim('No metrics available yet.'));
    lines.push(dim('Waiting for first task...'));
    return panel('Metrics & Fleet', lines.join('\n'), width, height, focused);
  }

  const innerW = width - 4;
  const barW = Math.max(10, innerW - 25);

  lines.push(`Traces: ${bold(String(m.traces.total))}  Task Types: ${m.traces.distinctTaskTypes}`);
  lines.push(`Success: ${gauge(m.traces.successRate, barW)}`);
  if (state.successHistory.length > 1) {
    lines.push(`History: ${sparkline(state.successHistory, Math.min(barW, state.successHistory.length))}`);
  }
  lines.push(`Quality: ${gauge(m.traces.avgQualityComposite, barW)}`);
  lines.push('');

  // Routing distribution
  lines.push(bold('Routing Distribution:'));
  const dist = m.traces.routingDistribution;
  const total = Object.values(dist).reduce((a, b) => a + b, 0) || 1;
  for (let level = 0; level <= 3; level++) {
    const count = dist[level] ?? 0;
    const pct = count / total;
    lines.push(` L${level} ${gauge(pct, Math.max(5, barW - 8))}  ${count}`);
  }
  lines.push('');

  // Workers/Rules/Skills/Patterns — table layout
  const pad = (v: number, w = 2) => String(v).padStart(w);
  const statRow = (label: string, cols: string[]) =>
    `${bold(label.padEnd(10))} ${cols.join('  ')}`;

  lines.push(statRow('Workers:', [
    color(pad(m.workers.active) + 'a', ANSI.green),
    color(pad(m.workers.probation) + 'p', ANSI.yellow),
    dim(pad(m.workers.demoted) + 'd'),
    dim(pad(m.workers.retired ?? 0) + 'r'),
  ]));
  lines.push(statRow('Rules:', [
    color(pad(m.rules.active) + 'a', ANSI.green),
    color(pad(m.rules.probation) + 'p', ANSI.yellow),
    dim(pad(m.rules.retired) + 'r'),
  ]));
  lines.push(statRow('Skills:', [
    color(pad(m.skills.active) + 'a', ANSI.green),
    color(pad(m.skills.probation) + 'p', ANSI.yellow),
    dim(pad(m.skills.demoted) + 'd'),
  ]));
  lines.push('');
  lines.push(statRow('Patterns:', [bold(String(m.patterns.total))]));
  lines.push(statRow('Sleeps:', [String(m.patterns.sleepCyclesRun)]));
  lines.push('');

  // Evolution metrics
  if (m.evolution) {
    lines.push(bold('Evolution'));
    lines.push(statRow(' Quality:', [m.evolution.overall.qualityTrend.toFixed(2)]));
    lines.push(statRow(' Routing:', [m.evolution.overall.routingEfficiency.toFixed(2)]));
  }

  return panel('Metrics & Fleet', lines.join('\n'), width, height, focused);
}
