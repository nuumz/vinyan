/**
 * session_search — pure search logic over `memory_records_fts`.
 *
 * Mirrors the FTS5 query pattern in `DefaultMemoryProvider.search` (same
 * profile filter, literal-phrase wrap, bm25 ranker composition) so hits
 * coming through the tool surface rank identically to hits coming through
 * the provider interface. The tool module stays thin — the factory wraps
 * this function, the register helper mounts the factory, and tests pin the
 * behavior here without needing the Tool wrapper.
 *
 * Axioms:
 *   A3 — Deterministic governance. Profile / tier / freshness filters are
 *        rule-based; no LLM in the search path.
 *   A4 — Content-addressed truth. FTS5 match is a deterministic text-equality
 *        signal at the matching-process level. The hit retains the record's
 *        own `evidenceTier`; this tool does NOT upgrade tier to
 *        'deterministic'. That property is about the matching process, not
 *        the underlying claim.
 *   A5 — Tier-weighted ranking via the shared `computeScore` ranker.
 *
 * Contract anchors:
 *   - `docs/spec/w1-contracts.md` §1 ConfidenceTier, §3 profile column.
 *   - `src/memory/provider/ranker.ts` — ranker formula (unchanged).
 *   - `src/db/migrations/003_memory_records.ts` — base table + FTS5 vtable.
 */
import type { Database } from 'bun:sqlite';
import { rankOf, type ConfidenceTier } from '../../core/confidence-tier.ts';
import { computeScore, type RankerWeights } from '../../memory/provider/ranker.ts';
import type { MemoryKind } from '../../memory/provider/types.ts';

// ── Public types ────────────────────────────────────────────────────────

export type SessionScope = 'current' | 'recent7d' | 'all';

export interface SessionSearchInput {
  readonly query: string;
  readonly profile: string;
  readonly sessionScope?: SessionScope;
  /** Required when `sessionScope === 'current'`. */
  readonly sessionId?: string;
  readonly kinds?: readonly MemoryKind[];
  readonly minTier?: ConfidenceTier;
  readonly freshnessMs?: number;
  /** Default 10, bounded to [1, 50]. */
  readonly limit?: number;
}

export interface SessionSearchHit {
  readonly recordId: string;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly evidenceTier: ConfidenceTier;
  readonly confidence: number;
  readonly sessionId: string | null;
  readonly createdAt: number;
  readonly score: number;
  readonly bm25Raw: number;
}

export interface SessionSearchResult {
  readonly query: string;
  readonly hits: readonly SessionSearchHit[];
  readonly totalCandidates: number;
  readonly truncated: boolean;
  /** Non-empty when the caller supplied an input that short-circuited the search. */
  readonly warning?: string;
}

export interface SessionSearchDeps {
  readonly db: Database;
  readonly clock?: () => number;
  /** Ranker override — exposed for tests. */
  readonly rankerWeights?: Partial<RankerWeights>;
  /** Recency half-life in ms (default 14 days — matches DefaultMemoryProvider). */
  readonly halfLifeMs?: number;
}

// ── Constants ───────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const RECENT_7D_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
const PROFILE_RE = /^[a-z][a-z0-9-]*$/;

// Internal row shape — only the columns the ranker needs.
interface FtsRow {
  id: string;
  kind: MemoryKind;
  content: string;
  confidence: number;
  evidence_tier: ConfidenceTier;
  created_at: number;
  session_id: string | null;
  bm25_rank: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Quote the query as an FTS5 literal phrase so operator characters (`:`, `"`,
 * `AND`, `OR`, `NEAR`) are treated as plain terms. Embedded double-quotes are
 * doubled per FTS5 escape rules. Mirrors `DefaultMemoryProvider.toFtsPhrase`.
 */
function toFtsPhrase(query: string): string {
  const cleaned = query.replace(/"/g, '""');
  return `"${cleaned}"`;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return 1;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

function emptyResult(query: string, warning?: string): SessionSearchResult {
  return {
    query,
    hits: [],
    totalCandidates: 0,
    truncated: false,
    ...(warning !== undefined ? { warning } : {}),
  };
}

// ── Main entry point ────────────────────────────────────────────────────

export async function searchSessions(
  input: SessionSearchInput,
  deps: SessionSearchDeps,
): Promise<SessionSearchResult> {
  const query = input.query.trim();
  if (!query) return emptyResult(input.query, 'empty_query');

  // Cross-profile wildcards are not allowed at this layer (w1-contracts §3).
  if (input.profile === '*' || input.profile === 'ALL') {
    return emptyResult(input.query, 'cross_profile_not_allowed');
  }
  // Profile must match the same regex the provider enforces.
  if (input.profile !== 'default' && !PROFILE_RE.test(input.profile)) {
    return emptyResult(input.query, 'invalid_profile');
  }

  // sessionScope='current' requires a sessionId.
  if (input.sessionScope === 'current' && !input.sessionId) {
    return emptyResult(input.query, 'session_scope_requires_sessionId');
  }

  const clock = deps.clock ?? Date.now;
  const now = clock();
  const halfLifeMs = deps.halfLifeMs ?? DEFAULT_HALF_LIFE_MS;
  const limit = clampLimit(input.limit);
  const minTierRank = input.minTier !== undefined ? rankOf(input.minTier) : -1;
  const ftsQuery = toFtsPhrase(query);

  // Build WHERE clause in lockstep with provider conventions.
  const clauses: string[] = [`r.profile = ?`, `fts.memory_records_fts MATCH ?`];
  const binds: Array<string | number> = [input.profile, ftsQuery];

  if (input.kinds && input.kinds.length > 0) {
    clauses.push(`r.kind IN (${input.kinds.map(() => '?').join(',')})`);
    for (const k of input.kinds) binds.push(k);
  }

  // Freshness: explicit override wins over sessionScope recency.
  if (input.freshnessMs !== undefined) {
    clauses.push(`r.created_at >= ?`);
    binds.push(now - input.freshnessMs);
  } else if (input.sessionScope === 'recent7d') {
    clauses.push(`r.created_at >= ?`);
    binds.push(now - RECENT_7D_MS);
  }

  if (input.sessionScope === 'current') {
    clauses.push(`r.session_id = ?`);
    // sessionId presence was validated above.
    binds.push(input.sessionId as string);
  }

  const sql = `
    SELECT r.id, r.kind, r.content, r.confidence, r.evidence_tier,
           r.created_at, r.session_id, bm25(memory_records_fts) AS bm25_rank
      FROM memory_records_fts AS fts
      JOIN memory_records AS r ON r.id = fts.id
     WHERE ${clauses.join(' AND ')}
  `;

  let rows: FtsRow[];
  try {
    rows = deps.db.prepare(sql).all(...binds) as FtsRow[];
  } catch {
    // FTS5 malformed MATCH → treat as no hits (provider convention).
    return emptyResult(input.query, 'fts5_query_error');
  }

  // Rank in TS so we can apply the inclusive minTier rank filter after the
  // bm25 join. predErrorPenalty is stubbed to 0 here — wiring a per-id
  // prediction_outcomes lookup from the tool is expensive and the data is
  // already consumed by DefaultMemoryProvider. TODO(W4): share a cached
  // penalty lookup between the provider and this tool so tool-driven hits
  // carry the same A7 prediction-error correction.
  const scored: SessionSearchHit[] = [];
  for (const row of rows) {
    if (minTierRank >= 0 && rankOf(row.evidence_tier) < minTierRank) continue;

    const breakdown = computeScore(
      {
        fts5Rank: row.bm25_rank,
        tier: row.evidence_tier,
        createdAt: row.created_at,
        now,
        halfLifeMs,
        recentErrors: 0,
      },
      deps.rankerWeights,
    );

    scored.push({
      recordId: row.id,
      kind: row.kind,
      content: row.content,
      evidenceTier: row.evidence_tier,
      confidence: row.confidence,
      sessionId: row.session_id,
      createdAt: row.created_at,
      score: breakdown.composite,
      bm25Raw: row.bm25_rank,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const totalCandidates = scored.length;
  const hits = scored.slice(0, limit);
  return {
    query: input.query,
    hits,
    totalCandidates,
    truncated: totalCandidates > hits.length,
  };
}

/**
 * Render a concise top-N summary for LLM consumption. Exposed so the tool
 * factory can package a `renderedText` alongside the structured result.
 */
export function renderTopHits(hits: readonly SessionSearchHit[], n = 3): string {
  if (hits.length === 0) return '(no hits)';
  const take = hits.slice(0, Math.max(1, n));
  return take
    .map((h, i) => {
      const preview = h.content.length > 160 ? `${h.content.slice(0, 157)}...` : h.content;
      return `${i + 1}. [${h.evidenceTier} · ${h.kind} · score=${h.score.toFixed(3)}] ${preview}`;
    })
    .join('\n');
}
