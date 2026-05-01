/**
 * Memory Wiki — SQLite-backed store.
 *
 * Operates on the schema in `src/db/migrations/026_memory_wiki.ts`.
 * Pure persistence: validates row shape and provides typed access.
 * Validation/lifecycle/citation rules live in PageWriter — the store
 * trusts whatever the writer hands it (the writer is the gate).
 *
 * Axiom anchors:
 *   A3 — every read filter is rule-based; no LLM in the path.
 *   A4 — `content_hash` (sources) and `body_hash` (pages) are addressing.
 *   A8 — every operation is logged via `appendOperation`.
 */
import type { Database, Statement } from 'bun:sqlite';
import { type ConfidenceTier, rankOf, TIER_WEIGHT } from '../../core/confidence-tier.ts';
import type {
  WikiClaim,
  WikiEdge,
  WikiEdgeType,
  WikiLifecycle,
  WikiLintCode,
  WikiLintFinding,
  WikiLintSeverity,
  WikiOperation,
  WikiOperationOp,
  WikiPage,
  WikiPageHit,
  WikiPageType,
  WikiSearchOpts,
  WikiSource,
  WikiSourceKind,
  WikiSourceRef,
} from './types.ts';

const DEFAULT_LIMIT = 20;
const DEFAULT_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface PageRow {
  id: string;
  profile: string;
  type: WikiPageType;
  title: string;
  aliases_json: string;
  tags_json: string;
  body: string;
  evidence_tier: ConfidenceTier;
  confidence: number;
  lifecycle: WikiLifecycle;
  created_at: number;
  updated_at: number;
  valid_until: number | null;
  protected_json: string;
  body_hash: string;
}

interface SourceRow {
  id: string;
  profile: string;
  kind: WikiSourceKind;
  content_hash: string;
  created_at: number;
  session_id: string | null;
  task_id: string | null;
  agent_id: string | null;
  user_id: string | null;
  body: string;
  metadata_json: string | null;
}

interface ClaimRow {
  id: string;
  page_id: string;
  text: string;
  source_ids: string;
  evidence_tier: ConfidenceTier;
  confidence: number;
  created_at: number;
}

interface EdgeRow {
  from_id: string;
  to_id: string;
  edge_type: WikiEdgeType;
  confidence: number;
  created_at: number;
}

interface OperationRow {
  id: number;
  ts: number;
  op: WikiOperationOp;
  page_id: string | null;
  source_id: string | null;
  actor: string;
  reason: string | null;
  payload_json: string | null;
}

interface LintRow {
  id: number;
  ts: number;
  code: WikiLintCode;
  severity: WikiLintSeverity;
  page_id: string | null;
  detail: string | null;
  resolved_at: number | null;
}

export class MemoryWikiStore {
  private readonly db: Database;
  private readonly clock: () => number;

  // ── prepared statements ──────────────────────────────────────────────
  private readonly insertSource: Statement;
  private readonly getSource: Statement;
  private readonly insertPage: Statement;
  private readonly updatePage: Statement;
  private readonly getPage: Statement;
  private readonly deletePage: Statement;
  private readonly listPagesByProfile: Statement;
  private readonly insertClaim: Statement;
  private readonly deleteClaimsForPage: Statement;
  private readonly getClaimsForPage: Statement;
  private readonly insertEdge: Statement;
  private readonly deleteEdgesFrom: Statement;
  private readonly listEdgesFrom: Statement;
  private readonly listEdgesTo: Statement;
  private readonly insertOperation: Statement;
  private readonly insertLint: Statement;
  private readonly resolveLint: Statement;
  private readonly listOpenLint: Statement;

  constructor(db: Database, opts?: { clock?: () => number }) {
    this.db = db;
    this.clock = opts?.clock ?? Date.now;

    this.insertSource = db.prepare(
      `INSERT OR IGNORE INTO memory_wiki_sources
       (id, profile, kind, content_hash, created_at, session_id, task_id, agent_id, user_id, body, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getSource = db.prepare(`SELECT * FROM memory_wiki_sources WHERE id = ?`);

    this.insertPage = db.prepare(
      `INSERT INTO memory_wiki_pages
       (id, profile, type, title, aliases_json, tags_json, body, evidence_tier, confidence,
        lifecycle, created_at, updated_at, valid_until, protected_json, body_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.updatePage = db.prepare(
      `UPDATE memory_wiki_pages
          SET aliases_json   = ?,
              tags_json      = ?,
              body           = ?,
              evidence_tier  = ?,
              confidence     = ?,
              lifecycle      = ?,
              updated_at     = ?,
              valid_until    = ?,
              protected_json = ?,
              body_hash      = ?,
              title          = ?
        WHERE id = ?`,
    );
    this.getPage = db.prepare(`SELECT * FROM memory_wiki_pages WHERE id = ?`);
    this.deletePage = db.prepare(`DELETE FROM memory_wiki_pages WHERE id = ?`);
    this.listPagesByProfile = db.prepare(
      `SELECT * FROM memory_wiki_pages WHERE profile = ? ORDER BY updated_at DESC LIMIT ?`,
    );

    this.insertClaim = db.prepare(
      `INSERT OR REPLACE INTO memory_wiki_claims
       (id, page_id, text, source_ids, evidence_tier, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.deleteClaimsForPage = db.prepare(`DELETE FROM memory_wiki_claims WHERE page_id = ?`);
    this.getClaimsForPage = db.prepare(`SELECT * FROM memory_wiki_claims WHERE page_id = ?`);

    this.insertEdge = db.prepare(
      `INSERT OR REPLACE INTO memory_wiki_edges
       (from_id, to_id, edge_type, confidence, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    this.deleteEdgesFrom = db.prepare(`DELETE FROM memory_wiki_edges WHERE from_id = ?`);
    this.listEdgesFrom = db.prepare(`SELECT * FROM memory_wiki_edges WHERE from_id = ?`);
    this.listEdgesTo = db.prepare(`SELECT * FROM memory_wiki_edges WHERE to_id = ?`);

    this.insertOperation = db.prepare(
      `INSERT INTO memory_wiki_operations (ts, op, page_id, source_id, actor, reason, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    this.insertLint = db.prepare(
      `INSERT INTO memory_wiki_lint_findings (ts, code, severity, page_id, detail) VALUES (?, ?, ?, ?, ?)`,
    );
    this.resolveLint = db.prepare(
      `UPDATE memory_wiki_lint_findings SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL`,
    );
    this.listOpenLint = db.prepare(
      `SELECT * FROM memory_wiki_lint_findings WHERE resolved_at IS NULL ORDER BY ts DESC LIMIT ?`,
    );
  }

  // ── sources ──────────────────────────────────────────────────────────

  insertSourceRecord(source: WikiSource): { created: boolean } {
    const result = this.insertSource.run(
      source.id,
      source.provenance.profile,
      source.kind,
      source.contentHash,
      source.createdAt,
      source.provenance.sessionId ?? null,
      source.provenance.taskId ?? null,
      source.provenance.agentId ?? null,
      source.provenance.user ?? null,
      source.body,
      source.metadata ? JSON.stringify(source.metadata) : null,
    );
    return { created: (result.changes ?? 0) > 0 };
  }

  getSourceById(id: string): WikiSource | null {
    const row = this.getSource.get(id) as SourceRow | undefined;
    return row ? rowToSource(row) : null;
  }

  // ── pages ────────────────────────────────────────────────────────────

  upsertPage(page: WikiPage): { created: boolean } {
    const existing = this.getPage.get(page.id) as PageRow | undefined;
    if (!existing) {
      this.insertPage.run(
        page.id,
        page.profile,
        page.type,
        page.title,
        JSON.stringify(page.aliases),
        JSON.stringify(page.tags),
        page.body,
        page.evidenceTier,
        page.confidence,
        page.lifecycle,
        page.createdAt,
        page.updatedAt,
        page.validUntil ?? null,
        JSON.stringify(page.protectedSections),
        page.bodyHash,
      );
      return { created: true };
    }
    this.updatePage.run(
      JSON.stringify(page.aliases),
      JSON.stringify(page.tags),
      page.body,
      page.evidenceTier,
      page.confidence,
      page.lifecycle,
      page.updatedAt,
      page.validUntil ?? null,
      JSON.stringify(page.protectedSections),
      page.bodyHash,
      page.title,
      page.id,
    );
    return { created: false };
  }

  getPageById(id: string): WikiPage | null {
    const row = this.getPage.get(id) as PageRow | undefined;
    if (!row) return null;
    const sources = this.collectSourcesForPage(id);
    return rowToPage(row, sources);
  }

  /**
   * Resolve a target slug to a page id. Targets may be page ids, titles,
   * or aliases. We probe in (id → title-slug → alias) order.
   */
  resolveTarget(profile: string, target: string): string | null {
    const direct = this.db
      .query(`SELECT id FROM memory_wiki_pages WHERE id = ? AND profile = ? LIMIT 1`)
      .get(target, profile) as { id: string } | undefined;
    if (direct) return direct.id;

    const byAlias = this.db
      .query(
        `SELECT id FROM memory_wiki_pages
          WHERE profile = ?
            AND (',' || REPLACE(REPLACE(REPLACE(aliases_json,'[',''),']',''),'"','') || ',') LIKE ?
          LIMIT 1`,
      )
      .get(profile, `%,${target},%`) as { id: string } | undefined;
    if (byAlias) return byAlias.id;
    return null;
  }

  listPages(profile: string, limit = 200): readonly WikiPage[] {
    const rows = this.listPagesByProfile.all(profile, limit) as PageRow[];
    return rows.map((row) => rowToPage(row, this.collectSourcesForPage(row.id)));
  }

  /**
   * FTS5 search ranked by BM25 + tier weight + recency. Returns
   * `WikiPageHit` rows ordered by composite score.
   */
  search(query: string, opts: WikiSearchOpts): readonly WikiPageHit[] {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const ftsQuery = toFtsPhrase(trimmed);
    const minTierRank = opts.minTier ? rankOf(opts.minTier) : -1;

    const clauses: string[] = [`r.profile = ?`, `fts.memory_wiki_pages_fts MATCH ?`];
    const binds: Array<string | number> = [opts.profile, ftsQuery];

    if (opts.types && opts.types.length > 0) {
      clauses.push(`r.type IN (${opts.types.map(() => '?').join(',')})`);
      for (const t of opts.types) binds.push(t);
    }
    if (opts.lifecycle && opts.lifecycle.length > 0) {
      clauses.push(`r.lifecycle IN (${opts.lifecycle.map(() => '?').join(',')})`);
      for (const l of opts.lifecycle) binds.push(l);
    }
    if (opts.freshnessMs !== undefined) {
      clauses.push(`r.updated_at >= ?`);
      binds.push(this.clock() - opts.freshnessMs);
    }

    const sql = `
      SELECT r.*, bm25(memory_wiki_pages_fts) AS bm25_rank
        FROM memory_wiki_pages_fts AS fts
        JOIN memory_wiki_pages AS r ON r.id = fts.id
       WHERE ${clauses.join(' AND ')}
    `;

    let rows: Array<PageRow & { bm25_rank: number }>;
    try {
      rows = this.db.prepare(sql).all(...binds) as Array<PageRow & { bm25_rank: number }>;
    } catch {
      return [];
    }

    const now = this.clock();
    const hits: WikiPageHit[] = [];
    for (const row of rows) {
      if (minTierRank >= 0 && rankOf(row.evidence_tier) < minTierRank) continue;
      if (opts.tags && opts.tags.length > 0) {
        const tags = parseJsonArray<string>(row.tags_json);
        if (!opts.tags.some((t) => tags.includes(t))) continue;
      }
      // BM25 returns *negative* values; the lower (more negative) the
      // better, so we negate to put it on a 0+ similarity axis. SQLite
      // truncates to 0 when no matches, so guard.
      const similarity = Math.max(0, -row.bm25_rank);
      const tierWeight = TIER_WEIGHT[row.evidence_tier];
      const recency = Math.exp(-Math.max(0, now - row.updated_at) / DEFAULT_HALF_LIFE_MS);
      const composite = similarity * tierWeight * (0.5 + 0.5 * recency);
      hits.push({
        page: rowToPage(row, this.collectSourcesForPage(row.id)),
        score: composite,
        components: { bm25: similarity, tierWeight, recency, graphBoost: 0 },
      });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  /**
   * Mark every page that cites `sourceContentHash` as `stale`. Returns
   * the affected ids so callers can emit events.
   *
   * Bridge: claims store source ids (not content hashes) — we look up
   * sources by their content hash first, then match those ids against
   * the claims' `source_ids` JSON arrays.
   */
  markStaleByContentHash(sourceContentHash: string): readonly string[] {
    const sourceIds = this.db
      .query(`SELECT id FROM memory_wiki_sources WHERE content_hash = ?`)
      .all(sourceContentHash) as Array<{ id: string }>;
    if (sourceIds.length === 0) return [];

    const affected = new Set<string>();
    for (const { id } of sourceIds) {
      const rows = this.db
        .query(
          `SELECT DISTINCT p.id FROM memory_wiki_pages p
             JOIN memory_wiki_claims c ON c.page_id = p.id
            WHERE c.source_ids LIKE ?
              AND p.lifecycle = 'canonical'`,
        )
        .all(`%"${id}"%`) as Array<{ id: string }>;
      for (const row of rows) affected.add(row.id);
    }
    if (affected.size === 0) return [];
    const now = this.clock();
    const update = this.db.prepare(`UPDATE memory_wiki_pages SET lifecycle = 'stale', updated_at = ? WHERE id = ?`);
    for (const id of affected) update.run(now, id);
    return [...affected];
  }

  // ── claims ───────────────────────────────────────────────────────────

  replaceClaimsForPage(pageId: string, claims: readonly WikiClaim[]): void {
    this.deleteClaimsForPage.run(pageId);
    for (const claim of claims) {
      this.insertClaim.run(
        claim.id,
        claim.pageId,
        claim.text,
        JSON.stringify(claim.sourceIds),
        claim.evidenceTier,
        claim.confidence,
        claim.createdAt,
      );
    }
  }

  getClaims(pageId: string): readonly WikiClaim[] {
    const rows = this.getClaimsForPage.all(pageId) as ClaimRow[];
    return rows.map(rowToClaim);
  }

  // ── edges ────────────────────────────────────────────────────────────

  replaceEdgesFrom(fromId: string, edges: readonly WikiEdge[]): void {
    this.deleteEdgesFrom.run(fromId);
    for (const e of edges) {
      this.insertEdge.run(e.fromId, e.toId, e.edgeType, e.confidence, e.createdAt);
    }
  }

  edgesFrom(fromId: string): readonly WikiEdge[] {
    const rows = this.listEdgesFrom.all(fromId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  edgesTo(toId: string): readonly WikiEdge[] {
    const rows = this.listEdgesTo.all(toId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  // ── operations ───────────────────────────────────────────────────────

  appendOperation(op: Omit<WikiOperation, 'id' | 'ts'> & { ts?: number }): WikiOperation {
    const ts = op.ts ?? this.clock();
    const result = this.insertOperation.run(
      ts,
      op.op,
      op.pageId ?? null,
      op.sourceId ?? null,
      op.actor,
      op.reason ?? null,
      op.payload ? JSON.stringify(op.payload) : null,
    );
    const id = Number(result.lastInsertRowid);
    return {
      id,
      ts,
      op: op.op,
      ...(op.pageId ? { pageId: op.pageId } : {}),
      ...(op.sourceId ? { sourceId: op.sourceId } : {}),
      actor: op.actor,
      ...(op.reason ? { reason: op.reason } : {}),
      ...(op.payload ? { payload: op.payload } : {}),
    };
  }

  listOperations(opts: { pageId?: string; limit?: number } = {}): readonly WikiOperation[] {
    const limit = opts.limit ?? 100;
    const rows = opts.pageId
      ? (this.db
          .query(`SELECT * FROM memory_wiki_operations WHERE page_id = ? ORDER BY ts DESC LIMIT ?`)
          .all(opts.pageId, limit) as OperationRow[])
      : (this.db.query(`SELECT * FROM memory_wiki_operations ORDER BY ts DESC LIMIT ?`).all(limit) as OperationRow[]);
    return rows.map(rowToOperation);
  }

  // ── lint ─────────────────────────────────────────────────────────────

  recordLintFinding(finding: Omit<WikiLintFinding, 'id' | 'ts'> & { ts?: number }): WikiLintFinding {
    const ts = finding.ts ?? this.clock();
    const result = this.insertLint.run(
      ts,
      finding.code,
      finding.severity,
      finding.pageId ?? null,
      finding.detail ?? null,
    );
    const id = Number(result.lastInsertRowid);
    return {
      id,
      ts,
      code: finding.code,
      severity: finding.severity,
      ...(finding.pageId ? { pageId: finding.pageId } : {}),
      ...(finding.detail ? { detail: finding.detail } : {}),
    };
  }

  resolveLintFinding(id: number): void {
    this.resolveLint.run(this.clock(), id);
  }

  listOpenLintFindings(limit = 100): readonly WikiLintFinding[] {
    const rows = this.listOpenLint.all(limit) as LintRow[];
    return rows.map(rowToLint);
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private collectSourcesForPage(pageId: string): readonly WikiSourceRef[] {
    const claims = this.getClaimsForPage.all(pageId) as ClaimRow[];
    const ids = new Set<string>();
    for (const c of claims) {
      for (const id of parseJsonArray<string>(c.source_ids)) ids.add(id);
    }
    if (ids.size === 0) return [];
    const placeholders = [...ids].map(() => '?').join(',');
    const rows = this.db
      .query(`SELECT id, content_hash, kind FROM memory_wiki_sources WHERE id IN (${placeholders})`)
      .all(...ids) as Array<{ id: string; content_hash: string; kind: WikiSourceKind }>;
    return rows.map((r) => ({ id: r.id, contentHash: r.content_hash, kind: r.kind }));
  }
}

// ── row converters ──────────────────────────────────────────────────────

function rowToPage(row: PageRow, sources: readonly WikiSourceRef[]): WikiPage {
  return {
    id: row.id,
    profile: row.profile,
    type: row.type,
    title: row.title,
    aliases: parseJsonArray<string>(row.aliases_json),
    tags: parseJsonArray<string>(row.tags_json),
    body: row.body,
    evidenceTier: row.evidence_tier,
    confidence: row.confidence,
    lifecycle: row.lifecycle,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.valid_until !== null ? { validUntil: row.valid_until } : {}),
    protectedSections: parseJsonArray<string>(row.protected_json),
    bodyHash: row.body_hash,
    sources,
  };
}

function rowToSource(row: SourceRow): WikiSource {
  return {
    id: row.id,
    kind: row.kind,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    provenance: {
      profile: row.profile,
      ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
      ...(row.task_id !== null ? { taskId: row.task_id } : {}),
      ...(row.agent_id !== null ? { agentId: row.agent_id } : {}),
      ...(row.user_id !== null ? { user: row.user_id } : {}),
    },
    body: row.body,
    ...(row.metadata_json ? { metadata: parseJsonObject(row.metadata_json) } : {}),
  };
}

function rowToClaim(row: ClaimRow): WikiClaim {
  return {
    id: row.id,
    pageId: row.page_id,
    text: row.text,
    sourceIds: parseJsonArray<string>(row.source_ids),
    evidenceTier: row.evidence_tier,
    confidence: row.confidence,
    createdAt: row.created_at,
  };
}

function rowToEdge(row: EdgeRow): WikiEdge {
  return {
    fromId: row.from_id,
    toId: row.to_id,
    edgeType: row.edge_type,
    confidence: row.confidence,
    createdAt: row.created_at,
  };
}

function rowToOperation(row: OperationRow): WikiOperation {
  return {
    id: row.id,
    ts: row.ts,
    op: row.op,
    ...(row.page_id !== null ? { pageId: row.page_id } : {}),
    ...(row.source_id !== null ? { sourceId: row.source_id } : {}),
    actor: row.actor,
    ...(row.reason !== null ? { reason: row.reason } : {}),
    ...(row.payload_json !== null ? { payload: parseJsonObject(row.payload_json) } : {}),
  };
}

function rowToLint(row: LintRow): WikiLintFinding {
  return {
    id: row.id,
    ts: row.ts,
    code: row.code,
    severity: row.severity,
    ...(row.page_id !== null ? { pageId: row.page_id } : {}),
    ...(row.detail !== null ? { detail: row.detail } : {}),
    ...(row.resolved_at !== null ? { resolvedAt: row.resolved_at } : {}),
  };
}

function parseJsonArray<T>(text: string): T[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed as T[];
  } catch {
    /* fall through */
  }
  return [];
}

function parseJsonObject(text: string): Readonly<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return {};
}

function toFtsPhrase(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}
