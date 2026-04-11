/**
 * CLI economy command — Economy OS operational visibility.
 *
 * Subcommands:
 *   (none)      Summary: budget status, cost stats, market phase, trust scores
 *   budget      Detailed budget utilization per window
 *   costs       Cost breakdown by engine and task type
 *   market      Market phase, auction count, bid accuracy
 *   trust       Per-engine trust scores with capability breakdown
 *   federation  Federation pool status, peer costs
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { loadConfig } from '../config/loader.ts';
import { CostLedger } from '../economy/cost-ledger.ts';
import { BudgetEnforcer } from '../economy/budget-enforcer.ts';
import { CostPredictor } from '../economy/cost-predictor.ts';
import { ProviderTrustStore } from '../db/provider-trust-store.ts';
import { VinyanDB } from '../db/vinyan-db.ts';
import { wilsonLowerBound } from '../sleep-cycle/wilson.ts';

function openDB(workspace: string): VinyanDB | null {
  const dbPath = join(workspace, '.vinyan', 'vinyan.db');
  if (!existsSync(dbPath)) {
    console.error(`No Vinyan database found at ${dbPath}`);
    return null;
  }
  return new VinyanDB(dbPath);
}

export async function runEconomyCommand(args: string[]): Promise<void> {
  const subcommand = args[0] ?? '';
  const workspace = args.includes('--workspace')
    ? args[args.indexOf('--workspace') + 1] ?? process.cwd()
    : process.cwd();

  const db = openDB(workspace);
  if (!db) {
    process.exit(1);
    return;
  }

  try {
    const raw = db.getDb();
    const costLedger = new CostLedger(raw);

    switch (subcommand) {
      case 'budget':
        printBudget(workspace, costLedger);
        break;
      case 'costs':
        printCosts(costLedger, args);
        break;
      case 'market':
        printMarket(workspace);
        break;
      case 'trust':
        printTrust(raw);
        break;
      case 'federation':
        printFederation(workspace);
        break;
      default:
        printSummary(workspace, costLedger, raw);
        break;
    }
  } finally {
    db.close();
  }
}

function printSummary(workspace: string, ledger: CostLedger, raw: import('bun:sqlite').Database): void {
  console.log('=== Vinyan Economy Summary ===\n');

  // Cost stats
  const entries = ledger.queryByTimeRange(0, Date.now());
  const totalCost = entries.reduce((sum, e) => sum + e.computed_usd, 0);
  const engineIds = new Set(entries.map((e) => e.engineId));

  console.log('Costs:');
  console.log(`  Total entries:   ${entries.length}`);
  console.log(`  Total cost:      $${totalCost.toFixed(4)}`);
  console.log(`  Active engines:  ${engineIds.size}`);

  // Budget
  try {
    const config = loadConfig(workspace);
    if (config.economy?.budgets) {
      console.log('\nBudget:');
      const budgets = config.economy.budgets;
      if (budgets.hourly_usd) console.log(`  Hourly:  $${budgets.hourly_usd}`);
      if (budgets.daily_usd) console.log(`  Daily:   $${budgets.daily_usd}`);
      if (budgets.monthly_usd) console.log(`  Monthly: $${budgets.monthly_usd}`);
    }
  } catch { /* config not available */ }

  // Market phase
  try {
    const config = loadConfig(workspace);
    if (config.economy?.market?.enabled) {
      console.log('\nMarket:');
      console.log(`  Enabled:  yes`);
      console.log(`  Min bidders: ${config.economy.market.min_bidders}`);
    } else {
      console.log('\nMarket: disabled');
    }
  } catch { /* config not available */ }

  // Trust summary
  try {
    const trustStore = new ProviderTrustStore(raw);
    const providers = trustStore.getAllProviders();
    if (providers.length > 0) {
      console.log('\nTrust:');
      for (const p of providers.slice(0, 5)) {
        const total = p.successes + p.failures;
        const score = total > 0 ? wilsonLowerBound(p.successes, total, 1.96) : 0;
        console.log(`  ${p.provider.padEnd(30)} ${score.toFixed(3)} (${p.successes}/${total})`);
      }
      if (providers.length > 5) {
        console.log(`  ... and ${providers.length - 5} more`);
      }
    }
  } catch { /* trust store not available */ }
}

function printBudget(workspace: string, ledger: CostLedger): void {
  console.log('=== Budget Utilization ===\n');

  try {
    const config = loadConfig(workspace);
    const budgets = config.economy?.budgets;
    if (!budgets) {
      console.log('No budget configured.');
      return;
    }

    const now = Date.now();
    const windows: Array<{ label: string; fromMs: number; limit?: number }> = [
      { label: 'Last hour', fromMs: now - 3_600_000, limit: budgets.hourly_usd },
      { label: 'Last 24h', fromMs: now - 86_400_000, limit: budgets.daily_usd },
      { label: 'Last 30d', fromMs: now - 30 * 86_400_000, limit: budgets.monthly_usd },
    ];

    for (const w of windows) {
      const entries = ledger.queryByTimeRange(w.fromMs, now);
      const spent = entries.reduce((sum, e) => sum + e.computed_usd, 0);
      const pct = w.limit ? (spent / w.limit * 100) : 0;
      const bar = w.limit ? `[${progressBar(pct, 20)}]` : '';
      console.log(`${w.label.padEnd(12)} $${spent.toFixed(4)} / $${(w.limit ?? 0).toFixed(2)} ${bar} ${pct.toFixed(1)}%`);
    }
  } catch {
    console.log('Budget config not available.');
  }
}

function printCosts(ledger: CostLedger, args: string[]): void {
  console.log('=== Cost Breakdown ===\n');

  const sinceArg = args.includes('--since') ? args[args.indexOf('--since') + 1] : '24h';
  const sinceMs = parseDuration(sinceArg ?? '24h');
  const from = Date.now() - sinceMs;
  const entries = ledger.queryByTimeRange(from, Date.now());

  // By engine
  const byEngine = new Map<string, { count: number; total: number }>();
  for (const e of entries) {
    const existing = byEngine.get(e.engineId) ?? { count: 0, total: 0 };
    existing.count++;
    existing.total += e.computed_usd;
    byEngine.set(e.engineId, existing);
  }

  console.log(`Period: last ${sinceArg}\n`);
  console.log('By Engine:');
  for (const [engine, stats] of [...byEngine.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${engine.padEnd(30)} ${stats.count.toString().padStart(5)} tasks  $${stats.total.toFixed(4)}`);
  }

  // By task type
  const byTaskType = new Map<string, { count: number; total: number }>();
  for (const e of entries) {
    const sig = e.task_type_signature ?? 'unknown';
    const existing = byTaskType.get(sig) ?? { count: 0, total: 0 };
    existing.count++;
    existing.total += e.computed_usd;
    byTaskType.set(sig, existing);
  }

  console.log('\nBy Task Type:');
  for (const [taskType, stats] of [...byTaskType.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 10)) {
    console.log(`  ${taskType.padEnd(30)} ${stats.count.toString().padStart(5)} tasks  $${stats.total.toFixed(4)}`);
  }
}

function printMarket(workspace: string): void {
  console.log('=== Market Status ===\n');

  try {
    const config = loadConfig(workspace);
    const market = config.economy?.market;
    if (!market?.enabled) {
      console.log('Market is disabled.');
      return;
    }

    console.log(`Enabled:         yes`);
    console.log(`Min bidders:     ${market.min_bidders}`);
    console.log(`Min cost records: ${market.min_cost_records}`);
    console.log(`Bid TTL:         ${market.bid_ttl_ms}ms`);
    console.log(`Weights:         cost=${market.weights.cost} quality=${market.weights.quality} duration=${market.weights.duration} accuracy=${market.weights.accuracy}`);
    console.log(`\nNote: Phase state is in-memory. Use the TUI for live market status.`);
  } catch {
    console.log('Market config not available.');
  }
}

function printTrust(raw: import('bun:sqlite').Database): void {
  console.log('=== Engine Trust Scores ===\n');

  try {
    const trustStore = new ProviderTrustStore(raw);
    const providers = trustStore.getAllProviders();

    if (providers.length === 0) {
      console.log('No provider trust data yet.');
      return;
    }

    console.log(`${'Provider'.padEnd(35)} ${'Score'.padStart(7)} ${'S/F'.padStart(10)} ${'Capability'.padEnd(15)}`);
    console.log('-'.repeat(70));

    for (const p of providers.sort((a, b) => {
      const ta = a.successes + a.failures;
      const tb = b.successes + b.failures;
      const sa = ta > 0 ? wilsonLowerBound(a.successes, ta) : 0;
      const sb = tb > 0 ? wilsonLowerBound(b.successes, tb) : 0;
      return sb - sa;
    })) {
      const total = p.successes + p.failures;
      const score = total > 0 ? wilsonLowerBound(p.successes, total, 1.96) : 0;
      const bar = progressBar(score * 100, 10);
      console.log(
        `${p.provider.padEnd(35)} ${score.toFixed(3).padStart(7)} ${`${p.successes}/${total}`.padStart(10)} ${(p.capability ?? '*').padEnd(15)} [${bar}]`,
      );
    }
  } catch {
    console.log('Trust store not available.');
  }
}

function printFederation(workspace: string): void {
  console.log('=== Federation Economy ===\n');

  try {
    const config = loadConfig(workspace);
    const federation = config.economy?.federation;
    if (!federation?.cost_sharing_enabled) {
      console.log('Federation economy is disabled.');
      return;
    }

    console.log(`Cost sharing:        enabled`);
    console.log(`Peer pricing:        ${federation.peer_pricing_enabled ? 'enabled' : 'disabled'}`);
    console.log(`Pool fraction:       ${(federation.shared_pool_fraction * 100).toFixed(0)}%`);
    console.log(`Max negotiation:     ${federation.max_negotiation_rounds} rounds`);
    console.log(`\nNote: Pool balance is in-memory. Use the TUI for live federation status.`);
  } catch {
    console.log('Federation config not available.');
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function progressBar(pct: number, width: number): string {
  const filled = Math.round(Math.min(100, Math.max(0, pct)) / 100 * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function parseDuration(s: string): number {
  const match = s.match(/^(\d+)(h|d|m)$/);
  if (!match) return 86_400_000; // default 24h
  const [, num, unit] = match;
  const n = parseInt(num!, 10);
  switch (unit) {
    case 'h': return n * 3_600_000;
    case 'd': return n * 86_400_000;
    case 'm': return n * 60_000;
    default: return 86_400_000;
  }
}
