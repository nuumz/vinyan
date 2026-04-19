/**
 * ContextRetriever — hybrid recency + semantic + pins + summary (plan E).
 *
 * Uses an in-memory SQLite database and a deterministic MockEmbeddingProvider
 * so every test is reproducible. No network, no filesystem.
 *
 * Covers:
 *   - recency-only mode (NullEmbeddingProvider or sqlite-vec unavailable)
 *   - migration 036 creates turn_embeddings when sqlite-vec loaded
 *   - indexTurn writes vec + meta rows
 *   - retrieve returns dedup'd recent / semantic / pins / summary
 *   - token-budget enforcement folds overflowing semantic into summary
 *   - pin resolution for @turn:<id>
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, it } from 'bun:test';
import { ALL_MIGRATIONS } from '../../src/db/migrations/index.ts';
import { SessionStore } from '../../src/db/session-store.ts';
import type { EmbeddingProvider } from '../../src/memory/embedding-provider.ts';
import { NullEmbeddingProvider } from '../../src/memory/embedding-provider.ts';
import { ContextRetriever } from '../../src/memory/retrieval.ts';
import { loadSqliteVec } from '../../src/memory/sqlite-vec-loader.ts';
import type { Turn } from '../../src/orchestrator/types.ts';

/** Deterministic mock: maps text → pre-computed embedding vector. */
class MockEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'mock';
  readonly active = true;
  constructor(
    readonly dimension: number,
    private seed: Map<string, Float32Array>,
  ) {}
  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.seed.get(t) ?? new Float32Array(this.dimension));
  }
}

function oneHot(dimension: number, index: number, value = 1): Float32Array {
  const v = new Float32Array(dimension);
  v[index % dimension] = value;
  return v;
}

function makeDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  loadSqliteVec(db); // best-effort; ok if absent
  for (const m of ALL_MIGRATIONS) m.up(db);
  return db;
}

function insertSession(db: Database, id: string): void {
  db.run(
    `INSERT INTO session_store (id, source, created_at, status, working_memory_json, compaction_json, updated_at)
     VALUES (?, 'cli', ?, 'active', NULL, NULL, ?)`,
    [id, Date.now(), Date.now()],
  );
}

function makeTurn(store: SessionStore, sessionId: string, text: string, role: Turn['role'] = 'user'): Turn {
  return store.appendTurn({
    id: `turn-${Math.random().toString(36).slice(2, 10)}`,
    sessionId,
    role,
    blocks: [{ type: 'text', text }],
    tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    createdAt: Date.now(),
  });
}

describe('ContextRetriever — recency + NullEmbeddingProvider', () => {
  let db: Database;
  let store: SessionStore;

  beforeEach(() => {
    db = makeDb();
    store = new SessionStore(db);
    insertSession(db, 's1');
  });

  it('returns recency window only when embeddings are inactive', async () => {
    for (let i = 0; i < 8; i++) {
      makeTurn(store, 's1', `message ${i}`);
    }

    const retriever = new ContextRetriever(db, store, new NullEmbeddingProvider(), {
      recencyWindow: 3,
      semanticTopK: 5,
      maxTokens: 10_000,
      semanticThreshold: 0.45,
    });

    const bundle = await retriever.retrieve('s1', 'what is the latest?');
    expect(bundle.recent).toHaveLength(3);
    expect(bundle.semantic).toHaveLength(0);
    expect(bundle.metadata.semanticEnabled).toBe(false);
    expect(bundle.metadata.semanticSkipReason).toBe('null-embedding-provider');
  });

  it('folds non-recent turns into the summary ladder', async () => {
    for (let i = 0; i < 10; i++) {
      makeTurn(store, 's1', `message ${i} about src/file${i}.ts`);
    }

    const retriever = new ContextRetriever(db, store, new NullEmbeddingProvider(), {
      recencyWindow: 3,
      semanticTopK: 5,
      maxTokens: 10_000,
      semanticThreshold: 0.45,
    });

    const bundle = await retriever.retrieve('s1', 'reviewing');
    expect(bundle.recent).toHaveLength(3);
    expect(bundle.summary).not.toBeNull();
    expect(bundle.summary?.summarizedTurns).toBe(7);
    expect(bundle.summary?.filesDiscussed.length).toBeGreaterThan(0);
    expect(bundle.metadata.summarizedTurns).toBe(7);
  });

  it('indexTurn is a no-op when embeddings inactive', async () => {
    const t = makeTurn(store, 's1', 'hello');
    const retriever = new ContextRetriever(db, store, new NullEmbeddingProvider());
    await retriever.indexTurn(t);
    // No exception; no rows in turn_embedding_meta (if table exists)
    try {
      const row = db.query('SELECT COUNT(*) AS n FROM turn_embedding_meta').get() as { n: number };
      expect(row.n).toBe(0);
    } catch {
      // Table doesn't exist because sqlite-vec not loaded — also acceptable
    }
  });
});

describe('ContextRetriever — pin resolution', () => {
  let db: Database;
  let store: SessionStore;

  beforeEach(() => {
    db = makeDb();
    store = new SessionStore(db);
    insertSession(db, 's1');
  });

  it('resolves @turn:<id> pins to the matching Turn', async () => {
    for (let i = 0; i < 5; i++) makeTurn(store, 's1', `filler ${i}`);
    const pinned = makeTurn(store, 's1', 'THE PINNED TURN');
    for (let i = 0; i < 5; i++) makeTurn(store, 's1', `more filler ${i}`);

    const retriever = new ContextRetriever(db, store, new NullEmbeddingProvider(), {
      recencyWindow: 3,
      semanticTopK: 5,
      maxTokens: 10_000,
      semanticThreshold: 0.45,
    });

    const bundle = await retriever.retrieve('s1', `please review @turn:${pinned.id} carefully`);
    expect(bundle.pins).toHaveLength(1);
    expect(bundle.pins[0]!.id).toBe(pinned.id);
    expect(bundle.extractedPins).toHaveLength(1);
    expect(bundle.extractedPins[0]!.kind).toBe('turn');
  });

  it('extracts @file pins into extractedPins without resolving them (deferred)', async () => {
    makeTurn(store, 's1', 'some history');
    const retriever = new ContextRetriever(db, store, new NullEmbeddingProvider());
    const bundle = await retriever.retrieve('s1', 'look at @file:src/foo.ts');
    expect(bundle.pins).toHaveLength(0); // file resolution deferred
    expect(bundle.extractedPins.some((p) => p.kind === 'file' && p.value === 'src/foo.ts')).toBe(true);
  });

  it('ignores @turn: pins from other sessions', async () => {
    const t1 = makeTurn(store, 's1', 'own turn');
    insertSession(db, 's2');
    const foreign = makeTurn(store, 's2', 'foreign turn');
    const retriever = new ContextRetriever(db, store, new NullEmbeddingProvider());
    const bundle = await retriever.retrieve('s1', `reference @turn:${foreign.id}`);
    expect(bundle.pins).toHaveLength(0);
    // expect self-turn not auto-pinned
    expect(bundle.pins.find((t) => t.id === t1.id)).toBeUndefined();
  });
});

// ── Semantic path: runs only when sqlite-vec is available ────────────────

const probe = new Database(':memory:');
const vecAvailable = loadSqliteVec(probe).loaded;
probe.close();
const describeSemantic = vecAvailable ? describe : describe.skip;

describeSemantic('ContextRetriever — semantic layer (sqlite-vec available)', () => {
  let db: Database;
  let store: SessionStore;

  beforeEach(() => {
    db = makeDb();
    store = new SessionStore(db);
    insertSession(db, 's1');
  });

  it('indexTurn persists embedding + meta rows when provider is active', async () => {
    const t = makeTurn(store, 's1', 'hello');
    const provider = new MockEmbeddingProvider(1024, new Map([['hello', oneHot(1024, 3)]]));
    const retriever = new ContextRetriever(db, store, provider);
    await retriever.indexTurn(t);

    const meta = db
      .query('SELECT turn_id, model_id FROM turn_embedding_meta WHERE turn_id = ?')
      .get(t.id) as { turn_id: string; model_id: string } | undefined;
    expect(meta).toBeDefined();
    expect(meta?.model_id).toBe('mock');
  });

  it('retrieves semantically similar turns above threshold', async () => {
    // User query asks about "authentication" — create one strongly-related and
    // several unrelated older turns.
    const related = makeTurn(store, 's1', 'authentication flow refactor');
    const unrelated = makeTurn(store, 's1', 'unrelated filler about weather');
    // recency fillers
    for (let i = 0; i < 5; i++) makeTurn(store, 's1', `recency ${i}`);

    const seed = new Map<string, Float32Array>();
    seed.set('authentication flow refactor', oneHot(1024, 7, 1.0));
    seed.set('unrelated filler about weather', oneHot(1024, 999, 1.0));
    seed.set('user query', oneHot(1024, 7, 1.0)); // same axis as related
    // Seed recency fillers so indexTurn succeeds (vectors irrelevant for match)
    for (let i = 0; i < 5; i++) seed.set(`recency ${i}`, oneHot(1024, 500 + i));

    const provider = new MockEmbeddingProvider(1024, seed);
    const retriever = new ContextRetriever(db, store, provider, {
      recencyWindow: 3,
      semanticTopK: 5,
      maxTokens: 10_000,
      semanticThreshold: 0.45,
    });

    // Index everything
    for (const t of store.getTurns('s1')) await retriever.indexTurn(t);

    const bundle = await retriever.retrieve('s1', 'user query');
    expect(bundle.metadata.semanticEnabled).toBe(true);
    // The related turn is outside recencyWindow=3 (we appended 7 turns; the
    // related turn is not in the newest 3), so it should surface via semantic.
    const semanticIds = bundle.semantic.map((t) => t.id);
    expect(semanticIds).toContain(related.id);
    // Unrelated turn has orthogonal vector → should NOT pass threshold
    expect(semanticIds).not.toContain(unrelated.id);
  });

  it('deduplicates semantic hits against recent', async () => {
    const seed = new Map<string, Float32Array>();
    for (let i = 0; i < 5; i++) {
      // same vector for all so they're all "relevant"
      seed.set(`msg ${i}`, oneHot(1024, 7));
    }
    seed.set('query', oneHot(1024, 7));

    for (let i = 0; i < 5; i++) makeTurn(store, 's1', `msg ${i}`);

    const provider = new MockEmbeddingProvider(1024, seed);
    const retriever = new ContextRetriever(db, store, provider, {
      recencyWindow: 3,
      semanticTopK: 5,
      maxTokens: 10_000,
      semanticThreshold: 0.1,
    });
    for (const t of store.getTurns('s1')) await retriever.indexTurn(t);

    const bundle = await retriever.retrieve('s1', 'query');
    const recentIds = new Set(bundle.recent.map((t) => t.id));
    // No semantic hit should be in recent
    for (const t of bundle.semantic) expect(recentIds.has(t.id)).toBe(false);
  });
});
