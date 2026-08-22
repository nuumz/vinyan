/**
 * Economy E1/E2 are Active by default — end-to-end evidence.
 *
 * "Active" in this codebase means: runs in a default `vinyan run` with no
 * extra config. Constructing four objects is not evidence of that; a cost row
 * in SQLite written by a real task is. These tests drive the real
 * `createOrchestrator` over a temp workspace and read `<workspace>/.vinyan/
 * vinyan.db` directly rather than trusting the ledger's in-memory cache.
 *
 * They also pin the three promises the default flip makes:
 *   - nothing gets refused (enforcement is `warn` with no caps),
 *   - the market and federation halves stay opt-in,
 *   - operators keep the off-switch.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearConfigCache } from '../../src/config/loader.ts';
import { createBus } from '../../src/core/bus.ts';
import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';
import { BudgetEnforcer } from '../../src/economy/budget-enforcer.ts';
import { CostLedger, type CostLedgerEntry } from '../../src/economy/cost-ledger.ts';
import { createOrchestrator } from '../../src/orchestrator/factory.ts';
import { createMockProvider } from '../../src/orchestrator/llm/mock-provider.ts';
import { LLMProviderRegistry } from '../../src/orchestrator/llm/provider-registry.ts';
import { computeTaskSignature } from '../../src/orchestrator/prediction/self-model.ts';
import type { TaskInput } from '../../src/orchestrator/types.ts';

const MOCK_ENGINE_IDS = ['mock/fast', 'mock/balanced', 'mock/powerful'];

/**
 * Mock provider ids match no glob in DEFAULT_RATE_CARDS, so without a card the
 * ledger would honestly record $0.00 / 'estimated' and any `computed_usd > 0`
 * assertion would be vacuous. Register a card per mock engine id (exact-key
 * config match) so the pricing path is actually exercised.
 */
const MOCK_RATE_CARDS = Object.fromEntries(
  MOCK_ENGINE_IDS.map((id) => [id, { input_per_mtok: 3.0, output_per_mtok: 15.0 }]),
);

let tempDir: string;

function makeRegistry(): LLMProviderRegistry {
  const registry = new LLMProviderRegistry();
  registry.register(createMockProvider({ id: 'mock/fast', tier: 'fast' }));
  registry.register(createMockProvider({ id: 'mock/balanced', tier: 'balanced' }));
  registry.register(createMockProvider({ id: 'mock/powerful', tier: 'powerful' }));
  return registry;
}

function writeWorkspace(economy?: Record<string, unknown>): void {
  const config: Record<string, unknown> = {
    version: 1,
    oracles: {
      type: { enabled: false },
      dep: { enabled: true },
      ast: { enabled: true },
      test: { enabled: false },
      lint: { enabled: false },
    },
  };
  if (economy !== undefined) config.economy = economy;
  writeFileSync(join(tempDir, 'vinyan.json'), JSON.stringify(config, null, 2));
}

function makeInput(overrides?: Partial<TaskInput>): TaskInput {
  return {
    id: `econ-${Math.random().toString(36).slice(2)}`,
    source: 'cli',
    goal: 'Fix the divide-by-zero bug in utils',
    taskType: 'code',
    targetFiles: ['src/utils.ts'],
    budget: { maxTokens: 10_000, maxDurationMs: 30_000, maxRetries: 1 },
    ...overrides,
  };
}

function costRows(where = '1=1', params: unknown[] = []): Array<Record<string, unknown>> {
  const db = new Database(join(tempDir, '.vinyan', 'vinyan.db'), { readonly: true });
  try {
    return db.prepare(`SELECT * FROM cost_ledger WHERE ${where}`).all(...(params as never[])) as Array<
      Record<string, unknown>
    >;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  clearConfigCache();
  tempDir = mkdtempSync(join(tmpdir(), 'vinyan-econ-e2e-'));
  mkdirSync(join(tempDir, 'src'), { recursive: true });
  writeFileSync(
    join(tempDir, 'src', 'utils.ts'),
    `export function divide(a: number, b: number): number {
  return a / b; // BUG: no zero check
}
`,
  );
});

afterEach(() => {
  clearConfigCache();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('Economy E1/E2 default-on wiring', () => {
  test('a workspace with no economy config constructs ledger, enforcer, predictor and allocator', () => {
    writeWorkspace();
    const orchestrator = createOrchestrator({ workspace: tempDir, bus: createBus(), registry: makeRegistry() });

    expect(orchestrator.costLedger).toBeDefined();
    expect(orchestrator.budgetEnforcer).toBeDefined();
    expect(orchestrator.costPredictor).toBeDefined();
    expect(orchestrator.dynamicBudgetAllocator).toBeDefined();
    // The ledger is live, not a stub: it answers queries.
    expect(orchestrator.costLedger!.count()).toBe(0);
  });

  test(
    'a real task writes a priced cost row to SQLite with no economy config beyond a rate card',
    async () => {
      writeWorkspace({ rate_cards: MOCK_RATE_CARDS });
      const bus = createBus();
      const recorded: Array<{ engineId: string; computed_usd: number; cost_tier: string }> = [];
      bus.on('economy:cost_recorded', (p) => recorded.push(p));

      const orchestrator = createOrchestrator({ workspace: tempDir, bus, registry: makeRegistry() });
      const input = makeInput();
      await orchestrator.executeTask(input);

      const rows = costRows('task_id = ? AND computed_usd > 0', [input.id]);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0]!.cost_tier).toBe('billing');
      expect(MOCK_ENGINE_IDS).toContain(rows[0]!.engine_id as string);
      expect(Number(rows[0]!.tokens_input) + Number(rows[0]!.tokens_output)).toBeGreaterThan(0);

      // The bus event and the durable row agree.
      expect(recorded.some((r) => r.computed_usd > 0)).toBe(true);
    },
    { timeout: 60_000 },
  );

  test(
    'no-token traces from the same run write no rows',
    async () => {
      writeWorkspace({ rate_cards: MOCK_RATE_CARDS });
      const orchestrator = createOrchestrator({ workspace: tempDir, bus: createBus(), registry: makeRegistry() });
      const input = makeInput();
      await orchestrator.executeTask(input);

      // Every row that exists priced real tokens — no $0 filler.
      const zeroRows = costRows('tokens_input = 0 AND tokens_output = 0');
      expect(zeroRows).toHaveLength(0);
      const noneRows = costRows("engine_id = 'none'");
      expect(noneRows).toHaveLength(0);
    },
    { timeout: 60_000 },
  );

  test(
    'the cost predictor accumulates observations across repeated tasks of one type',
    async () => {
      writeWorkspace({ rate_cards: MOCK_RATE_CARDS });
      const orchestrator = createOrchestrator({ workspace: tempDir, bus: createBus(), registry: makeRegistry() });
      const predictor = orchestrator.costPredictor!;

      const first = makeInput();
      const signature = computeTaskSignature(first);
      const result = await orchestrator.executeTask(first);
      const level = result.trace.routingLevel;

      // Without the phase-learn ordering fix this stays 0 forever: calibration
      // used to read the ledger ~70 lines BEFORE the row was written.
      expect(predictor.getObservationCount(signature, level)).toBeGreaterThan(0);

      const before = predictor.getObservationCount(signature, level);
      await orchestrator.executeTask(makeInput());
      expect(predictor.getObservationCount(signature, level)).toBeGreaterThan(before);
    },
    { timeout: 120_000 },
  );

  test(
    'the predictor leaves cold-start and produces a calibrated estimate',
    async () => {
      writeWorkspace({ rate_cards: MOCK_RATE_CARDS });
      const orchestrator = createOrchestrator({ workspace: tempDir, bus: createBus(), registry: makeRegistry() });
      const predictor = orchestrator.costPredictor!;
      const signature = computeTaskSignature(makeInput());

      // `predict()` stays on the cold-start branch until 5 observations at the
      // same (signature, routing level). An observation count alone is not
      // evidence that prediction produces anything usable.
      expect(predictor.predict(signature, 1).basis).toBe('cold-start');

      for (let i = 0; i < 7; i++) {
        await orchestrator.executeTask(makeInput());
      }

      const calibrated = [0, 1, 2, 3].map((level) => predictor.predict(signature, level));
      const usable = calibrated.filter((p) => p.basis === 'ema-calibrated');
      expect(usable.length).toBeGreaterThan(0);
      expect(usable[0]!.confidence).toBeGreaterThan(0.1);
      expect(usable[0]!.predicted_usd).toBeGreaterThan(0);
    },
    { timeout: 180_000 },
  );

  test(
    'dynamic budget allocation actually engages once history exists',
    async () => {
      writeWorkspace({ rate_cards: MOCK_RATE_CARDS });
      const bus = createBus();
      const allocations: Array<{ maxTokens: number; source: string }> = [];
      bus.on('economy:budget_allocated', (p) => allocations.push(p));

      const orchestrator = createOrchestrator({ workspace: tempDir, bus, registry: makeRegistry() });
      for (let i = 0; i < 8; i++) {
        await orchestrator.executeTask(makeInput());
      }

      // The allocator reads `understanding.taskTypeSignature`. That field was
      // never populated by `enrichUnderstanding`, so `allocate()` always took
      // the `!taskTypeSignature` early return and this event never fired —
      // dynamic budgets were a permanent no-op announced by nothing.
      expect(allocations.length).toBeGreaterThan(0);
      expect(allocations.every((a) => a.source !== 'default')).toBe(true);
      // And the no-shrink floor holds end-to-end: cheap history must never
      // hand a later task less budget than its routing level asked for.
      expect(allocations.every((a) => a.maxTokens >= 10_000)).toBe(true);
    },
    { timeout: 180_000 },
  );

  test(
    'a default run refuses nothing and emits no budget pressure',
    async () => {
      writeWorkspace({ rate_cards: MOCK_RATE_CARDS });
      const bus = createBus();
      const intrusive: string[] = [];
      bus.on('task:budget-exceeded', () => intrusive.push('task:budget-exceeded'));
      bus.on('economy:budget_exceeded', () => intrusive.push('economy:budget_exceeded'));
      bus.on('economy:budget_degraded', () => intrusive.push('economy:budget_degraded'));
      bus.on('economy:budget_warning', () => intrusive.push('economy:budget_warning'));

      const orchestrator = createOrchestrator({ workspace: tempDir, bus, registry: makeRegistry() });
      const result = await orchestrator.executeTask(makeInput());

      expect(result.status).not.toBe('failed');
      expect(intrusive).toHaveLength(0);
      expect(orchestrator.budgetEnforcer!.canProceed().allowed).toBe(true);
    },
    { timeout: 60_000 },
  );

  test(
    'market and federation stay off, and no market auction runs',
    async () => {
      writeWorkspace({ rate_cards: MOCK_RATE_CARDS });
      const bus = createBus();
      const marketEvents: string[] = [];
      bus.on('market:auction_started', () => marketEvents.push('auction_started'));
      bus.on('market:auction_completed', () => marketEvents.push('auction_completed'));
      bus.on('market:phase_transition', () => marketEvents.push('phase_transition'));
      const federationEvents: string[] = [];
      bus.on('economy:federation_cost_broadcast', () => federationEvents.push('broadcast'));

      const orchestrator = createOrchestrator({ workspace: tempDir, bus, registry: makeRegistry() });
      expect(orchestrator.marketScheduler).toBeUndefined();
      expect(orchestrator.federationBudgetPool).toBeUndefined();

      await orchestrator.executeTask(makeInput());

      expect(marketEvents).toHaveLength(0);
      // A cost_recorded event must not fan out to peers when cost sharing is off.
      bus.emit('economy:cost_recorded', {
        taskId: 'synthetic',
        engineId: 'mock/fast',
        computed_usd: 1.23,
        cost_tier: 'billing',
      });
      expect(federationEvents).toHaveLength(0);
    },
    { timeout: 60_000 },
  );

  test(
    'the operator off-switch still turns everything off',
    async () => {
      writeWorkspace({ enabled: false, rate_cards: MOCK_RATE_CARDS });
      const orchestrator = createOrchestrator({ workspace: tempDir, bus: createBus(), registry: makeRegistry() });

      expect(orchestrator.costLedger).toBeUndefined();
      expect(orchestrator.budgetEnforcer).toBeUndefined();
      expect(orchestrator.costPredictor).toBeUndefined();
      expect(orchestrator.dynamicBudgetAllocator).toBeUndefined();

      await orchestrator.executeTask(makeInput());
      expect(costRows()).toHaveLength(0);
    },
    { timeout: 60_000 },
  );
});

describe('BudgetEnforcer at the default setting', () => {
  function seededLedger(): CostLedger {
    const db = new Database(':memory:');
    migration001.up(db);
    const ledger = new CostLedger(db);
    const entry: CostLedgerEntry = {
      id: 'seed:1:1',
      taskId: 'seed',
      workerId: null,
      engineId: 'claude-sonnet-4',
      timestamp: Date.now(),
      tokens_input: 100_000,
      tokens_output: 100_000,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      duration_ms: 1000,
      oracle_invocations: 0,
      computed_usd: 999.0,
      cost_tier: 'billing',
      routing_level: 2,
      task_type_signature: 'seed::ts::single',
    };
    ledger.record(entry);
    return ledger;
  }

  test('warn mode with no caps cannot refuse a task even with spend on the books', () => {
    const enforcer = new BudgetEnforcer({ enforcement: 'warn' }, seededLedger());
    expect(enforcer.checkBudget()).toEqual([]);
    expect(enforcer.canProceed().allowed).toBe(true);
  });

  test('warn mode WITH caps still allows the task once the cap is blown', () => {
    const enforcer = new BudgetEnforcer({ enforcement: 'warn', hourly_usd: 1.0 }, seededLedger());
    const statuses = enforcer.checkBudget();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.exceeded).toBe(true);
    expect(enforcer.canProceed().allowed).toBe(true);
  });
});
