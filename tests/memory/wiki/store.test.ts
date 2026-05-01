/**
 * MemoryWikiStore — persistence + search behavior.
 *
 * Exercises write/read paths, FTS5 search, tier-aware ranking, alias
 * resolution, edge materialization, and operation log.
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, it } from 'bun:test';
import { migration001 } from '../../../src/db/migrations/001_initial_schema.ts';
import { migration026 } from '../../../src/db/migrations/026_memory_wiki.ts';
import { MigrationRunner } from '../../../src/db/migrations/migration-runner.ts';
import { MemoryWikiStore } from '../../../src/memory/wiki/store.ts';
import type { WikiClaim, WikiEdge, WikiPage, WikiSource } from '../../../src/memory/wiki/types.ts';

function freshDb(): Database {
  const db = new Database(':memory:');
  const runner = new MigrationRunner();
  runner.migrate(db, [migration001, migration026]);
  return db;
}

function makeSource(overrides: Partial<WikiSource> = {}): WikiSource {
  return {
    id: 'src-001',
    kind: 'session',
    contentHash: 'a'.repeat(64),
    createdAt: 1_700_000_000_000,
    provenance: { profile: 'default', sessionId: 's-1' },
    body: '# Sample\n\nbody',
    ...overrides,
  };
}

function makePage(overrides: Partial<WikiPage> = {}): WikiPage {
  return {
    id: 'concept-foo',
    profile: 'default',
    type: 'concept',
    title: 'Foo',
    aliases: ['foo'],
    tags: ['tag1'],
    body: '# Foo\n\nFoo describes [[concept-bar]] precisely.',
    evidenceTier: 'heuristic',
    confidence: 0.7,
    lifecycle: 'draft',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    protectedSections: [],
    bodyHash: 'b'.repeat(64),
    sources: [],
    ...overrides,
  };
}

describe('MemoryWikiStore — sources', () => {
  let store: MemoryWikiStore;
  beforeEach(() => {
    store = new MemoryWikiStore(freshDb(), { clock: () => 1_700_000_000_000 });
  });

  it('inserts and reads back an immutable source', () => {
    const src = makeSource();
    const result = store.insertSourceRecord(src);
    expect(result.created).toBe(true);
    const back = store.getSourceById(src.id);
    expect(back).not.toBeNull();
    expect(back?.contentHash).toBe(src.contentHash);
    expect(back?.kind).toBe('session');
  });

  it('is idempotent — duplicate ids do not change row', () => {
    const src = makeSource();
    expect(store.insertSourceRecord(src).created).toBe(true);
    expect(store.insertSourceRecord({ ...src, body: 'mutated' }).created).toBe(false);
    const back = store.getSourceById(src.id);
    expect(back?.body).toBe(src.body);
  });
});

describe('MemoryWikiStore — pages', () => {
  let store: MemoryWikiStore;
  beforeEach(() => {
    store = new MemoryWikiStore(freshDb(), { clock: () => 1_700_000_000_000 });
  });

  it('upserts and reads back a page', () => {
    const page = makePage();
    const r = store.upsertPage(page);
    expect(r.created).toBe(true);
    const back = store.getPageById(page.id);
    expect(back?.title).toBe('Foo');
    expect(back?.aliases).toEqual(['foo']);
  });

  it('resolves a target by id and by alias', () => {
    store.upsertPage(makePage({ id: 'concept-foo', title: 'Foo', aliases: ['foo', 'FB'] }));
    expect(store.resolveTarget('default', 'concept-foo')).toBe('concept-foo');
    expect(store.resolveTarget('default', 'foo')).toBe('concept-foo');
    expect(store.resolveTarget('default', 'unknown-target')).toBeNull();
  });

  it('search returns hits ranked by composite score', () => {
    store.upsertPage(makePage({ id: 'concept-foo', title: 'Foo', body: 'a quick brown fox jumps' }));
    store.upsertPage(
      makePage({
        id: 'concept-bar',
        title: 'Bar',
        body: 'unrelated content here',
        evidenceTier: 'speculative',
        confidence: 0.4,
      }),
    );
    const hits = store.search('quick brown', { profile: 'default' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.page.id).toBe('concept-foo');
  });
});

describe('MemoryWikiStore — claims & edges', () => {
  let store: MemoryWikiStore;
  beforeEach(() => {
    store = new MemoryWikiStore(freshDb(), { clock: () => 1_700_000_000_000 });
  });

  it('replaces claims atomically', () => {
    const page = makePage();
    store.upsertPage(page);
    const c1: WikiClaim = {
      id: 'claim-1',
      pageId: page.id,
      text: 't',
      sourceIds: ['src-001'],
      evidenceTier: 'heuristic',
      confidence: 0.6,
      createdAt: 1,
    };
    store.replaceClaimsForPage(page.id, [c1]);
    expect(store.getClaims(page.id).length).toBe(1);
    store.replaceClaimsForPage(page.id, []);
    expect(store.getClaims(page.id).length).toBe(0);
  });

  it('replaces edges and supports forward/back queries', () => {
    const page = makePage();
    store.upsertPage(page);
    const edges: WikiEdge[] = [
      {
        fromId: page.id,
        toId: 'concept-bar',
        edgeType: 'mentions',
        confidence: 0.6,
        createdAt: 1,
      },
    ];
    store.replaceEdgesFrom(page.id, edges);
    expect(store.edgesFrom(page.id).length).toBe(1);
    expect(store.edgesTo('concept-bar').length).toBe(1);
  });
});

describe('MemoryWikiStore — operations & lint', () => {
  let store: MemoryWikiStore;
  beforeEach(() => {
    store = new MemoryWikiStore(freshDb(), { clock: () => 1_700_000_000_000 });
  });

  it('appends operations with auto ts and returns id', () => {
    const op = store.appendOperation({
      op: 'write',
      pageId: 'concept-foo',
      actor: 'system:test',
      reason: 'unit',
    });
    expect(op.id).toBeGreaterThan(0);
    expect(op.ts).toBe(1_700_000_000_000);
    expect(store.listOperations({ pageId: 'concept-foo' }).length).toBe(1);
  });

  it('records and resolves lint findings', () => {
    const f = store.recordLintFinding({
      code: 'broken-wikilink',
      severity: 'warn',
      pageId: 'concept-foo',
      detail: 'target X',
    });
    expect(f.id).toBeGreaterThan(0);
    expect(store.listOpenLintFindings().length).toBe(1);
    store.resolveLintFinding(f.id);
    expect(store.listOpenLintFindings().length).toBe(0);
  });
});
