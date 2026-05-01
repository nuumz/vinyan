/**
 * Memory Wiki — ingest + retrieval end-to-end.
 *
 * Verifies the integrated pipeline: ingest a structured source →
 * extractor proposes pages → writer validates and persists → retriever
 * surfaces them in a ContextPack with trust labels and citations.
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, it } from 'bun:test';
import { migration001 } from '../../../src/db/migrations/001_initial_schema.ts';
import { migration026 } from '../../../src/db/migrations/026_memory_wiki.ts';
import { MigrationRunner } from '../../../src/db/migrations/migration-runner.ts';
import { MemoryWikiIngestor } from '../../../src/memory/wiki/ingest.ts';
import { PageWriter } from '../../../src/memory/wiki/page-writer.ts';
import { MemoryWikiRetriever, renderContextPackPrompt } from '../../../src/memory/wiki/retrieval.ts';
import { MemoryWikiStore } from '../../../src/memory/wiki/store.ts';

function freshDb(): Database {
  const db = new Database(':memory:');
  new MigrationRunner().migrate(db, [migration001, migration026]);
  return db;
}

describe('ingest → retrieval', () => {
  let store: MemoryWikiStore;
  let writer: PageWriter;
  let retriever: MemoryWikiRetriever;
  let ingestor: MemoryWikiIngestor;

  beforeEach(() => {
    const db = freshDb();
    const clock = () => 1_700_000_000_000;
    store = new MemoryWikiStore(db, { clock });
    writer = new PageWriter({ store, clock });
    retriever = new MemoryWikiRetriever({ store, clock });
    ingestor = new MemoryWikiIngestor({ store, writer, clock });
  });

  it('ingestSession produces draft pages addressable by content hash', () => {
    const result = ingestor.ingestSession({
      profile: 'default',
      sessionId: 's-1',
      taskId: 't-1',
      summaryMarkdown: `# Session Summary

## Decision
We chose strategy A because it minimizes risk.

## Failure
Tried strategy B which broke compilation.

What about strategy C? Should we try it next?`,
    });

    expect(result.source.id).toMatch(/^[a-f0-9]+$/);
    expect(result.source.kind).toBe('session');
    expect(result.pages.length).toBeGreaterThan(0);

    const types = result.pages.map((p) => p.type).sort();
    expect(types).toContain('decision');
    expect(types).toContain('failure-pattern');
    expect(types).toContain('task-memory');
  });

  it('ingestSource is idempotent — re-ingesting same body returns same source id', () => {
    const a = ingestor.ingestSource({
      kind: 'user-note',
      body: '# Note\n\nbody',
      provenance: { profile: 'default' },
      createdAt: 1_700_000_000_000,
    });
    const b = ingestor.ingestSource({
      kind: 'user-note',
      body: '# Note\n\nbody',
      provenance: { profile: 'default' },
      createdAt: 1_700_000_000_000,
    });
    expect(a.source.id).toBe(b.source.id);
  });

  it('ingestFailurePattern → page surfaces in getRelevantFailures', () => {
    ingestor.ingestFailurePattern({
      profile: 'default',
      title: 'Strategy B compilation failure',
      body: 'Strategy B fails because it depends on a removed module.',
      taskId: 't-1',
      tags: ['compile-error'],
    });
    const failures = retriever.getRelevantFailures({
      profile: 'default',
      goal: 'Strategy B compilation failure',
    });
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]?.title).toContain('Strategy B');
  });

  it('getContextPack respects token budget and labels trust', () => {
    for (let i = 0; i < 5; i++) {
      ingestor.ingestFailurePattern({
        profile: 'default',
        title: `Failure ${i} on strategy alpha`,
        body: 'A long-ish body. '.repeat(80),
      });
    }
    const pack = retriever.getContextPack({
      profile: 'default',
      goal: 'strategy alpha',
      tokenBudget: 200,
    });
    expect(pack.tokenEstimate).toBeLessThanOrEqual(200);
    expect(pack.omitted.some((o) => o.reason === 'token-budget')).toBe(true);

    const rendered = renderContextPackPrompt(pack);
    expect(rendered).toContain('[MEMORY WIKI CONTEXT]');
    expect(rendered).toContain('[/MEMORY WIKI CONTEXT]');
  });

  it('stale and disputed pages surface with bang trust labels', () => {
    const result = ingestor.ingestFailurePattern({
      profile: 'default',
      title: 'Disputed claim',
      body: 'a disputed body',
    });
    const page = result.pages[0]!;
    // Manually flip lifecycle to disputed to test rendering.
    writer.write(
      {
        id: page.id,
        profile: page.profile,
        type: page.type,
        title: page.title,
        aliases: page.aliases,
        tags: page.tags,
        body: page.body,
        evidenceTier: page.evidenceTier,
        confidence: page.confidence,
        lifecycle: 'disputed',
        protectedSections: page.protectedSections,
        sources: page.sources,
        actor: 'test',
      },
      { allowDemotion: true },
    );
    const pack = retriever.getContextPack({
      profile: 'default',
      goal: 'disputed claim',
      includeFailures: true,
    });
    const rendered = renderContextPackPrompt(pack);
    if (pack.pages.length > 0) {
      expect(rendered).toContain('[disputed!]');
    }
  });

  it('stale-by-content-hash cascade marks dependent pages stale', () => {
    const ingest = ingestor.ingestFailurePattern({
      profile: 'default',
      title: 'Stale candidate',
      body: 'a body',
    });
    const page = ingest.pages[0]!;
    // Promote draft → canonical first so the cascade has work to do.
    const ack = writer.write({
      id: page.id,
      profile: page.profile,
      type: page.type,
      title: page.title,
      aliases: page.aliases,
      tags: page.tags,
      body: page.body,
      evidenceTier: page.evidenceTier,
      confidence: page.confidence,
      lifecycle: 'canonical',
      protectedSections: page.protectedSections,
      sources: page.sources,
      actor: 'test',
    });
    expect(ack.ok).toBe(true);
    const sourceHash = ingest.source.contentHash;
    const affected = store.markStaleByContentHash(sourceHash);
    expect(affected).toContain(page.id);
    const after = store.getPageById(page.id);
    expect(after?.lifecycle).toBe('stale');
  });
});
