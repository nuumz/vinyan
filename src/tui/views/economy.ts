/**
 * Economy View — Tab 5: Budget (left) + Market/Trust (right).
 *
 * Left panel: budget gauges per window, cost timeline sparkline.
 * Right panel: market phase indicator, engine trust table.
 */

import {
  ANSI,
  bold,
  color,
  dim,
  gauge,
  padEnd,
  panel,
  sideBySide,
  sparkline,
} from '../renderer.ts';
import type { TUIState } from '../types.ts';

export const ECONOMY_PANEL_COUNT = 2;

export interface EconomyDisplayState {
  budgetWindows: Array<{
    label: string;
    spent: number;
    limit: number;
    pct: number;
  }>;
  costHistory: number[];
  totalCostUsd: number;
  totalEntries: number;
  marketPhase: string;
  marketEnabled: boolean;
  auctionCount: number;
  engineTrust: Array<{
    provider: string;
    score: number;
    successes: number;
    total: number;
  }>;
  federationEnabled: boolean;
  federationPoolRemaining?: number;
}

/** Render the economy tab. State is augmented with economy data. */
export function renderEconomy(state: TUIState): string {
  const { termWidth, termHeight } = state;
  const economy = (state as TUIState & { economy?: EconomyDisplayState }).economy;

  if (!economy) {
    const leftWidth = Math.floor(termWidth * 0.5);
    const rightWidth = termWidth - leftWidth - 1;
    const panelHeight = termHeight - 4;
    const left = panel('Budget', dim('Economy OS not enabled. Set economy.enabled = true in vinyan.json.'), leftWidth, panelHeight);
    const right = panel('Market & Trust', '', rightWidth, panelHeight);
    return sideBySide(left, right);
  }

  const leftWidth = Math.floor(termWidth * 0.45);
  const rightWidth = termWidth - leftWidth - 1;
  const panelHeight = termHeight - 4;

  const budgetPanel = renderBudgetPanel(economy, leftWidth, panelHeight, state.focusedPanel === 0);
  const marketPanel = renderMarketTrustPanel(economy, rightWidth, panelHeight, state.focusedPanel === 1);

  return sideBySide(budgetPanel, marketPanel);
}

function renderBudgetPanel(economy: EconomyDisplayState, width: number, height: number, focused: boolean): string {
  const lines: string[] = [];

  lines.push(bold('Cost Summary'));
  lines.push(`  Total entries: ${economy.totalEntries}`);
  lines.push(`  Total cost:    $${economy.totalCostUsd.toFixed(4)}`);
  lines.push('');

  // Budget gauges
  lines.push(bold('Budget Utilization'));
  for (const w of economy.budgetWindows) {
    const gaugeColor = w.pct >= 90 ? ANSI.red : w.pct >= 70 ? ANSI.yellow : ANSI.green;
    const gaugeWidth = Math.max(10, width - 30);
    lines.push(`  ${padEnd(w.label, 10)} ${gauge(w.pct / 100, gaugeWidth)} ${color(`${w.pct.toFixed(0)}%`, gaugeColor)}`);
    lines.push(`  ${dim(`$${w.spent.toFixed(4)} / $${w.limit.toFixed(2)}`)}`);
  }
  if (economy.budgetWindows.length === 0) {
    lines.push(dim('  No budget limits configured'));
  }
  lines.push('');

  // Cost timeline sparkline
  if (economy.costHistory.length > 0) {
    lines.push(bold('Cost Timeline (24h)'));
    const sparkWidth = Math.max(10, width - 6);
    lines.push(`  ${sparkline(economy.costHistory, sparkWidth)}`);
  }

  // Federation
  if (economy.federationEnabled) {
    lines.push('');
    lines.push(bold('Federation Pool'));
    if (economy.federationPoolRemaining !== undefined) {
      lines.push(`  Remaining: $${economy.federationPoolRemaining.toFixed(4)}`);
    } else {
      lines.push(dim('  Pool balance unavailable'));
    }
  }

  return panel('Budget', lines.join('\n'), width, height, focused);
}

function renderMarketTrustPanel(economy: EconomyDisplayState, width: number, height: number, focused: boolean): string {
  const lines: string[] = [];

  // Market status
  lines.push(bold('Market'));
  if (!economy.marketEnabled) {
    lines.push(dim('  Market disabled'));
  } else {
    const phaseColors: Record<string, string> = { A: ANSI.dim, B: ANSI.green, C: ANSI.cyan, D: ANSI.magenta };
    const phaseColor = phaseColors[economy.marketPhase] ?? ANSI.white;
    lines.push(`  Phase: ${color(economy.marketPhase, ANSI.bold, phaseColor)}`);
    lines.push(`  Auctions: ${economy.auctionCount}`);
  }
  lines.push('');

  // Engine trust table
  lines.push(bold('Engine Trust'));
  if (economy.engineTrust.length === 0) {
    lines.push(dim('  No trust data yet'));
  } else {
    const nameWidth = Math.min(25, Math.max(...economy.engineTrust.map((e) => e.provider.length)));
    const barWidth = Math.max(8, width - nameWidth - 20);

    for (const engine of economy.engineTrust.slice(0, 15)) {
      const scorePct = engine.score * 100;
      const scoreColor = scorePct >= 70 ? ANSI.green : scorePct >= 40 ? ANSI.yellow : ANSI.red;
      const bar = gauge(engine.score, barWidth);
      const name = engine.provider.length > nameWidth
        ? engine.provider.slice(0, nameWidth - 2) + '..'
        : padEnd(engine.provider, nameWidth);
      lines.push(`  ${name} ${bar} ${color(engine.score.toFixed(2), scoreColor)} (${engine.successes}/${engine.total})`);
    }
    if (economy.engineTrust.length > 15) {
      lines.push(dim(`  ... and ${economy.engineTrust.length - 15} more`));
    }
  }

  return panel('Market & Trust', lines.join('\n'), width, height, focused);
}
