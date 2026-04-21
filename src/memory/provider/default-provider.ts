/**
 * DefaultMemoryProvider — SQLite-backed, FTS5-indexed, tier-ranked.
 *
 * Implements `MemoryProvider` against the schema shipped in
 * `src/db/migrations/003_memory_records.ts`. This is a clean-slate provider;
 * it does NOT wrap `src/memory/retrieval.ts` or `auto-memory-loader` — those
 * remain untouched and a future PR migrates their data into this store.
 *
 * Axioms:
 *   A1 — write path never self-promotes tiers; clamp only, never upgrade.
 *   A3 — all decisions here are rule-based (profile filter, tier filter,
 *        freshness filter, ranker composition). No LLM in the path.
 *   A4 — `contentHash` is required for deterministic tier; `invalidate()`
 *        keys off that hash.
 *   A5 — tier-aware ranking via the shared ranker.
 *
 * Contract anchors:
 *   - `src/memory/provider/types.ts` — interface + Zod schemas.
 *   - `docs/spec/w1-contracts.md` §1/§3 — ConfidenceTier + profile column.
 *   - `docs/architecture/decisions.md` §22 — ranker formula.
 */
import { createHash } from 'node:crypto';
import type { Database, Statement } from 'bun:sqlite';
import {
  clampConfidenceToTier,
  CONFIDENCE_TIERS,
  type ConfidenceTier,
  rankOf,
  TIER_CONFIDENCE_CEILING,
} from '../../core/confidence-tier.ts';
import { computeScore, type RankerWeights } from './ranker.ts';
import {
  type ConsolidationReport,
  type EvidenceRef,
  type HealthReport,
  MEMORY_KINDS,
  type MemoryHit,
  type MemoryKind,
  type MemoryProvider,
  type MemoryRecord,
  MemoryRecordInputSchema,
  type SearchOpts,
  type WriteAck,
} from './types.ts';

// ── Options ─────────────────────────────────────────────────────────────

export interface DefaultMemoryProviderOptions {
  readonly db: Database;
  readonly rankerWeights?: Partial<RankerWeights>;
  /** Injection point for tests; defaults to `Date.now`. */
  readonly clock?: () => number;
  /** Half-life for the recency decay. Default 14 days. */
  readonly halfLifeMs?: number;
  /**
   * Window (in ms) the `recentErrors` count looks back over
   * prediction_outcomes. Default 30 days.
   */
  readonly errorWindowMs?: number;
}

const DEFAULT_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const DEFAULT_ERROR_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEFAULT_LIMIT = 10;
const DEFAULT_CONSOLIDATION_MIN_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_CONSOLIDATION_CONFIDENCE = 0.4;

// Stored-row shape (snake_case). Translated to `MemoryRecord` by `rowToRecord`.
interface MemoryRow {
  id: string;
  profile: string;
  kind: MemoryKind;
  content: string;
  confidence: number;
  evidence_tier: ConfidenceTier;
  evidence_chain: string;
  content_hash: string | null;
  created_at: number;
  valid_from: number | null;
  valid_until: number | null;
  session_id: string | null;
  metadata_json: string | null;
  embedding: Uint8Array | null;
}

// ── Provider ───────────────────────────────────────────────────────────

export class DefaultMemoryProvider implements MemoryProvider {
  readonly id = 'vinyan.default';
  readonly capabilities = ['fts5', 'tier-ranked'] as const;
  readonly tierSupport = CONFIDENCE_TIERS;

  private readonly db: Database;
  private readonly rankerWeights: Partial<RankerWeights> | undefined;
  private readonly clock: () => number;
  private readonly halfLifeMs: number;
  private readonly errorWindowMs: number;

  private readonly insertStmt: Statement;
  private readonly deleteByHashStmt: Statement;
  private readonly healthStmt: Statement;
  private readonly consolidationStmt: Statement;

  /**
   * Whether `prediction_outcomes.evidence_chain` is available. Probed once
   * at construction; toggles off the expensive LEFT JOIN when the column
   * is not present (which it currently is not — keeps the ranker functional
   * while the learning-loop schema catches up).
   */
  private readonly predOutcomesHasEvidence: boolean;
  private recentErrorsStmt: Statement | null = null;

  constructor(opts: DefaultMemoryProviderOptions) {
    this.db = opts.db;
    this.rankerWeights = opts.rankerWeights;
    this.clock = opts.clock ?? Date.now;
    this.halfLifeMs = opts.halfLifeMs ?? DEFAULT_HALF_LIFE_MS;
    this.errorWindowMs = opts.errorWindowMs ?? DEFAULT_ERROR_WINDOW_MS;

    this.insertStmt = this.db.prepare(
      `INSERT OR REPLACE INTO memory_records (
         id, profile, kind, content, confidence, evidence_tier, evidence_chain,
         content_hash, created_at, valid_from, valid_until, session_id,
         metadata_json, embedding
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.deleteByHashStmt = this.db.prepare(`DELETE FROM memory_records WHERE content_hash = ?`);
    this.healthStmt = this.db.prepare(`SELECT 1 AS ok FROM memory_records LIMIT 1`);
    this.consolidationStmt = this.db.prepare(
      `SELECT * FROM memory_records
        WHERE evidence_tier = 'probabilistic'
          AND confidence < ?
          AND created_at < ?`,
    );

    this.predOutcomesHasEvidence = probePredOutcomesEvidence(this.db);
    if (this.predOutcomesHasEvidence) {
      // Memory id is quoted as a JSON string inside evidence_chain TEXT;
      // `instr` on the JSON blob is a cheap containment check for MVP.
      this.recentErrorsStmt = this.db.prepare(
        `SELECT COUNT(*) AS n
           FROM prediction_outcomes
          WHERE recorded_at >= ?
            AND actual_test_result = 'fail'
            AND instr(evidence_chain, ?) > 0`,
      );
    }
  }

  // ── write ────────────────────────────────────────────────────────────

  async write(record: Omit<MemoryRecord, 'id'>): Promise<WriteAck> {
    // Zod boundary validation.
    const parsed = MemoryRecordInputSchema.safeParse(record);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const pathDetail = issue?.path.length ? `${issue.path.join('.')}: ${issue.message}` : parsed.error.message;
      // Distinguish a profile regex failure so callers see the right reason.
      if (issue && issue.path.length === 1 && issue.path[0] === 'profile') {
        return { ok: false, reason: 'profile_unknown', detail: pathDetail };
      }
      return { ok: false, reason: 'schema_invalid', detail: pathDetail };
    }

    const now = this.clock();
    const input = parsed.data;

    // Clamp confidence to tier ceiling (A5). Never *promote*.
    const clamped = clampConfidenceToTier(input.confidence, input.evidenceTier);
    // Deterministic id: sha256(profile|kind|content|createdAt).
    const id = this.computeRecordId(input.profile, input.kind, input.content, input.temporalContext.createdAt);

    const chainJson = JSON.stringify(input.evidenceChain);
    const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;
    const embeddingBuf = input.embedding
      ? Buffer.from(input.embedding.buffer, input.embedding.byteOffset, input.embedding.byteLength)
      : null;

    try {
      this.insertStmt.run(
        id,
        input.profile,
        input.kind,
        input.content,
        clamped,
        input.evidenceTier,
        chainJson,
        input.contentHash ?? null,
        input.temporalContext.createdAt,
        input.temporalContext.validFrom ?? null,
        input.temporalContext.validUntil ?? null,
        input.sessionId ?? null,
        metadataJson,
        embeddingBuf,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: 'schema_invalid', detail: `sqlite: ${msg}` };
    }

    if (clamped < input.confidence) {
      // Log-only (silent clamp) — we intentionally do NOT populate
      // `promotedFrom` because that field documents upward moves only.
      // A dedicated structured logger is out of scope for this file.
    }
    void now;
    return { ok: true, id, tier: input.evidenceTier };
  }

  // ── search ───────────────────────────────────────────────────────────

  async search(query: string, opts: SearchOpts): Promise<readonly MemoryHit[]> {
    // Cross-profile reads are prohibited at this layer (§3). Return empty
    // rather than throw — callers expect an array.
    if (opts.profile === '*' || opts.profile === 'ALL') {
      return [];
    }
    if (!/^[a-z][a-z0-9-]*$/.test(opts.profile) && opts.profile !== 'default') {
      return [];
    }
    const trimmed = query.trim();
    if (!trimmed) return [];

    const now = this.clock();
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const minTierRank = opts.minTier !== undefined ? rankOf(opts.minTier) : -1;

    // Build FTS5 query. Quote the user input conservatively to avoid query
    // syntax injection (eg. a colon triggers FTS5 advanced syntax). This is
    // a simple literal-phrase wrap; callers wanting advanced syntax can
    // pre-wrap themselves.
    const ftsQuery = toFtsPhrase(trimmed);

    // Dynamic WHERE clause for kind + freshness + tier.
    const clauses: string[] = [`r.profile = ?`, `fts.memory_records_fts MATCH ?`];
    // bun:sqlite's `.all()` binds accept string | number | null | boolean | bigint | Uint8Array.
    const binds: Array<string | number> = [opts.profile, ftsQuery];

    if (opts.kinds && opts.kinds.length > 0) {
      clauses.push(`r.kind IN (${opts.kinds.map(() => '?').join(',')})`);
      for (const k of opts.kinds) binds.push(k);
    }
    if (opts.freshnessMs !== undefined) {
      clauses.push(`r.created_at >= ?`);
      binds.push(now - opts.freshnessMs);
    }

    const sql = `
      SELECT r.*, bm25(memory_records_fts) AS bm25_rank
        FROM memory_records_fts AS fts
        JOIN memory_records AS r ON r.id = fts.id
       WHERE ${clauses.join(' AND ')}
    `;

    let rows: Array<MemoryRow & { bm25_rank: number }>;
    try {
      rows = this.db.prepare(sql).all(...binds) as Array<MemoryRow & { bm25_rank: number }>;
    } catch (err) {
      // FTS5 rejects malformed MATCH expressions with a SQLite error; treat
      // as "no hits" so upstream consumers stay on the happy path.
      const _msg = err instanceof Error ? err.message : String(err);
      return [];
    }

    const errorWindowStart = now - this.errorWindowMs;
    const hits: MemoryHit[] = [];
    for (const row of rows) {
      // Tier filter (enforced post-SQL so minTier is inclusive by rank,
      // not by the lexical tier string).
      if (minTierRank >= 0 && rankOf(row.evidence_tier) < minTierRank) continue;

      const recentErrors = this.countRecentErrorsFor(row.id, errorWindowStart);
      const breakdown = computeScore(
        {
          fts5Rank: row.bm25_rank,
          tier: row.evidence_tier,
          createdAt: row.created_at,
          now,
          halfLifeMs: this.halfLifeMs,
          recentErrors,
        },
        this.rankerWeights,
      );

      hits.push({
        record: rowToRecord(row),
        score: breakdown.composite,
        components: {
          similarity: breakdown.similarity,
          tierWeight: breakdown.tierWeight,
          recency: breakdown.recency,
          predErrorPenalty: breakdown.predErrorPenalty,
        },
      });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  // ── invalidate / consolidate / health ───────────────────────────────

  async invalidate(contentHash: string): Promise<{ readonly removed: number }> {
    // Count first, then delete — `sqlite3_changes()` returns cumulative
    // counts when FTS5 sync triggers fire, which overcounts the user-visible
    // removal. Counting the base-table rows is the authoritative answer.
    const countRow = this.db
      .query('SELECT COUNT(*) AS n FROM memory_records WHERE content_hash = ?')
      .get(contentHash) as { n: number } | undefined;
    const matched = countRow ? Number(countRow.n) || 0 : 0;
    if (matched === 0) return { removed: 0 };
    this.deleteByHashStmt.run(contentHash);
    return { removed: matched };
  }

  async consolidate(): Promise<ConsolidationReport> {
    const now = this.clock();
    const cutoff = now - DEFAULT_CONSOLIDATION_MIN_AGE_MS;
    const flaggedRows = this.consolidationStmt.all(DEFAULT_CONSOLIDATION_CONFIDENCE, cutoff) as MemoryRow[];

    // Count the full table for `scanned`. Cheap on SQLite.
    const { total } = this.db.query('SELECT COUNT(*) AS total FROM memory_records').get() as { total: number };

    return {
      scanned: Number(total) || 0,
      promoted: 0,
      demoted: 0,
      invalidated: 0,
      lowConfidenceFlagged: flaggedRows.map(rowToRecord),
      nudges: [],
    };
  }

  async healthCheck(): Promise<HealthReport> {
    const start = this.clock();
    try {
      this.healthStmt.get();
      return { ok: true, latencyMs: this.clock() - start };
    } catch (err) {
      return {
        ok: false,
        latencyMs: this.clock() - start,
        notes: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ── Internals ────────────────────────────────────────────────────────

  private computeRecordId(profile: string, kind: MemoryKind, content: string, createdAt: number): string {
    const payload = `${profile}|${kind}|${content}|${createdAt}`;
    return createHash('sha256').update(payload).digest('hex');
  }

  /**
   * Count how many recent prediction_outcomes cite `memoryId` in their
   * evidence_chain AND had a wrong actual_test_result. Returns 0 when the
   * `evidence_chain` column is not available on prediction_outcomes (which
   * is the current shipped schema — the column lands in a follow-up PR).
   */
  private countRecentErrorsFor(memoryId: string, sinceMs: number): number {
    if (!this.recentErrorsStmt) return 0;
    try {
      // `"id"` matches the JSON-encoded id reference inside evidence_chain.
      const needle = JSON.stringify(memoryId);
      const row = this.recentErrorsStmt.get(sinceMs, needle) as { n: number } | undefined;
      return row ? Number(row.n) || 0 : 0;
    } catch {
      return 0;
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function probePredOutcomesEvidence(db: Database): boolean {
  try {
    const cols = db.query(`PRAGMA table_info(prediction_outcomes)`).all() as Array<{ name: string }>;
    if (cols.length === 0) return false;
    return cols.some((c) => c.name === 'evidence_chain');
  } catch {
    return false;
  }
}

/**
 * Escape FTS5-reserved characters and wrap the query in double quotes so
 * SQLite treats it as a literal phrase. This trades advanced query syntax
 * (column filters, NEAR, etc.) for safety — the default provider's job is
 * to surface candidate rows; richer FTS is a caller-side concern.
 */
function toFtsPhrase(query: string): string {
  const cleaned = query.replace(/"/g, '""');
  return `"${cleaned}"`;
}

function rowToRecord(row: MemoryRow): MemoryRecord {
  const chain = safeParseJsonArray<EvidenceRef>(row.evidence_chain);
  const temporalContext = {
    createdAt: row.created_at,
    ...(row.valid_from !== null ? { validFrom: row.valid_from } : {}),
    ...(row.valid_until !== null ? { validUntil: row.valid_until } : {}),
  };
  const metadata = row.metadata_json ? safeParseJsonObject(row.metadata_json) : undefined;
  const embedding = row.embedding
    ? new Float32Array(
        row.embedding.buffer.slice(row.embedding.byteOffset, row.embedding.byteOffset + row.embedding.byteLength),
      )
    : undefined;

  return {
    id: row.id,
    profile: row.profile,
    kind: row.kind,
    content: row.content,
    confidence: row.confidence,
    evidenceTier: row.evidence_tier,
    evidenceChain: chain,
    ...(row.content_hash !== null ? { contentHash: row.content_hash } : {}),
    temporalContext,
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
    ...(embedding ? { embedding } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function safeParseJsonArray<T>(text: string): readonly T[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed as T[];
  } catch {
    /* fall through */
  }
  return [];
}

function safeParseJsonObject(text: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

// ── Exports ────────────────────────────────────────────────────────────

// Re-export supporting constants so consumers importing the provider
// don't need to dual-import from types.ts.
export { MEMORY_KINDS, TIER_CONFIDENCE_CEILING };
