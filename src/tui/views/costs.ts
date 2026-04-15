/**
 * Costs View — one-shot Vinyan cost summary.
 *
 * Book-integration Wave 5.11 (closes Ch13's `maw costs` operator
 * surface from Appendix A's command reference).
 *
 * Renders a snapshot of the `CostLedger` at the workspace's
 * `.vinyan/vinyan.db`:
 *
 *   - total entries cached in the ledger
 *   - aggregate USD spend for hour / day / month windows
 *   - top 5 engines by all-time USD spend
 *
 * Zero governance impact — this is a pure read-only view. Opens the
 * SQLite DB read-only, hydrates a fresh `CostLedger` from the cache
 * warmup, prints, and closes.
 *
 * Exit behavior:
 *   - No Vinyan DB at the expected path → prints a hint and returns
 *   - DB exists but `cost_ledger` table hasn't been created yet →
 *     `CostLedger.warmCache` swallows the error and returns empty.
 *     The view prints "no cost data recorded yet."
 *
 * A3-safe: deterministic aggregation, no LLM. A6-safe: read-only; no
 * file writes, no tool execution.
 */
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { CostLedger } from '../../economy/cost-ledger.ts';
import { ANSI, bold, box, color, dim } from '../renderer.ts';

export interface CostsViewConfig {
  workspace: string;
  /** Injectable sink for tests (defaults to console.log). */
  write?: (line: string) => void;
  /** Optional override: use this CostLedger directly (skips DB open). */
  ledger?: CostLedger;
}

const DB_SUBPATH = '.vinyan/vinyan.db';

export function showCosts(config: CostsViewConfig): void {
  const write = config.write ?? ((line: string) => console.log(line));

  // Option 1: caller passed a pre-built ledger (test path or integration
  // with a live orchestrator). Render from it directly.
  if (config.ledger) {
    writeReport(config.ledger, write);
    return;
  }

  // Option 2: open the workspace DB read-only and hydrate a transient
  // ledger. Safe when called from the CLI — no migrations are run
  // because we open read-only and `CostLedger.warmCache` tolerates
  // missing tables.
  const dbPath = join(config.workspace, DB_SUBPATH);
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    write(box('Vinyan Costs', `${color('no ledger', ANSI.red)}\n\nNo Vinyan DB at ${dim(dbPath)}`));
    return;
  }

  try {
    const ledger = new CostLedger(db);
    writeReport(ledger, write);
  } finally {
    try {
      db.close();
    } catch {
      /* closing a read-only DB is best-effort */
    }
  }
}

function writeReport(ledger: CostLedger, write: (line: string) => void): void {
  const total = ledger.count();
  if (total === 0) {
    write(box('Vinyan Costs', dim('No cost data recorded yet.')));
    return;
  }

  const hour = ledger.getAggregatedCost('hour');
  const day = ledger.getAggregatedCost('day');
  const month = ledger.getAggregatedCost('month');

  // Top engines by all-time spend. Iterate the full cache window —
  // `queryByTimeRange(0, now)` returns every entry the ledger knows
  // about, which is capped at 10k by warmCache's LIMIT.
  const engineTotals = new Map<string, { usd: number; tasks: number }>();
  for (const entry of ledger.queryByTimeRange(0, Date.now())) {
    const prev = engineTotals.get(entry.engineId) ?? { usd: 0, tasks: 0 };
    engineTotals.set(entry.engineId, {
      usd: prev.usd + entry.computed_usd,
      tasks: prev.tasks + 1,
    });
  }
  const topEngines = [...engineTotals.entries()].sort((a, b) => b[1].usd - a[1].usd).slice(0, 5);

  const lines: string[] = [];
  lines.push(`${bold('Total entries:')} ${total}`);
  lines.push('');
  lines.push(`${bold('Last hour:')}  $${hour.total_usd.toFixed(4)} across ${hour.count} entrie(s)`);
  lines.push(`${bold('Today:')}      $${day.total_usd.toFixed(4)} across ${day.count} entrie(s)`);
  lines.push(`${bold('This month:')} $${month.total_usd.toFixed(4)} across ${month.count} entrie(s)`);
  lines.push('');

  if (topEngines.length > 0) {
    lines.push(bold('Top engines (all time in cache):'));
    for (const [engine, stats] of topEngines) {
      const engineCol = engine.padEnd(28).slice(0, 28);
      lines.push(`  ${engineCol} ${color(`$${stats.usd.toFixed(4)}`, ANSI.green)} ${dim(`(${stats.tasks} entries)`)}`);
    }
  } else {
    lines.push(dim('(no engine-attributed entries)'));
  }

  write(box('Vinyan Costs', lines.join('\n')));
}
