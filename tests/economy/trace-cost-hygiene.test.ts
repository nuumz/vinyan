/**
 * Cost-ledger hygiene at the writer.
 *
 * Cost accounting runs on every task by default now, so what the ledger
 * REFUSES to record matters as much as what it records. Three properties are
 * pinned here:
 *
 *  1. Traces that never touched a model write nothing — no row, no
 *     `economy:rate_card_miss` for an engine literally named "none".
 *  2. Traces with zero billable token volume write nothing, so they cannot
 *     drag token percentiles toward zero or pin the cost EMA at $0.
 *  3. Row ids never collide, even for the deterministic per-task trace ids
 *     the escalation path re-uses.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createBus } from '../../src/core/bus.ts';
import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';
import { CostLedger } from '../../src/economy/cost-ledger.ts';
import { TraceCollectorImpl } from '../../src/orchestrator/trace-collector.ts';
import type { ExecutionTrace } from '../../src/orchestrator/types.ts';

function createEnv() {
  const db = new Database(':memory:');
  migration001.up(db);
  const bus = createBus();
  const ledger = new CostLedger(db, bus);
  const collector = new TraceCollectorImpl(undefined, undefined, bus);
  collector.setEconomyDeps(ledger, undefined, bus);
  return { db, bus, ledger, collector };
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
    tokensInput: 10_000,
    tokensOutput: 2_000,
    durationMs: 4200,
    outcome: 'success',
    affectedFiles: ['src/foo.ts'],
    ...overrides,
  } as ExecutionTrace;
}

function rowCount(db: Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM cost_ledger').get() as { n: number }).n;
}

describe('cost ledger writer hygiene', () => {
  test("traces with modelUsed 'none' write no row and emit no rate-card miss", async () => {
    const { db, bus, ledger, collector } = createEnv();
    const misses: unknown[] = [];
    bus.on('economy:rate_card_miss', (p) => misses.push(p));

    for (let i = 0; i < 3; i++) {
      await collector.record(
        makeTrace({ id: `none-${i}`, modelUsed: 'none', tokensConsumed: 0, tokensInput: 0, tokensOutput: 0 }),
      );
    }

    expect(rowCount(db)).toBe(0);
    expect(ledger.count()).toBe(0);
    expect(misses).toHaveLength(0);
  });

  test('a trace with a real engine but zero tokens writes no row', async () => {
    const { db, ledger, collector } = createEnv();

    // Shape of the comprehension-phase trace: real engine id, no tokens.
    await collector.record(
      makeTrace({
        id: 'trace-task-1-comprehension',
        modelUsed: 'claude-sonnet-4',
        tokensConsumed: 0,
        tokensInput: undefined,
        tokensOutput: undefined,
      }),
    );

    expect(rowCount(db)).toBe(0);
    expect(ledger.count()).toBe(0);
  });

  test('a real priced trace still records exactly one row', async () => {
    const { db, ledger, collector } = createEnv();

    await collector.record(makeTrace({ id: 'trace-real-1' }));

    expect(rowCount(db)).toBe(1);
    expect(ledger.queryByTask('task-1')).toHaveLength(1);
    expect(ledger.queryByTask('task-1')[0]!.computed_usd).toBeGreaterThan(0);
  });

  test('repeated deterministic trace ids do not collide on the ledger primary key', async () => {
    const { db, bus, collector } = createEnv();
    const failures: unknown[] = [];
    bus.on('economy:accounting_failed', (p) => failures.push(p));

    // The escalation path re-uses `trace-<task>-<level>-escalated` verbatim;
    // an identical timestamp used to make the second INSERT throw.
    for (let i = 0; i < 3; i++) {
      await collector.record(makeTrace({ id: 'trace-task-1-2-escalated', timestamp: 1_700_000_000_000 }));
    }

    expect(rowCount(db)).toBe(3);
    expect(failures).toHaveLength(0);
  });

  test('a routing tier label is priced but marked estimated, not billing', async () => {
    const { ledger, collector } = createEnv();

    // `claude-sonnet` is LEVEL_CONFIG's L2 tier-label HINT, not a provider id.
    await collector.record(makeTrace({ taskId: 'tier-label', modelUsed: 'claude-sonnet' }));
    // A real provider id that happens to glob the same card.
    await collector.record(makeTrace({ taskId: 'real-engine', modelUsed: 'claude-sonnet-4-5' }));

    const tierRow = ledger.queryByTask('tier-label')[0]!;
    const realRow = ledger.queryByTask('real-engine')[0]!;
    expect(tierRow.computed_usd).toBeGreaterThan(0);
    expect(tierRow.cost_tier).toBe('estimated');
    expect(realRow.cost_tier).toBe('billing');
  });

  test('engineId wins over modelUsed as the pricing key', async () => {
    const { ledger, collector } = createEnv();

    await collector.record(
      makeTrace({ taskId: 'engine-wins', modelUsed: 'claude-opus', engineId: 'claude-haiku-4-5' }),
    );

    const row = ledger.queryByTask('engine-wins')[0]!;
    expect(row.engineId).toBe('claude-haiku-4-5');
    // Haiku rates ($0.25/$1.25), not Opus ($15/$75).
    expect(row.computed_usd).toBeCloseTo((10_000 * 0.25 + 2_000 * 1.25) / 1_000_000, 8);
  });

  test('a trace with no input/output split is flagged as under-reported', async () => {
    const { bus, collector } = createEnv();
    const flagged: Array<{ tokensConsumed: number }> = [];
    bus.on('economy:cost_estimated_no_split', (p) => flagged.push(p));

    await collector.record(
      makeTrace({ taskId: 'no-split', tokensConsumed: 9_000, tokensInput: undefined, tokensOutput: undefined }),
    );
    await collector.record(makeTrace({ taskId: 'with-split' }));

    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.tokensConsumed).toBe(9_000);
  });
});
