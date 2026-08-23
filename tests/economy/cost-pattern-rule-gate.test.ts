/**
 * Cost pattern mining stays observational by default.
 *
 * The factory already hands `costLedger` to the sleep cycle, so making cost
 * accounting default-on also starts CostPatternMiner on every deployment.
 * Mining and persisting patterns is read-mostly and fine; PROMOTING those
 * patterns into Phase 2 evolution rules is a behaviour change to an earlier
 * phase that nobody asked for. It stays behind
 * `economy.patterns.generate_rules`, which defaults to false.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { COST_LEDGER_DDL } from '../../src/db/economy-schema.ts';
import { PATTERN_SCHEMA_SQL } from '../../src/db/pattern-schema.ts';
import { PatternStore } from '../../src/db/pattern-store.ts';
import { RULE_SCHEMA_SQL } from '../../src/db/rule-schema.ts';
import { RuleStore } from '../../src/db/rule-store.ts';
import { TRACE_SCHEMA_SQL } from '../../src/db/trace-schema.ts';
import { TraceStore } from '../../src/db/trace-store.ts';
import { CostLedger, type CostLedgerEntry } from '../../src/economy/cost-ledger.ts';
import { SleepCycleRunner } from '../../src/sleep-cycle/sleep-cycle.ts';

function makeEntry(engineId: string, usd: number, i: number): CostLedgerEntry {
  return {
    id: `${engineId}-${i}:1:${i}`,
    taskId: `task-${engineId}-${i}`,
    workerId: null,
    engineId,
    timestamp: Date.now(),
    tokens_input: 5_000,
    tokens_output: 2_000,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    duration_ms: 4_000,
    oracle_invocations: 1,
    computed_usd: usd,
    cost_tier: 'billing',
    routing_level: 2,
    task_type_signature: 'refactor::ts::single',
  };
}

function createEnv(costRuleGeneration: boolean) {
  const db = new Database(':memory:');
  db.exec(TRACE_SCHEMA_SQL);
  db.exec(PATTERN_SCHEMA_SQL);
  db.exec(RULE_SCHEMA_SQL);
  db.exec(COST_LEDGER_DDL);
  const ledger = new CostLedger(db);
  // One clearly expensive engine and one clearly cheap one, both well past the
  // miner's 5-observation minimum — the shape that yields cost patterns.
  for (let i = 0; i < 8; i++) {
    ledger.record(makeEntry('expensive/engine', 1.0, i));
    ledger.record(makeEntry('cheap/engine', 0.05, i));
  }
  // The sleep cycle's own data gate (>=100 traces, >=5 task types) runs before
  // cost mining, so seed enough trace history to get past it.
  for (let i = 0; i < 120; i++) {
    db.run(
      `INSERT INTO execution_traces (
        id, task_id, timestamp, routing_level, approach, model_used,
        tokens_consumed, duration_ms, outcome, oracle_verdicts, affected_files,
        worker_id, quality_composite, task_type_signature
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `seed-trace-${i}`,
        `seed-task-${i}`,
        Date.now(),
        2,
        'approach',
        'seed/engine',
        1000,
        5000,
        'success',
        '{}',
        '[]',
        'seed-worker',
        0.8,
        `seed${i % 6}::ts::single`,
      ],
    );
  }

  const ruleStore = new RuleStore(db);
  const runner = new SleepCycleRunner({
    traceStore: new TraceStore(db),
    patternStore: new PatternStore(db),
    ruleStore,
    costLedger: ledger,
    costRuleGeneration,
  });
  return { runner, ruleStore };
}

describe('cost pattern → evolution rule promotion', () => {
  test('a default cycle mines cost patterns but writes no evolution rules', async () => {
    const { runner, ruleStore } = createEnv(false);
    const result = await runner.run();

    // Mining ran (it is the read side of E2.4)...
    expect(result.costPatternsFound).toBeGreaterThan(0);
    // ...but nothing was promoted into the rule store.
    expect(ruleStore.count()).toBe(0);
  });

  test('opting in promotes the same patterns into rules', async () => {
    const { runner, ruleStore } = createEnv(true);
    const result = await runner.run();

    expect(result.costPatternsFound).toBeGreaterThan(0);
    expect(ruleStore.count()).toBeGreaterThan(0);
  });
});
