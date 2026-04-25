import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migration010 } from '../../src/db/migrations/010_commonsense_rules.ts';
import { CommonSenseRegistry } from '../../src/oracle/commonsense/registry.ts';
import {
  promoteAllPatterns,
  promotePatternToCommonsense,
  walkForwardBacktest,
} from '../../src/sleep-cycle/promotion.ts';
import type { ExecutionTrace, ExtractedPattern, RoutingLevel } from '../../src/orchestrator/types.ts';

let registry: CommonSenseRegistry;

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL);`);
  migration010.up(db);
  registry = new CommonSenseRegistry(db);
});

function makePattern(overrides: Partial<ExtractedPattern> = {}): ExtractedPattern {
  return {
    id: 'p1',
    type: 'anti-pattern',
    description: 'destructive on test files',
    frequency: 35,
    confidence: 0.97,
    taskTypeSignature: 'delete::ts::large-blast',
    approach: 'rm -rf tests/',
    sourceTraceIds: ['t1', 't2'],
    createdAt: Date.now(),
    decayWeight: 1.0,
    ...overrides,
  };
}

function makeTrace(overrides: Partial<ExecutionTrace>): ExecutionTrace {
  return {
    id: 'tr1',
    taskId: 'task1',
    timestamp: 1000,
    routingLevel: 1 as RoutingLevel,
    approach: 'rm -rf tests/',
    taskTypeSignature: 'delete::ts::large-blast',
    oracleVerdicts: { ast: false },
    modelUsed: 'claude-haiku',
    tokensConsumed: 100,
    durationMs: 500,
    outcome: 'failure',
    affectedFiles: ['tests/foo.ts'],
    ...overrides,
  };
}

function makeFailingTraces(count: number, taskTypeSignature: string, startTs = 1000): ExecutionTrace[] {
  return Array.from({ length: count }, (_, i) =>
    makeTrace({ id: `tr${i}`, timestamp: startTs + i * 100, taskTypeSignature, outcome: 'failure' }),
  );
}

function makeSuccessfulTraces(count: number, taskTypeSignature: string, startTs = 1000): ExecutionTrace[] {
  return Array.from({ length: count }, (_, i) =>
    makeTrace({ id: `tr${i}`, timestamp: startTs + i * 100, taskTypeSignature, outcome: 'success' }),
  );
}

describe('walkForwardBacktest', () => {
  test('returns 0 passing when traces too few', () => {
    const result = walkForwardBacktest(makePattern(), [], 5);
    expect(result.passingWindows).toBe(0);
    expect(result.total).toBe(5);
  });

  test('anti-pattern: all-failure traces → all windows pass', () => {
    const traces = makeFailingTraces(20, 'delete::ts::large-blast');
    const result = walkForwardBacktest(makePattern(), traces, 5);
    expect(result.passingWindows).toBe(5);
    expect(result.total).toBe(5);
  });

  test('anti-pattern: all-success traces → no windows pass', () => {
    const traces = makeSuccessfulTraces(20, 'delete::ts::large-blast');
    const result = walkForwardBacktest(makePattern(), traces, 5);
    expect(result.passingWindows).toBe(0);
  });

  test('success-pattern: all-success traces → all windows pass', () => {
    const traces = makeSuccessfulTraces(20, 'delete::ts::large-blast');
    const result = walkForwardBacktest(
      makePattern({ type: 'success-pattern' }),
      traces,
      5,
    );
    expect(result.passingWindows).toBe(5);
  });

  test('only counts traces matching pattern signature', () => {
    const matching = makeFailingTraces(15, 'delete::ts::large-blast');
    const noise = makeSuccessfulTraces(50, 'add::py::small'); // different signature
    const result = walkForwardBacktest(makePattern(), [...matching, ...noise], 5);
    // Should pass — the matching traces all fail, noise is filtered
    expect(result.passingWindows).toBeGreaterThanOrEqual(4);
  });
});

describe('promotePatternToCommonsense — gates', () => {
  test('rejects worker-performance type', () => {
    const result = promotePatternToCommonsense(
      makePattern({ type: 'worker-performance' }),
      { registry, traces: makeFailingTraces(20, 'delete::ts::large-blast') },
    );
    expect(result.promoted).toBe(false);
    expect(result.reason).toContain('not eligible');
  });

  test('rejects when frequency < minObservations', () => {
    const result = promotePatternToCommonsense(
      makePattern({ frequency: 10 }),
      { registry, traces: makeFailingTraces(20, 'delete::ts::large-blast') },
    );
    expect(result.promoted).toBe(false);
    expect(result.reason).toMatch(/frequency .* < 30/);
  });

  test('rejects when Wilson LB below threshold', () => {
    const result = promotePatternToCommonsense(
      makePattern({ confidence: 0.85 }),
      { registry, traces: makeFailingTraces(20, 'delete::ts::large-blast') },
    );
    expect(result.promoted).toBe(false);
    expect(result.reason).toMatch(/Wilson LB .* < 0.95/);
  });

  test('rejects when walk-forward fails', () => {
    // Wilson LB high in pattern, but traces are mixed → walk-forward fails
    const traces = makeSuccessfulTraces(20, 'delete::ts::large-blast');
    const result = promotePatternToCommonsense(makePattern(), { registry, traces });
    expect(result.promoted).toBe(false);
    expect(result.reason).toMatch(/walk-forward/);
  });

  test('rejects when approach is unparseable', () => {
    const result = promotePatternToCommonsense(
      makePattern({ approach: '' }),
      { registry, traces: makeFailingTraces(20, 'delete::ts::large-blast') },
    );
    expect(result.promoted).toBe(false);
    expect(result.reason).toContain('matcher inferable');
  });

  test('promotes when all gates pass', () => {
    const traces = makeFailingTraces(25, 'delete::ts::large-blast');
    const result = promotePatternToCommonsense(makePattern(), { registry, traces });
    expect(result.promoted).toBe(true);
    expect(result.rule).toBeDefined();
    expect(result.rule!.source).toBe('promoted-from-pattern');
    expect(result.rule!.promoted_from_pattern_id).toBe('p1');
  });
});

describe('promotePatternToCommonsense — rule shape', () => {
  test('anti-pattern → escalate outcome', () => {
    const traces = makeFailingTraces(25, 'delete::ts::large-blast');
    const result = promotePatternToCommonsense(makePattern(), { registry, traces });
    expect(result.rule!.default_outcome).toBe('escalate');
  });

  test('success-pattern → allow outcome', () => {
    const traces = makeSuccessfulTraces(25, 'add::py::medium');
    const result = promotePatternToCommonsense(
      makePattern({
        type: 'success-pattern',
        taskTypeSignature: 'add::py::medium',
        approach: 'pytest --cov',
      }),
      { registry, traces },
    );
    expect(result.promoted).toBe(true);
    expect(result.rule!.default_outcome).toBe('allow');
  });

  test('confidence clamped to pragmatic band [0.5, 0.7]', () => {
    const traces = makeFailingTraces(25, 'delete::ts::large-blast');
    const result = promotePatternToCommonsense(
      makePattern({ confidence: 0.99 }), // very confident pattern
      { registry, traces },
    );
    expect(result.rule!.confidence).toBeLessThanOrEqual(0.7);
    expect(result.rule!.confidence).toBeGreaterThanOrEqual(0.5);
  });

  test('priority within [30, 70] (registry cap)', () => {
    const traces = makeFailingTraces(25, 'delete::ts::large-blast');
    const result = promotePatternToCommonsense(makePattern(), { registry, traces });
    expect(result.rule!.priority).toBeGreaterThanOrEqual(30);
    expect(result.rule!.priority).toBeLessThanOrEqual(70);
  });

  test('microtheory inferred from task signature', () => {
    const traces = makeFailingTraces(25, 'delete::ts::large-blast');
    const result = promotePatternToCommonsense(makePattern(), { registry, traces });
    expect(result.rule!.microtheory).toEqual({
      language: 'typescript-strict',
      domain: 'universal',
      action: 'mutation-destructive',
    });
  });

  test('rule pattern matcher derived from approach', () => {
    const traces = makeFailingTraces(25, 'delete::ts::large-blast');
    const result = promotePatternToCommonsense(
      makePattern({ approach: 'rm -rf tests/' }),
      { registry, traces },
    );
    expect(result.rule!.pattern.kind).toBe('literal-substring');
    if (result.rule!.pattern.kind === 'literal-substring') {
      expect(result.rule!.pattern.needle).toBe('rm -rf tests/');
    }
  });

  test('promoted rule queryable via registry findApplicable', () => {
    const traces = makeFailingTraces(25, 'delete::ts::large-blast');
    promotePatternToCommonsense(makePattern(), { registry, traces });
    const hits = registry.findApplicable({
      language: 'typescript-strict',
      domain: 'universal',
      action: 'mutation-destructive',
    });
    expect(hits.length).toBe(1);
    expect(hits[0]?.source).toBe('promoted-from-pattern');
  });

  test('idempotent: same pattern promoted twice → same rule id', () => {
    const traces = makeFailingTraces(25, 'delete::ts::large-blast');
    const r1 = promotePatternToCommonsense(makePattern(), { registry, traces });
    const r2 = promotePatternToCommonsense(makePattern(), { registry, traces });
    expect(r1.rule!.id).toBe(r2.rule!.id);
    expect(registry.count()).toBe(1);
  });
});

describe('promoteAllPatterns', () => {
  test('processes all patterns and returns per-pattern results', () => {
    const traces = makeFailingTraces(25, 'delete::ts::large-blast');
    const patterns = [
      makePattern({ id: 'p1' }),
      makePattern({ id: 'p2', frequency: 10 }), // fails frequency gate
      makePattern({
        id: 'p3',
        type: 'worker-performance', // fails eligibility gate
      }),
    ];
    const results = promoteAllPatterns(patterns, { registry, traces });
    expect(results.length).toBe(3);
    expect(results[0]?.promoted).toBe(true);
    expect(results[1]?.promoted).toBe(false);
    expect(results[2]?.promoted).toBe(false);
  });
});
