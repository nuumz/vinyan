/**
 * Memory Wiki — α.1 content-only source ID.
 *
 * Pins the post-α dedupe semantics: `deriveSourceId(kind, contentHash)`
 * is pure content-addressed. Two ingestions of byte-identical bodies
 * for the same kind produce the SAME source id and thus dedupe via
 * `getSourceById` short-circuit.
 *
 * Inverse direction (createdAt mixed into id, two rows per re-ingest)
 * was the L4 evidence finding from the live walkthrough — that branch
 * fails this test.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migration001 } from '../../../src/db/migrations/001_initial_schema.ts';
import { MigrationRunner } from '../../../src/db/migrations/migration-runner.ts';
import { MemoryWikiIngestor } from '../../../src/memory/wiki/ingest.ts';
import { PageWriter } from '../../../src/memory/wiki/page-writer.ts';
import { deriveSourceId } from '../../../src/memory/wiki/schema.ts';
import { MemoryWikiStore } from '../../../src/memory/wiki/store.ts';

function freshDb(): Database {
  const db = new Database(':memory:');
  new MigrationRunner().migrate(db, [migration001]);
  return db;
}

describe('deriveSourceId — content-only', () => {
  test('same (kind, contentHash) ⇒ same id, regardless of legacy time arg', () => {
    const a = deriveSourceId('session', 'abc');
    const b = deriveSourceId('session', 'abc');
    const c = deriveSourceId('session', 'abc', 1_700_000_000_000);
    const d = deriveSourceId('session', 'abc', 1_700_000_000_001);
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a).toBe(d);
  });

  test('different kinds ⇒ different ids (kind is part of the address)', () => {
    expect(deriveSourceId('session', 'abc')).not.toBe(deriveSourceId('trace', 'abc'));
  });

  test('different content ⇒ different ids', () => {
    expect(deriveSourceId('session', 'abc')).not.toBe(deriveSourceId('session', 'abd'));
  });
});

describe('ingestor.ingestSession — content-only dedupe', () => {
  test('two ingests of byte-identical body collapse to ONE source row', () => {
    const db = freshDb();
    let now = 1_700_000_000_000;
    const clock = () => now;
    const store = new MemoryWikiStore(db, { clock });
    const writer = new PageWriter({ store, clock });
    const ingestor = new MemoryWikiIngestor({ store, writer, clock });

    const body = '# Note\n\nIdempotent content';
    ingestor.ingestSession({
      profile: 'default',
      sessionId: 's-1',
      summaryMarkdown: body,
    });
    now += 5_000; // wall clock advances; with content-only id, dedupe still fires.
    ingestor.ingestSession({
      profile: 'default',
      sessionId: 's-1',
      summaryMarkdown: body,
    });

    const count = (db
      .query('SELECT COUNT(*) as c FROM memory_wiki_sources WHERE session_id = ?')
      .get('s-1') as { c: number } | null)?.c;
    expect(count).toBe(1);
  });

  test('mutated body ⇒ NEW source row; OLD row retained (append-only audit)', () => {
    const db = freshDb();
    let now = 1_700_000_000_000;
    const clock = () => now;
    const store = new MemoryWikiStore(db, { clock });
    const writer = new PageWriter({ store, clock });
    const ingestor = new MemoryWikiIngestor({ store, writer, clock });

    ingestor.ingestSession({
      profile: 'default',
      sessionId: 's-2',
      summaryMarkdown: '# original\n\nbody',
    });
    now += 5_000;
    ingestor.ingestSession({
      profile: 'default',
      sessionId: 's-2',
      summaryMarkdown: '# original\n\nbody — extended',
    });

    const rows = db
      .query('SELECT body FROM memory_wiki_sources WHERE session_id = ? ORDER BY created_at')
      .all('s-2') as Array<{ body: string }>;
    expect(rows.length).toBe(2);
    expect(rows[0]?.body).toContain('body');
    expect(rows[1]?.body).toContain('extended');
  });
});
