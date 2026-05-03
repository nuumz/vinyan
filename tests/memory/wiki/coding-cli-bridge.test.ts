/**
 * Memory Wiki — coding-cli bridge contract.
 *
 * Pins terminal-event ingestion: `coding-cli:completed` and
 * `coding-cli:failed` produce `coding-cli-run` source rows with
 * structured markdown.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createBus } from '../../../src/core/bus.ts';
import { migration001 } from '../../../src/db/migrations/001_initial_schema.ts';
import { MigrationRunner } from '../../../src/db/migrations/migration-runner.ts';
import {
  attachCodingCliBridge,
  renderCompletedMarkdown,
  renderFailedMarkdown,
} from '../../../src/memory/wiki/coding-cli-bridge.ts';
import { MemoryWikiIngestor } from '../../../src/memory/wiki/ingest.ts';
import { PageWriter } from '../../../src/memory/wiki/page-writer.ts';
import { MemoryWikiStore } from '../../../src/memory/wiki/store.ts';
import type {
  CodingCliCompletedEvent,
  CodingCliFailedEvent,
} from '../../../src/orchestrator/external-coding-cli/types.ts';

function freshDb(): Database {
  const db = new Database(':memory:');
  new MigrationRunner().migrate(db, [migration001]);
  return db;
}

function makeCompleted(overrides: Partial<CodingCliCompletedEvent> = {}): CodingCliCompletedEvent {
  return {
    taskId: 'task-cc-1',
    sessionId: 'sess-1',
    codingCliSessionId: 'cc-internal-1',
    providerId: 'claude-code',
    state: 'completed',
    ts: 1_700_000_000_000,
    finalStatus: 'completed',
    summary: 'Edited src/foo.ts and ran tests; all green.',
    ...overrides,
  };
}

function makeFailed(overrides: Partial<CodingCliFailedEvent> = {}): CodingCliFailedEvent {
  return {
    taskId: 'task-cc-2',
    sessionId: 'sess-2',
    codingCliSessionId: 'cc-internal-2',
    providerId: 'github-copilot',
    state: 'failed',
    ts: 1_700_000_000_000,
    reason: 'CLI exited with code 137 (likely OOM)',
    errorClass: 'cli_crash',
    ...overrides,
  };
}

function fixture() {
  const db = freshDb();
  const clock = () => 1_700_000_000_000;
  const store = new MemoryWikiStore(db, { clock });
  const writer = new PageWriter({ store, clock });
  const ingestor = new MemoryWikiIngestor({ store, writer, clock });
  const bus = createBus();
  return { db, store, writer, ingestor, bus };
}

describe('attachCodingCliBridge', () => {
  test('completed event ⇒ coding-cli-run source persists', () => {
    const fx = fixture();
    const bridge = attachCodingCliBridge({
      bus: fx.bus,
      ingestor: fx.ingestor,
      defaultProfile: 'default',
      dispatcher: (fn) => fn(),
    });
    fx.bus.emit('coding-cli:completed', makeCompleted());
    const c = (fx.db
      .query("SELECT COUNT(*) as c FROM memory_wiki_sources WHERE kind = 'coding-cli-run'")
      .get() as { c: number } | null)?.c;
    expect(c).toBe(1);
    bridge.off();
  });

  test('failed event ⇒ coding-cli-run source with errorClass metadata', () => {
    const fx = fixture();
    const bridge = attachCodingCliBridge({
      bus: fx.bus,
      ingestor: fx.ingestor,
      defaultProfile: 'default',
      dispatcher: (fn) => fn(),
    });
    fx.bus.emit('coding-cli:failed', makeFailed());
    const row = fx.db
      .query("SELECT body, metadata_json FROM memory_wiki_sources WHERE kind = 'coding-cli-run' LIMIT 1")
      .get() as { body: string; metadata_json: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.body).toContain('FAILED');
    expect(row?.body).toContain('cli_crash');
    expect(row?.metadata_json).toContain('cli_crash');
    bridge.off();
  });

  test('off() unsubscribes both events', () => {
    const fx = fixture();
    const bridge = attachCodingCliBridge({
      bus: fx.bus,
      ingestor: fx.ingestor,
      defaultProfile: 'default',
      dispatcher: (fn) => fn(),
    });
    bridge.off();
    fx.bus.emit('coding-cli:completed', makeCompleted());
    fx.bus.emit('coding-cli:failed', makeFailed());
    const c = (fx.db
      .query("SELECT COUNT(*) as c FROM memory_wiki_sources")
      .get() as { c: number } | null)?.c;
    expect(c).toBe(0);
  });
});

describe('coding-cli markdown renderers', () => {
  test('completed renders provider, sessions, summary', () => {
    const md = renderCompletedMarkdown(makeCompleted({ summary: 'edited foo' }));
    expect(md).toContain('# Coding CLI Run — task task-cc-1 (completed)');
    expect(md).toContain('**Provider**: claude-code');
    expect(md).toContain('## Summary');
    expect(md).toContain('edited foo');
  });

  test('failed renders error class + reason', () => {
    const md = renderFailedMarkdown(makeFailed());
    expect(md).toContain('# Coding CLI Run — task task-cc-2 (FAILED)');
    expect(md).toContain('**Error class**: cli_crash');
    expect(md).toContain('## Reason');
    expect(md).toContain('OOM');
  });
});
