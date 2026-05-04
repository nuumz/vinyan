/**
 * Tests for `PersonaFactCitationsStore` — Phase C1 substrate.
 *
 * Behavior-only: every assertion exercises the public API and verifies
 * the documented contract.
 *
 * Coverage:
 *   - recordCitation: full-field roundtrip + truncation of long claim_excerpt
 *   - composite-PK idempotency (same persona+fact+task+ts → silent dup)
 *   - listForPersona: newest-first + limit + scoped to persona
 *   - listForFact: newest-first across personas
 *   - listForTask: chronological order (ASC), single task scope
 *   - listStaleForPersona: returns ONLY mismatched rows + "latest per fact"
 *     dedup + handles gone-source (currentHash → undefined)
 *   - pruneOlderThan: deletes only sub-cutoff rows; returns count
 *   - countForPersona: zero when absent + total across tasks
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { type CurrentHashLookup, PersonaFactCitationsStore } from '../../src/db/persona-fact-citations-store.ts';

describe('PersonaFactCitationsStore', () => {
  let db: Database;
  let store: PersonaFactCitationsStore;

  beforeEach(() => {
    db = new Database(':memory:');
    new MigrationRunner().migrate(db, ALL_MIGRATIONS);
    store = new PersonaFactCitationsStore(db);
  });

  test('listForPersona returns empty when no rows recorded', () => {
    expect(store.listForPersona('researcher')).toEqual([]);
  });

  test('recordCitation persists with full-field roundtrip', () => {
    store.recordCitation({
      personaId: 'researcher',
      factId: 'src/x.ts',
      citedAtHash: 'sha256:aaa',
      taskId: 'task-1',
      phase: 'verify',
      claimExcerpt: 'a short claim',
      citedAtTs: 1000,
    });
    const rows = store.listForPersona('researcher');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      personaId: 'researcher',
      factId: 'src/x.ts',
      citedAtHash: 'sha256:aaa',
      citedAtTs: 1000,
      taskId: 'task-1',
      phase: 'verify',
      claimExcerpt: 'a short claim',
    });
  });

  test('claim_excerpt longer than 256 chars is truncated deterministically', () => {
    const longClaim = 'A'.repeat(500);
    store.recordCitation({
      personaId: 'p',
      factId: 'f',
      citedAtHash: 'h',
      taskId: 't',
      phase: 'verify',
      claimExcerpt: longClaim,
      citedAtTs: 1000,
    });
    const row = store.listForPersona('p')[0];
    expect(row?.claimExcerpt).toHaveLength(256);
    expect(row?.claimExcerpt).toBe('A'.repeat(256));
  });

  test('idempotent on (persona, fact, task, cited_at_ts) — duplicate insert silently dropped', () => {
    const input = {
      personaId: 'p',
      factId: 'f',
      citedAtHash: 'h',
      taskId: 't',
      phase: 'verify',
      claimExcerpt: 'x',
      citedAtTs: 1000,
    };
    store.recordCitation(input);
    store.recordCitation(input);
    expect(store.listForPersona('p')).toHaveLength(1);
  });

  test('listForPersona returns rows newest-first, scoped to persona', () => {
    store.recordCitation({
      personaId: 'researcher',
      factId: 'a',
      citedAtHash: 'h',
      taskId: 't1',
      phase: 'verify',
      claimExcerpt: 'first',
      citedAtTs: 1000,
    });
    store.recordCitation({
      personaId: 'researcher',
      factId: 'b',
      citedAtHash: 'h',
      taskId: 't2',
      phase: 'verify',
      claimExcerpt: 'third',
      citedAtTs: 3000,
    });
    store.recordCitation({
      personaId: 'researcher',
      factId: 'c',
      citedAtHash: 'h',
      taskId: 't3',
      phase: 'verify',
      claimExcerpt: 'second',
      citedAtTs: 2000,
    });
    store.recordCitation({
      personaId: 'developer',
      factId: 'z',
      citedAtHash: 'h',
      taskId: 't9',
      phase: 'verify',
      claimExcerpt: 'other',
      citedAtTs: 5000,
    });
    const rows = store.listForPersona('researcher');
    expect(rows.map((r) => r.factId)).toEqual(['b', 'c', 'a']);
  });

  test('listForPersona honors the limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      store.recordCitation({
        personaId: 'p',
        factId: `f-${i}`,
        citedAtHash: 'h',
        taskId: 't',
        phase: 'verify',
        claimExcerpt: 'x',
        citedAtTs: 1000 + i,
      });
    }
    expect(store.listForPersona('p', 3)).toHaveLength(3);
  });

  test('listForFact returns recent citations of a single fact across personas', () => {
    store.recordCitation({
      personaId: 'p1',
      factId: 'shared',
      citedAtHash: 'h',
      taskId: 't',
      phase: 'verify',
      claimExcerpt: 'x',
      citedAtTs: 1000,
    });
    store.recordCitation({
      personaId: 'p2',
      factId: 'shared',
      citedAtHash: 'h',
      taskId: 't',
      phase: 'verify',
      claimExcerpt: 'x',
      citedAtTs: 3000,
    });
    store.recordCitation({
      personaId: 'p3',
      factId: 'other',
      citedAtHash: 'h',
      taskId: 't',
      phase: 'verify',
      claimExcerpt: 'x',
      citedAtTs: 2000,
    });
    const rows = store.listForFact('shared');
    expect(rows.map((r) => r.personaId)).toEqual(['p2', 'p1']);
  });

  test('listForTask returns rows in chronological order (ASC)', () => {
    store.recordCitation({
      personaId: 'p',
      factId: 'a',
      citedAtHash: 'h',
      taskId: 't',
      phase: 'verify',
      claimExcerpt: 'x',
      citedAtTs: 3000,
    });
    store.recordCitation({
      personaId: 'p',
      factId: 'b',
      citedAtHash: 'h',
      taskId: 't',
      phase: 'verify',
      claimExcerpt: 'x',
      citedAtTs: 1000,
    });
    store.recordCitation({
      personaId: 'p',
      factId: 'c',
      citedAtHash: 'h',
      taskId: 't',
      phase: 'verify',
      claimExcerpt: 'x',
      citedAtTs: 2000,
    });
    const rows = store.listForTask('t');
    expect(rows.map((r) => r.factId)).toEqual(['b', 'c', 'a']);
  });

  test('listStaleForPersona returns only rows whose hash differs from current', () => {
    store.recordCitation({
      personaId: 'p',
      factId: 'src/a.ts',
      citedAtHash: 'h-old',
      taskId: 't',
      phase: 'verify',
      claimExcerpt: 'x',
      citedAtTs: 1000,
    });
    store.recordCitation({
      personaId: 'p',
      factId: 'src/b.ts',
      citedAtHash: 'h-current',
      taskId: 't',
      phase: 'verify',
      claimExcerpt: 'x',
      citedAtTs: 2000,
    });
    const lookup: CurrentHashLookup = (factId) => ({ 'src/a.ts': 'h-NEW', 'src/b.ts': 'h-current' })[factId];
    const stale = store.listStaleForPersona('p', lookup);
    expect(stale).toHaveLength(1);
    expect(stale[0]?.factId).toBe('src/a.ts');
    expect(stale[0]?.citedAtHash).toBe('h-old');
    expect(stale[0]?.currentHash).toBe('h-NEW');
  });

  test('listStaleForPersona dedupes by latest citation per fact', () => {
    // Persona cited the same fact twice with different hashes (file
    // mutated between citations). Only the LATEST belief is what matters
    // for "is the persona's current model stale?"
    store.recordCitation({
      personaId: 'p',
      factId: 'src/a.ts',
      citedAtHash: 'h1',
      taskId: 't1',
      phase: 'verify',
      claimExcerpt: 'first',
      citedAtTs: 1000,
    });
    store.recordCitation({
      personaId: 'p',
      factId: 'src/a.ts',
      citedAtHash: 'h2',
      taskId: 't2',
      phase: 'verify',
      claimExcerpt: 'second',
      citedAtTs: 2000,
    });
    // Current hash matches the LATEST citation (h2) → not stale.
    const stale = store.listStaleForPersona('p', () => 'h2');
    expect(stale).toEqual([]);
    // Current hash matches the OLDER citation only → still stale (latest is h2, not current).
    const stale2 = store.listStaleForPersona('p', () => 'h1');
    expect(stale2).toHaveLength(1);
    expect(stale2[0]?.citedAtHash).toBe('h2');
  });

  test('listStaleForPersona surfaces gone-source (currentHash undefined)', () => {
    store.recordCitation({
      personaId: 'p',
      factId: 'src/deleted.ts',
      citedAtHash: 'h',
      taskId: 't',
      phase: 'verify',
      claimExcerpt: 'x',
      citedAtTs: 1000,
    });
    const stale = store.listStaleForPersona('p', () => undefined);
    expect(stale).toHaveLength(1);
    expect(stale[0]?.currentHash).toBeUndefined();
  });

  test('listStaleForPersona returns nothing when every hash matches', () => {
    store.recordCitation({
      personaId: 'p',
      factId: 'src/a.ts',
      citedAtHash: 'h',
      taskId: 't',
      phase: 'verify',
      claimExcerpt: 'x',
      citedAtTs: 1000,
    });
    expect(store.listStaleForPersona('p', () => 'h')).toEqual([]);
  });

  test('pruneOlderThan deletes only sub-cutoff rows; returns count', () => {
    for (const ts of [1000, 2000, 3000, 4000, 5000]) {
      store.recordCitation({
        personaId: 'p',
        factId: `f-${ts}`,
        citedAtHash: 'h',
        taskId: 't',
        phase: 'verify',
        claimExcerpt: 'x',
        citedAtTs: ts,
      });
    }
    const removed = store.pruneOlderThan(3000);
    expect(removed).toBe(2); // 1000, 2000
    expect(store.listForPersona('p').map((r) => r.citedAtTs)).toEqual([5000, 4000, 3000]);
  });

  test('countForPersona returns 0 for unknown persona', () => {
    expect(store.countForPersona('ghost')).toBe(0);
  });

  test('countForPersona aggregates across tasks', () => {
    for (let i = 0; i < 7; i++) {
      store.recordCitation({
        personaId: 'researcher',
        factId: `f-${i}`,
        citedAtHash: 'h',
        taskId: `t-${i % 3}`,
        phase: 'verify',
        claimExcerpt: 'x',
        citedAtTs: 1000 + i,
      });
    }
    expect(store.countForPersona('researcher')).toBe(7);
  });

  test('pruneSupersededForPersona drops all-but-latest per fact for a persona', () => {
    // Persona 'p' cited fact 'a' three times, fact 'b' once.
    // Persona 'q' cited fact 'a' twice.
    let ts = 1000;
    for (const hash of ['h1', 'h2', 'h3']) {
      store.recordCitation({
        personaId: 'p',
        factId: 'a',
        citedAtHash: hash,
        taskId: `t-${hash}`,
        phase: 'verify',
        claimExcerpt: 'x',
        citedAtTs: ts++,
      });
    }
    store.recordCitation({
      personaId: 'p',
      factId: 'b',
      citedAtHash: 'hb',
      taskId: 'tb',
      phase: 'verify',
      claimExcerpt: 'x',
      citedAtTs: ts++,
    });
    for (const hash of ['qh1', 'qh2']) {
      store.recordCitation({
        personaId: 'q',
        factId: 'a',
        citedAtHash: hash,
        taskId: `q-${hash}`,
        phase: 'verify',
        claimExcerpt: 'x',
        citedAtTs: ts++,
      });
    }

    // Prune 'p' only — 2 of 3 'a' citations dropped, 'b' singleton kept
    expect(store.pruneSupersededForPersona('p')).toBe(2);
    const pCitations = store.listForPersona('p');
    expect(pCitations).toHaveLength(2);
    const pA = pCitations.find((c) => c.factId === 'a');
    expect(pA?.citedAtHash).toBe('h3'); // latest survives

    // 'q' untouched
    expect(store.listForPersona('q')).toHaveLength(2);
  });

  test('pruneSupersededForPersona returns 0 when nothing to dedupe', () => {
    store.recordCitation({
      personaId: 'p',
      factId: 'a',
      citedAtHash: 'h',
      taskId: 't',
      phase: 'verify',
      claimExcerpt: 'x',
      citedAtTs: 1000,
    });
    expect(store.pruneSupersededForPersona('p')).toBe(0);
    expect(store.listForPersona('p')).toHaveLength(1);
  });

  test('pruneSupersededForPersona returns 0 for unknown persona', () => {
    expect(store.pruneSupersededForPersona('ghost')).toBe(0);
  });

  test('default citedAtTs uses the wall clock when omitted', () => {
    store.recordCitation({
      personaId: 'p',
      factId: 'f',
      citedAtHash: 'h',
      taskId: 't',
      phase: 'verify',
      claimExcerpt: 'x',
    });
    expect(store.listForPersona('p')[0]?.citedAtTs).toBeGreaterThan(0);
  });
});
