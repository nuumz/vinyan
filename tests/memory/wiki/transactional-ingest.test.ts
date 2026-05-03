/**
 * Memory Wiki — α.2 transactional ingest.
 *
 * Pins the post-α atomicity: `ingestor.ingestSession` (and siblings)
 * wrap `persistSource + writeProposals` in a SQLite transaction via
 * `MemoryWikiStore.transaction`. A page-writer exception rolls back
 * the source row insert.
 *
 * Inverse direction (non-transactional, source row commits even when
 * page write throws) was the L5 partial-failure finding — orphan
 * source rows. That branch fails this test.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migration001 } from '../../../src/db/migrations/001_initial_schema.ts';
import { MigrationRunner } from '../../../src/db/migrations/migration-runner.ts';
import { MemoryWikiIngestor } from '../../../src/memory/wiki/ingest.ts';
import type { PageWriter } from '../../../src/memory/wiki/page-writer.ts';
import { MemoryWikiStore } from '../../../src/memory/wiki/store.ts';
import type { WikiPageProposal } from '../../../src/memory/wiki/types.ts';

function freshDb(): Database {
  const db = new Database(':memory:');
  new MigrationRunner().migrate(db, [migration001]);
  return db;
}

describe('transactional ingest — α.2', () => {
  test('page-writer throw rolls back source row insert (no orphan)', () => {
    const db = freshDb();
    const clock = () => 1_700_000_000_000;
    const store = new MemoryWikiStore(db, { clock });
    const failingWriter = {
      write: (_p: WikiPageProposal) => {
        throw new Error('simulated page-writer failure');
      },
    } as unknown as PageWriter;
    const ingestor = new MemoryWikiIngestor({ store, writer: failingWriter, clock });

    expect(() =>
      ingestor.ingestSession({
        profile: 'default',
        sessionId: 's-rollback',
        summaryMarkdown:
          '# decision section\n\nWe chose strategy A because it is safer. Strategy B failed.',
      }),
    ).toThrow('simulated page-writer failure');

    const sources = (db
      .query('SELECT COUNT(*) as c FROM memory_wiki_sources')
      .get() as { c: number } | null)?.c;
    const pages = (db.query('SELECT COUNT(*) as c FROM memory_wiki_pages').get() as
      | { c: number }
      | null)?.c;
    // Both rolled back — no source, no pages.
    expect(sources).toBe(0);
    expect(pages).toBe(0);
  });

  test('store.transaction commits when callback returns, rolls back on throw', () => {
    const db = freshDb();
    const store = new MemoryWikiStore(db, { clock: () => 0 });

    // Successful transaction commits.
    const got = store.transaction(() => {
      store.appendOperation({ op: 'ingest', actor: 'test' });
      return 42;
    });
    expect(got).toBe(42);
    expect(
      (db
        .query('SELECT COUNT(*) as c FROM memory_wiki_operations')
        .get() as { c: number } | null)?.c,
    ).toBe(1);

    // Failed transaction rolls back.
    expect(() =>
      store.transaction(() => {
        store.appendOperation({ op: 'ingest', actor: 'test' });
        throw new Error('rollback me');
      }),
    ).toThrow('rollback me');
    expect(
      (db
        .query('SELECT COUNT(*) as c FROM memory_wiki_operations')
        .get() as { c: number } | null)?.c,
    ).toBe(1); // still 1, the second insert rolled back
  });
});
