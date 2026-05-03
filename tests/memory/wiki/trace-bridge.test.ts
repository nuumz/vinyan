/**
 * Memory Wiki — trace bridge contract.
 *
 * Pins the gate semantics + ingestion path: `task:complete` events
 * with high-signal outcomes (non-success / L2+ / predictionError) are
 * fed to `ingestor.ingestTrace`; routine L0/L1 successes are skipped.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createBus } from '../../../src/core/bus.ts';
import { migration001 } from '../../../src/db/migrations/001_initial_schema.ts';
import { MigrationRunner } from '../../../src/db/migrations/migration-runner.ts';
import { MemoryWikiIngestor } from '../../../src/memory/wiki/ingest.ts';
import { PageWriter } from '../../../src/memory/wiki/page-writer.ts';
import { MemoryWikiStore } from '../../../src/memory/wiki/store.ts';
import {
  attachTraceBridge,
  buildTraceSummaryMarkdown,
  defaultTraceGate,
} from '../../../src/memory/wiki/trace-bridge.ts';
import type { ExecutionTrace, TaskResult } from '../../../src/orchestrator/types.ts';

function freshDb(): Database {
  const db = new Database(':memory:');
  new MigrationRunner().migrate(db, [migration001]);
  return db;
}

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: 'trace-1',
    taskId: 't-1',
    timestamp: 1_700_000_000_000,
    routingLevel: 0,
    approach: 'baseline',
    oracleVerdicts: { ast: true },
    modelUsed: 'fast',
    tokensConsumed: 100,
    durationMs: 50,
    outcome: 'success',
    affectedFiles: [],
    ...overrides,
  } as ExecutionTrace;
}

function makeResult(overrides: Partial<TaskResult> = {}, traceOverrides: Partial<ExecutionTrace> = {}): TaskResult {
  return {
    id: 't-1',
    status: 'completed',
    mutations: [],
    trace: makeTrace(traceOverrides),
    ...overrides,
  } as TaskResult;
}

describe('defaultTraceGate', () => {
  test('skips routine L0/L1 success', () => {
    expect(defaultTraceGate(makeResult())).toBe('skip');
  });
  test('ingests on non-success outcome', () => {
    expect(defaultTraceGate(makeResult({ status: 'failed' }))).toBe('ingest');
    expect(defaultTraceGate(makeResult({ status: 'escalated' }))).toBe('ingest');
    expect(defaultTraceGate(makeResult({ status: 'partial' }))).toBe('ingest');
  });
  test('ingests on L2+ even when successful', () => {
    expect(
      defaultTraceGate(makeResult({}, { routingLevel: 2 as ExecutionTrace['routingLevel'] })),
    ).toBe('ingest');
  });
  test('ingests on prediction error', () => {
    expect(
      defaultTraceGate(
        makeResult(
          {},
          {
            predictionError: {
              claimed: true,
              actual: false,
              reason: 'oracle disagreed',
            } as unknown as ExecutionTrace['predictionError'],
          },
        ),
      ),
    ).toBe('ingest');
  });
});

describe('attachTraceBridge', () => {
  test('high-signal task:complete drives an ingestSource → memory_wiki_sources row', () => {
    const db = freshDb();
    const clock = () => 1_700_000_000_000;
    const store = new MemoryWikiStore(db, { clock });
    const writer = new PageWriter({ store, clock });
    const ingestor = new MemoryWikiIngestor({ store, writer, clock });
    const bus = createBus();
    const bridge = attachTraceBridge({
      bus,
      ingestor,
      defaultProfile: 'default',
      dispatcher: (fn) => fn(),
    });

    bus.emit('task:complete', { result: makeResult({ status: 'failed' }) });

    const c = (db
      .query("SELECT COUNT(*) as c FROM memory_wiki_sources WHERE kind = 'trace'")
      .get() as { c: number } | null)?.c;
    expect(c).toBe(1);
    bridge.off();
  });

  test('low-signal task:complete is dropped', () => {
    const db = freshDb();
    const clock = () => 1_700_000_000_000;
    const store = new MemoryWikiStore(db, { clock });
    const writer = new PageWriter({ store, clock });
    const ingestor = new MemoryWikiIngestor({ store, writer, clock });
    const bus = createBus();
    const bridge = attachTraceBridge({
      bus,
      ingestor,
      defaultProfile: 'default',
      dispatcher: (fn) => fn(),
    });

    bus.emit('task:complete', { result: makeResult() }); // L0 success

    const c = (db
      .query("SELECT COUNT(*) as c FROM memory_wiki_sources WHERE kind = 'trace'")
      .get() as { c: number } | null)?.c;
    expect(c).toBe(0);
    bridge.off();
  });

  test('off() unsubscribes; subsequent emits ignored', () => {
    const db = freshDb();
    const clock = () => 1_700_000_000_000;
    const store = new MemoryWikiStore(db, { clock });
    const writer = new PageWriter({ store, clock });
    const ingestor = new MemoryWikiIngestor({ store, writer, clock });
    const bus = createBus();
    const bridge = attachTraceBridge({
      bus,
      ingestor,
      defaultProfile: 'default',
      dispatcher: (fn) => fn(),
    });
    bridge.off();
    bus.emit('task:complete', { result: makeResult({ status: 'failed' }) });
    const c = (db
      .query("SELECT COUNT(*) as c FROM memory_wiki_sources WHERE kind = 'trace'")
      .get() as { c: number } | null)?.c;
    expect(c).toBe(0);
  });

  test('ingestor exception routed through onError, not propagated', () => {
    const failingIngestor = {
      ingestTrace() {
        throw new Error('boom');
      },
    } as unknown as MemoryWikiIngestor;
    const errors: unknown[] = [];
    const bus = createBus();
    const bridge = attachTraceBridge({
      bus,
      ingestor: failingIngestor,
      defaultProfile: 'default',
      dispatcher: (fn) => fn(),
      onError: (_id, err) => errors.push(err),
    });
    expect(() =>
      bus.emit('task:complete', { result: makeResult({ status: 'failed' }) }),
    ).not.toThrow();
    expect(errors.length).toBe(1);
    bridge.off();
  });
});

describe('buildTraceSummaryMarkdown', () => {
  test('renders status, routing, oracle verdicts, prediction error, escalation', () => {
    const md = buildTraceSummaryMarkdown(
      makeResult(
        { status: 'escalated', escalationReason: 'L1 oracle disagreed' },
        {
          routingLevel: 1,
          oracleVerdicts: { ast: true, type: false },
          predictionError: {
            claimed: true,
            actual: false,
            reason: 'verifier flipped',
          } as unknown as ExecutionTrace['predictionError'],
        },
      ),
    );
    expect(md).toContain('Task t-1 — escalated');
    expect(md).toContain('**Routing**: L1');
    expect(md).toContain('Oracle verdicts (2)');
    expect(md).toContain('`type` → fail');
    expect(md).toContain('Prediction error (A7)');
    expect(md).toContain('verifier flipped');
    expect(md).toContain('L1 oracle disagreed');
  });
});
