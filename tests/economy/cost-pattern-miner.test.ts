import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migration012 } from '../../src/db/migrations/012_add_economy_tables.ts';
import { CostLedger, type CostLedgerEntry } from '../../src/economy/cost-ledger.ts';
import { CostPatternMiner } from '../../src/economy/cost-pattern-miner.ts';

function createEnv() {
  const db = new Database(':memory:');
  migration012.up(db);
  const ledger = new CostLedger(db);
  const miner = new CostPatternMiner(ledger);
  return { ledger, miner };
}

function makeEntry(overrides?: Partial<CostLedgerEntry>): CostLedgerEntry {
  return {
    id: `t-${Math.random().toString(36).slice(2)}:${Date.now()}`,
    taskId: 'task-1',
    workerId: null,
    engineId: 'claude-sonnet',
    timestamp: Date.now(),
    tokens_input: 5000,
    tokens_output: 2000,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    duration_ms: 5000,
    oracle_invocations: 0,
    computed_usd: 0.075,
    cost_tier: 'billing',
    routing_level: 2,
    task_type_signature: 'refactor:ts:small',
    ...overrides,
  };
}

describe('CostPatternMiner', () => {
  test('returns empty when insufficient data', () => {
    const { miner } = createEnv();
    expect(miner.extract()).toHaveLength(0);
  });

  test('returns empty when only one engine', () => {
    const { ledger, miner } = createEnv();
    for (let i = 0; i < 10; i++) {
      ledger.record(makeEntry({ id: `s-${i}:1`, engineId: 'claude-sonnet' }));
    }
    expect(miner.extract()).toHaveLength(0);
  });

  test('detects cost anti-pattern when engine is >2x median', () => {
    const { ledger, miner } = createEnv();

    // Engine A: cheap (majority — drives the median down)
    for (let i = 0; i < 15; i++) {
      ledger.record(
        makeEntry({
          id: `cheap-${i}:1`,
          engineId: 'engine-cheap',
          computed_usd: 0.05,
          task_type_signature: 'test:sig',
        }),
      );
    }

    // Engine B: very expensive (>2x the median which is ~0.05)
    for (let i = 0; i < 8; i++) {
      ledger.record(
        makeEntry({
          id: `exp-${i}:1`,
          engineId: 'engine-expensive',
          computed_usd: 0.3,
          task_type_signature: 'test:sig',
        }),
      );
    }

    const patterns = miner.extract();
    const antiPatterns = patterns.filter((p) => p.type === 'cost-anti-pattern');
    expect(antiPatterns.length).toBeGreaterThanOrEqual(1);
    expect(antiPatterns[0]!.engineId).toBe('engine-expensive');
    expect(antiPatterns[0]!.costRatio).toBeGreaterThan(2.0);
  });

  test('detects cost success-pattern when engine is <50% cost', () => {
    const { ledger, miner } = createEnv();

    // Engine A: cheap
    for (let i = 0; i < 10; i++) {
      ledger.record(
        makeEntry({
          id: `a-${i}:1`,
          engineId: 'engine-A',
          computed_usd: 0.02,
          task_type_signature: 'test:success',
        }),
      );
    }

    // Engine B: expensive (A is <50% of B)
    for (let i = 0; i < 10; i++) {
      ledger.record(
        makeEntry({
          id: `b-${i}:1`,
          engineId: 'engine-B',
          computed_usd: 0.1,
          task_type_signature: 'test:success',
        }),
      );
    }

    const patterns = miner.extract();
    const successPatterns = patterns.filter((p) => p.type === 'cost-success-pattern');
    expect(successPatterns.length).toBeGreaterThanOrEqual(1);
    expect(successPatterns[0]!.engineId).toBe('engine-A');
    expect(successPatterns[0]!.comparedEngineId).toBe('engine-B');
  });

  test('does not detect pattern when cost difference is small', () => {
    const { ledger, miner } = createEnv();

    // Two engines with similar costs
    for (let i = 0; i < 10; i++) {
      ledger.record(
        makeEntry({ id: `x-${i}:1`, engineId: 'engine-X', computed_usd: 0.05, task_type_signature: 'similar:sig' }),
      );
      ledger.record(
        makeEntry({ id: `y-${i}:1`, engineId: 'engine-Y', computed_usd: 0.06, task_type_signature: 'similar:sig' }),
      );
    }

    const patterns = miner.extract();
    // No anti-pattern (neither is >2x median)
    const antiPatterns = patterns.filter((p) => p.type === 'cost-anti-pattern');
    expect(antiPatterns).toHaveLength(0);
    // No success-pattern (neither is <50% of the other)
    const successPatterns = patterns.filter((p) => p.type === 'cost-success-pattern');
    expect(successPatterns).toHaveLength(0);
  });

  test('ignores entries without task_type_signature', () => {
    const { ledger, miner } = createEnv();
    for (let i = 0; i < 10; i++) {
      ledger.record(makeEntry({ id: `no-sig-${i}:1`, task_type_signature: null }));
    }
    expect(miner.extract()).toHaveLength(0);
  });
});
