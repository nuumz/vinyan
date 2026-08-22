/**
 * Trace → cost ledger pricing.
 *
 * `ExecutionTrace.tokensConsumed` is a total. Pricing a total as if it were all
 * input under-charges every task, because output tokens bill at 5x input on
 * Claude models. These tests pin that the ledger uses the reported
 * input/output split when a trace carries one, and that a trace without a
 * split still records something honest rather than guessing a ratio.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';
import { CostLedger } from '../../src/economy/cost-ledger.ts';
import { TraceCollectorImpl } from '../../src/orchestrator/trace-collector.ts';
import type { ExecutionTrace } from '../../src/orchestrator/types.ts';

function createLedger(): CostLedger {
  const db = new Database(':memory:');
  migration001.up(db);
  return new CostLedger(db);
}

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: `trace-${Math.random().toString(36).slice(2)}`,
    taskId: 'task-1',
    timestamp: 1_700_000_000_000,
    routingLevel: 2,
    approach: 'edit a file',
    oracleVerdicts: {},
    modelUsed: 'claude-sonnet-4',
    tokensConsumed: 12_000,
    durationMs: 4200,
    outcome: 'success',
    affectedFiles: ['src/foo.ts'],
    ...overrides,
  } as ExecutionTrace;
}

/** Sonnet list price: $3/Mtok in, $15/Mtok out. */
const SONNET_IN_PER_TOK = 3.0 / 1_000_000;
const SONNET_OUT_PER_TOK = 15.0 / 1_000_000;

describe('trace cost accounting — input/output split', () => {
  test('a trace carrying the split is priced at input and output rates', async () => {
    const ledger = createLedger();
    const collector = new TraceCollectorImpl();
    collector.setEconomyDeps(ledger);

    await collector.record(makeTrace({ tokensConsumed: 12_000, tokensInput: 10_000, tokensOutput: 2_000 }));

    const rows = ledger.queryByTask('task-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokens_input).toBe(10_000);
    expect(rows[0]!.tokens_output).toBe(2_000);

    const expected = 10_000 * SONNET_IN_PER_TOK + 2_000 * SONNET_OUT_PER_TOK;
    expect(rows[0]!.computed_usd).toBeCloseTo(expected, 8);
    expect(rows[0]!.cost_tier).toBe('billing');
  });

  test('the split is what makes the price right — a total alone under-charges', async () => {
    const ledger = createLedger();
    const collector = new TraceCollectorImpl();
    collector.setEconomyDeps(ledger);

    // Same 12k tokens, once with the split and once without.
    await collector.record(
      makeTrace({ taskId: 'with-split', tokensConsumed: 12_000, tokensInput: 10_000, tokensOutput: 2_000 }),
    );
    await collector.record(makeTrace({ taskId: 'no-split', tokensConsumed: 12_000 }));

    const withSplit = ledger.queryByTask('with-split')[0]!;
    const noSplit = ledger.queryByTask('no-split')[0]!;

    // 2k output tokens at 5x cost the same as 10k input tokens.
    expect(withSplit.computed_usd).toBeGreaterThan(noSplit.computed_usd);
    expect(noSplit.computed_usd).toBeCloseTo(12_000 * SONNET_IN_PER_TOK, 8);
  });

  test('a trace without a split records the total as input rather than inventing a ratio', async () => {
    const ledger = createLedger();
    const collector = new TraceCollectorImpl();
    collector.setEconomyDeps(ledger);

    await collector.record(makeTrace({ tokensConsumed: 12_000 }));

    const row = ledger.queryByTask('task-1')[0]!;
    expect(row.tokens_input).toBe(12_000);
    expect(row.tokens_output).toBe(0);
  });

  test('an output-only trace is priced at the output rate', async () => {
    const ledger = createLedger();
    const collector = new TraceCollectorImpl();
    collector.setEconomyDeps(ledger);

    // tokensInput omitted, tokensOutput present — the split is still "reported",
    // so the missing half is 0, not a silent fallback to input-only pricing.
    await collector.record(makeTrace({ tokensConsumed: 2_000, tokensOutput: 2_000 }));

    const row = ledger.queryByTask('task-1')[0]!;
    expect(row.tokens_input).toBe(0);
    expect(row.tokens_output).toBe(2_000);
    expect(row.computed_usd).toBeCloseTo(2_000 * SONNET_OUT_PER_TOK, 8);
  });

  test('cache tokens are priced alongside the split', async () => {
    const ledger = createLedger();
    const collector = new TraceCollectorImpl();
    collector.setEconomyDeps(ledger);

    await collector.record(
      makeTrace({
        tokensConsumed: 1_500,
        tokensInput: 1_000,
        tokensOutput: 500,
        cacheReadTokens: 20_000,
        cacheCreationTokens: 4_000,
      }),
    );

    const row = ledger.queryByTask('task-1')[0]!;
    expect(row.cache_read_tokens).toBe(20_000);
    expect(row.cache_creation_tokens).toBe(4_000);
    // Cache reads are cheap but not free — they must move the number.
    const withoutCache = 1_000 * SONNET_IN_PER_TOK + 500 * SONNET_OUT_PER_TOK;
    expect(row.computed_usd).toBeGreaterThan(withoutCache);
  });
});
