/**
 * session_search tool — factory + execute envelope tests.
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migration001 } from '../../../src/db/migrations/001_initial_schema.ts';
import { migration003 } from '../../../src/db/migrations/003_memory_records.ts';
import { MigrationRunner } from '../../../src/db/migrations/migration-runner.ts';
import { DefaultMemoryProvider } from '../../../src/memory/provider/default-provider.ts';
import type { MemoryRecord } from '../../../src/memory/provider/types.ts';
import { createSessionSearchTool } from '../../../src/orchestrator/tools/session-search-tool.ts';
import type { ToolContext } from '../../../src/orchestrator/tools/tool-interface.ts';

const NOW = 1_700_000_000_000;

function freshDb(): Database {
  const db = new Database(':memory:');
  const runner = new MigrationRunner();
  runner.migrate(db, [migration001, migration003]);
  return db;
}

function makeContext(): ToolContext {
  return { routingLevel: 1, allowedPaths: [], workspace: '/tmp' };
}

async function seed(db: Database, content: string, overrides: Partial<Omit<MemoryRecord, 'id'>> = {}) {
  const provider = new DefaultMemoryProvider({ db, clock: () => NOW });
  await provider.write({
    profile: 'default',
    kind: 'fact',
    content,
    confidence: 0.7,
    evidenceTier: 'heuristic',
    evidenceChain: [{ kind: 'turn', hash: 'a'.repeat(64), turnId: 't1' }],
    temporalContext: { createdAt: NOW },
    ...overrides,
  });
}

describe('createSessionSearchTool — factory shape', () => {
  test('returns a Tool with session_search metadata', () => {
    const db = freshDb();
    const tool = createSessionSearchTool({ db });
    expect(tool.name).toBe('session_search');
    expect(tool.sideEffect).toBe(false);
    expect(tool.category).toBe('search');
    const desc = tool.descriptor();
    expect(desc.name).toBe('session_search');
    expect(desc.inputSchema.required).toEqual(['query', 'profile']);
  });
});

describe('createSessionSearchTool — execute happy path', () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  test('returns structured hits + renderedText', async () => {
    await seed(db, 'tool envelope keyword apple');
    const tool = createSessionSearchTool({ db, clock: () => NOW });
    const res = await tool.execute(
      { callId: 'c1', query: 'apple', profile: 'default' },
      makeContext(),
    );
    expect(res.status).toBe('success');
    const out = res.output as {
      query: string;
      hits: Array<{ content: string; evidenceTier: string }>;
      totalCandidates: number;
      truncated: boolean;
      renderedText: string;
    };
    expect(out.hits.length).toBe(1);
    expect(out.hits[0]?.content).toContain('apple');
    expect(out.renderedText).toContain('apple');
  });

  test('renderedText summarizes the top 3 hits', async () => {
    for (let i = 0; i < 5; i++) {
      await seed(db, `top keyword hit-${i}`, { temporalContext: { createdAt: NOW + i } });
    }
    const tool = createSessionSearchTool({ db, clock: () => NOW + 100 });
    const res = await tool.execute(
      { callId: 'c1', query: 'top', profile: 'default', limit: 10 },
      makeContext(),
    );
    const out = res.output as { renderedText: string; hits: unknown[] };
    expect(out.hits.length).toBe(5);
    // Rendered text should mention three items (prefixed 1. 2. 3.).
    expect(out.renderedText).toContain('1.');
    expect(out.renderedText).toContain('2.');
    expect(out.renderedText).toContain('3.');
    // But not 4 or 5.
    expect(out.renderedText).not.toContain('4.');
  });
});

describe('createSessionSearchTool — execute error envelope', () => {
  test('missing query returns status=error (not a throw)', async () => {
    const tool = createSessionSearchTool({ db: freshDb() });
    const res = await tool.execute({ callId: 'c1', profile: 'default' }, makeContext());
    expect(res.status).toBe('error');
    expect(res.error).toMatch(/query/);
  });

  test('invalid minTier returns status=error', async () => {
    const tool = createSessionSearchTool({ db: freshDb() });
    const res = await tool.execute(
      { callId: 'c1', query: 'x', profile: 'default', minTier: 'bogus' },
      makeContext(),
    );
    expect(res.status).toBe('error');
    expect(res.error).toMatch(/minTier/);
  });

  test('cross-profile wildcard returns success with empty hits + warning', async () => {
    const db = freshDb();
    await seed(db, 'wildcard keyword');
    const tool = createSessionSearchTool({ db });
    const res = await tool.execute(
      { callId: 'c1', query: 'wildcard', profile: '*' },
      makeContext(),
    );
    // Cross-profile is a "soft" no-op (to mirror provider) — returns success
    // with zero hits and a warning payload.
    expect(res.status).toBe('success');
    const out = res.output as { hits: unknown[]; warning?: string };
    expect(out.hits.length).toBe(0);
    expect(out.warning).toBe('cross_profile_not_allowed');
  });
});
