/**
 * Book-integration Wave 5.11: `vinyan tui costs` view tests.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { CostLedgerEntry } from '../../src/economy/cost-ledger.ts';
import { CostLedger } from '../../src/economy/cost-ledger.ts';
import { showCosts } from '../../src/tui/views/costs.ts';

function makeLedger(): { ledger: CostLedger; db: Database } {
  const db = new Database(':memory:');
  // Create the cost_ledger table directly so CostLedger.warmCache
  // has something to read.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cost_ledger (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      worker_id TEXT,
      engine_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      tokens_input INTEGER NOT NULL,
      tokens_output INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL,
      oracle_invocations INTEGER NOT NULL DEFAULT 0,
      computed_usd REAL NOT NULL,
      cost_tier TEXT NOT NULL,
      routing_level INTEGER NOT NULL,
      task_type_signature TEXT
    );
  `);
  return { ledger: new CostLedger(db), db };
}

function entry(overrides: Partial<CostLedgerEntry> = {}): CostLedgerEntry {
  return {
    id: `entry-${Math.random().toString(36).slice(2)}`,
    taskId: 'task-1',
    workerId: null,
    engineId: 'claude-sonnet',
    timestamp: Date.now(),
    tokens_input: 500,
    tokens_output: 200,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    duration_ms: 1000,
    oracle_invocations: 0,
    computed_usd: 0.01,
    cost_tier: 'estimated',
    routing_level: 2,
    task_type_signature: null,
    ...overrides,
  };
}

describe('showCosts — Wave 5.11', () => {
  test('prints empty-ledger notice when there are no entries', () => {
    const { ledger } = makeLedger();
    const lines: string[] = [];
    showCosts({ workspace: '/tmp', ledger, write: (l) => lines.push(l) });
    const joined = lines.join('\n');
    expect(joined).toContain('Vinyan Costs');
    expect(joined).toContain('No cost data recorded yet');
  });

  test('prints total entry count + aggregate windows', () => {
    const { ledger } = makeLedger();
    const now = Date.now();
    // 3 entries in the last hour, 2 engines
    ledger.record(entry({ timestamp: now - 10_000, engineId: 'claude-haiku', computed_usd: 0.002 }));
    ledger.record(entry({ timestamp: now - 20_000, engineId: 'claude-sonnet', computed_usd: 0.01 }));
    ledger.record(entry({ timestamp: now - 30_000, engineId: 'claude-sonnet', computed_usd: 0.02 }));

    const lines: string[] = [];
    showCosts({ workspace: '/tmp', ledger, write: (l) => lines.push(l) });
    const joined = lines.join('\n');

    expect(joined).toContain('Total entries:');
    expect(joined).toContain('3');
    expect(joined).toContain('Last hour:');
    expect(joined).toContain('Today:');
    expect(joined).toContain('This month:');
    // Top engines: sonnet (0.03) > haiku (0.002)
    expect(joined).toContain('claude-sonnet');
    expect(joined).toContain('claude-haiku');
    // Sonnet total formatted
    expect(joined).toContain('$0.0300');
  });

  test('top-engines list is sorted by USD spend descending', () => {
    const { ledger } = makeLedger();
    const now = Date.now();
    // engineA: $0.05 total; engineB: $0.10 total; engineC: $0.02 total
    ledger.record(entry({ engineId: 'A', computed_usd: 0.05, timestamp: now }));
    ledger.record(entry({ engineId: 'B', computed_usd: 0.06, timestamp: now }));
    ledger.record(entry({ engineId: 'B', computed_usd: 0.04, timestamp: now }));
    ledger.record(entry({ engineId: 'C', computed_usd: 0.02, timestamp: now }));

    const lines: string[] = [];
    showCosts({ workspace: '/tmp', ledger, write: (l) => lines.push(l) });
    const joined = lines.join('\n');
    const bIdx = joined.indexOf('B ');
    const aIdx = joined.indexOf('A ');
    const cIdx = joined.indexOf('C ');
    // B before A before C (because $0.10 > $0.05 > $0.02)
    expect(bIdx).toBeLessThan(aIdx);
    expect(aIdx).toBeLessThan(cIdx);
  });

  test('missing DB prints a friendly no-ledger notice', () => {
    const lines: string[] = [];
    showCosts({
      workspace: '/definitely/not/a/real/path/for/vinyan',
      write: (l) => lines.push(l),
    });
    const joined = lines.join('\n');
    expect(joined).toContain('Vinyan Costs');
    expect(joined).toContain('no ledger');
  });
});
