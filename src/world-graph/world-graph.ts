import { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import { mkdirSync, readFileSync } from 'fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'path';
import type { Evidence, Fact } from '../core/types.ts';
import { parseFalsifiableConditions } from '../oracle/falsifiable-parser.ts';
import { DEFAULT_RETENTION, type RetentionConfig, runRetention } from './retention.ts';
import { SCHEMA_SQL } from './schema.ts';
import { computeDecayedConfidence } from './temporal-decay.ts';

export interface WorldGraphOptions {
  retention?: Partial<RetentionConfig>;
  retentionInterval?: number;
  /** Workspace root used to canonicalize file paths for A4 hash invalidation. */
  workspaceRoot?: string;
}

export class WorldGraph {
  private db: Database;
  private storeCount = 0;
  private retentionInterval: number;
  private retentionConfig: RetentionConfig;
  private workspaceRoot?: string;

  constructor(dbPath: string = ':memory:', options?: WorldGraphOptions) {
    this.retentionConfig = { ...DEFAULT_RETENTION, ...options?.retention };
    this.retentionInterval = options?.retentionInterval ?? 100;
    this.workspaceRoot = options?.workspaceRoot ? resolve(options.workspaceRoot) : undefined;
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    // Limit WAL to 200 pages (~800KB) — prevents multi-MB WAL accumulation that
    // causes synchronous recovery on next open and blocks the event loop
    this.db.exec('PRAGMA wal_autocheckpoint = 200');
    this.db.exec(SCHEMA_SQL);

    // Safe additive migration for ECP temporal context columns (Gap 3)
    try {
      this.db.exec('ALTER TABLE facts ADD COLUMN valid_until INTEGER');
    } catch {
      /* column exists */
    }
    try {
      this.db.exec("ALTER TABLE facts ADD COLUMN decay_model TEXT DEFAULT 'none'");
    } catch {
      /* column exists */
    }
    try {
      this.db.exec('ALTER TABLE facts ADD COLUMN tier_reliability REAL');
    } catch {
      /* column exists */
    }

    // G5: Failed verdict archive — preserves negative verification results (§4.1, §8.2)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS failed_verdicts (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        pattern TEXT,
        oracle_name TEXT NOT NULL,
        verdict TEXT NOT NULL,
        confidence REAL,
        tier_reliability REAL,
        file_hash TEXT,
        session_id TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_failed_verdicts_target ON failed_verdicts(target)');
  }

  /** Compute content-hash ID for a fact (deterministic deduplication). */
  private computeFactId(target: string, pattern: string, evidence: Evidence[]): string {
    const content = JSON.stringify({ target, pattern, evidence });
    return createHash('sha256').update(content).digest('hex');
  }

  private toPortablePath(filePath: string): string {
    return filePath.split(sep).join('/');
  }

  private normalizePath(filePath: string): string {
    if (!this.workspaceRoot) return this.toPortablePath(filePath);

    const resolved = isAbsolute(filePath) ? resolve(filePath) : resolve(this.workspaceRoot, filePath);
    const rel = relative(this.workspaceRoot, resolved);
    if (rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
      return this.toPortablePath(rel);
    }
    return this.toPortablePath(resolved);
  }

  private rawPathAlias(filePath: string): string {
    if (this.workspaceRoot && !isAbsolute(filePath)) {
      return this.toPortablePath(resolve(this.workspaceRoot, filePath));
    }
    return this.toPortablePath(filePath);
  }

  private pathAliases(filePath: string): string[] {
    return Array.from(new Set([this.normalizePath(filePath), this.rawPathAlias(filePath)]));
  }

  private resolveFilePath(filePath: string): string {
    if (this.workspaceRoot && !isAbsolute(filePath)) return resolve(this.workspaceRoot, filePath);
    return filePath;
  }

  private normalizeEvidence(evidence: Evidence[]): Evidence[] {
    return evidence.map((e) => ({ ...e, file: this.normalizePath(e.file) }));
  }

  /** Compute SHA-256 hash of a file's contents. */
  computeFileHash(filePath: string): string {
    const content = readFileSync(this.resolveFilePath(filePath));
    return createHash('sha256').update(content).digest('hex');
  }

  /** Store a verified fact in the World Graph. */
  storeFact(fact: Omit<Fact, 'id'>): Fact {
    const storedFact = {
      ...fact,
      target: this.normalizePath(fact.target),
      sourceFile: this.normalizePath(fact.sourceFile),
      evidence: this.normalizeEvidence(fact.evidence),
    };
    const id = this.computeFactId(storedFact.target, storedFact.pattern, storedFact.evidence);
    this.db
      .query(`
      INSERT OR REPLACE INTO facts (id, target, pattern, evidence, oracle_name, file_hash, source_file, verified_at, session_id, confidence, valid_until, decay_model, tier_reliability)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        storedFact.target,
        storedFact.pattern,
        JSON.stringify(storedFact.evidence),
        storedFact.oracleName,
        storedFact.fileHash,
        storedFact.sourceFile,
        storedFact.verifiedAt,
        storedFact.sessionId ?? null,
        storedFact.confidence,
        storedFact.validUntil ?? null,
        storedFact.decayModel ?? 'none',
        storedFact.tierReliability ?? null,
      );

    // Populate evidence-file junction table for cross-file cascade invalidation
    const evidenceFiles = new Set(storedFact.evidence.map((e) => e.file).filter(Boolean));
    for (const filePath of evidenceFiles) {
      this.db.query('INSERT OR IGNORE INTO fact_evidence_files (fact_id, file_path) VALUES (?, ?)').run(id, filePath);
    }

    // Run retention policy periodically
    this.storeCount++;
    if (this.storeCount % this.retentionInterval === 0) {
      runRetention(this.db, this.retentionConfig);
    }

    return { ...storedFact, id };
  }

  /** G5: Store a failed oracle verdict for cross-task pattern visibility.
   *  Failed patterns are preserved so future tasks can see "previously rejected" approaches. */
  storeFailedVerdict(verdict: {
    target: string;
    pattern?: string;
    oracleName: string;
    verdict: string;
    confidence?: number;
    tierReliability?: number;
    fileHash?: string;
    sessionId?: string;
  }): void {
    const id = createHash('sha256')
      .update(JSON.stringify({ target: verdict.target, oracle: verdict.oracleName, verdict: verdict.verdict }))
      .digest('hex');
    this.db
      .query(`
      INSERT OR REPLACE INTO failed_verdicts (id, target, pattern, oracle_name, verdict, confidence, tier_reliability, file_hash, session_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        verdict.target,
        verdict.pattern ?? null,
        verdict.oracleName,
        verdict.verdict,
        verdict.confidence ?? null,
        verdict.tierReliability ?? null,
        verdict.fileHash ?? null,
        verdict.sessionId ?? null,
        Date.now(),
      );
  }

  /**
   * Query all facts for a given target (file path or symbol).
   * A4: Excludes stale facts whose source file hash no longer matches.
   */
  queryFacts(target: string): Fact[] {
    // LEFT JOIN: facts without a tracked file hash are preserved (system-provided facts).
    // Facts whose file hash mismatches current_hash are excluded (stale).
    // ECP §3.6: Exclude fully expired facts (valid_until passed).
    // Exponential-decay facts are included if within validUntil — decay applied at read time.
    const now = Date.now();
    const aliases = this.pathAliases(target);
    const placeholders = aliases.map(() => '?').join(', ');
    const rows = this.db
      .query(`
      SELECT f.* FROM facts f
      LEFT JOIN file_hashes fh ON f.source_file = fh.path
      WHERE f.target IN (${placeholders}) AND (fh.current_hash IS NULL OR f.file_hash = fh.current_hash)
        AND (f.valid_until IS NULL OR f.valid_until > ? OR f.decay_model = 'step')
    `)
      .all(...aliases, now) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      target: row.target as string,
      pattern: row.pattern as string,
      evidence: JSON.parse(row.evidence as string) as Evidence[],
      oracleName: row.oracle_name as string,
      fileHash: row.file_hash as string,
      sourceFile: row.source_file as string,
      verifiedAt: row.verified_at as number,
      sessionId: row.session_id as string | undefined,
      confidence: computeDecayedConfidence(
        row.confidence as number,
        row.verified_at as number,
        (row.valid_until as number) || undefined,
        (row.decay_model as string as Fact['decayModel']) || undefined,
        now,
      ),
      validUntil: (row.valid_until as number) || undefined,
      decayModel: (row.decay_model as string as Fact['decayModel']) || undefined,
      tierReliability: (row.tier_reliability as number) ?? undefined,
    }));
  }

  /**
   * List all non-stale facts, most recent first.
   * Used by the API `/api/v1/facts` endpoint.
   */
  listFacts(limit = 200): Fact[] {
    const now = Date.now();
    const rows = this.db
      .query(`
      SELECT f.* FROM facts f
      LEFT JOIN file_hashes fh ON f.source_file = fh.path
      WHERE (fh.current_hash IS NULL OR f.file_hash = fh.current_hash)
        AND (f.valid_until IS NULL OR f.valid_until > ? OR f.decay_model = 'step')
      ORDER BY f.verified_at DESC
      LIMIT ?
    `)
      .all(now, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      target: row.target as string,
      pattern: row.pattern as string,
      evidence: JSON.parse(row.evidence as string) as Evidence[],
      oracleName: row.oracle_name as string,
      fileHash: row.file_hash as string,
      sourceFile: row.source_file as string,
      verifiedAt: row.verified_at as number,
      sessionId: row.session_id as string | undefined,
      confidence: computeDecayedConfidence(
        row.confidence as number,
        row.verified_at as number,
        (row.valid_until as number) || undefined,
        (row.decay_model as string as Fact['decayModel']) || undefined,
        now,
      ),
      validUntil: (row.valid_until as number) || undefined,
      decayModel: (row.decay_model as string as Fact['decayModel']) || undefined,
      tierReliability: (row.tier_reliability as number) ?? undefined,
    }));
  }

  /** Update the stored hash for a file path. Triggers cascade invalidation via SQLite trigger. */
  updateFileHash(filePath: string, hash: string): void {
    const now = Date.now();
    const paths = this.pathAliases(filePath);
    for (const path of paths) {
      const existing = this.db.query('SELECT path FROM file_hashes WHERE path = ?').get(path);
      if (existing) {
        this.db.query('UPDATE file_hashes SET current_hash = ?, updated_at = ? WHERE path = ?').run(hash, now, path);
      } else {
        this.db.query('INSERT INTO file_hashes (path, current_hash, updated_at) VALUES (?, ?, ?)').run(path, hash, now);
      }
    }

    // ECP §4.5: Invalidate facts whose falsifiable_by includes this file path
    const placeholders = paths.map(() => '?').join(', ');
    this.db
      .query(`
      DELETE FROM facts WHERE id IN (
        SELECT fact_id FROM falsifiable_conditions
        WHERE scope = 'file' AND target IN (${placeholders}) AND event = 'content-change'
      )
    `)
      .run(...paths);
  }

  /**
   * Store parsed falsifiable_by conditions for a fact (ECP spec §4.5).
   * Called after storeFact() with the verdict's falsifiable_by array.
   */
  storeFalsifiableConditions(factId: string, conditions: string[]): void {
    const parsed = parseFalsifiableConditions(conditions);
    for (const p of parsed) {
      if (!p.condition) continue;
      const target = p.condition.scope === 'file' ? this.normalizePath(p.condition.target) : p.condition.target;
      this.db
        .query(
          'INSERT OR IGNORE INTO falsifiable_conditions (fact_id, scope, target, event, raw_condition) VALUES (?, ?, ?, ?, ?)',
        )
        .run(factId, p.condition.scope, target, p.condition.event, p.raw);
    }
  }

  /** Invalidate all facts for a file by recomputing its hash and updating file_hashes. */
  invalidateByFile(filePath: string): void {
    const newHash = this.computeFileHash(filePath);
    this.updateFileHash(filePath, newHash);
  }

  /** Get the current stored hash for a file. */
  getFileHash(filePath: string): string | undefined {
    const row = this.db.query('SELECT current_hash FROM file_hashes WHERE path = ?').get(this.normalizePath(filePath)) as
      | { current_hash: string }
      | undefined;
    return row?.current_hash;
  }

  // ── WP-3: Dependency Edges ─────────────────────────────────────────

  /** Store a single dependency edge. */
  storeEdge(fromFile: string, toFile: string, edgeType = 'imports'): void {
    this.db
      .query(`
      INSERT OR REPLACE INTO dependency_edges (from_file, to_file, edge_type, updated_at)
      VALUES (?, ?, ?, unixepoch())
    `)
      .run(this.normalizePath(fromFile), this.normalizePath(toFile), edgeType);
  }

  /** Store multiple dependency edges in a single transaction. */
  storeEdges(edges: Array<{ from: string; to: string; type?: string }>): void {
    const stmt = this.db.query(`
      INSERT OR REPLACE INTO dependency_edges (from_file, to_file, edge_type, updated_at)
      VALUES (?, ?, ?, unixepoch())
    `);
    this.db.exec('BEGIN');
    try {
      for (const edge of edges) {
        stmt.run(this.normalizePath(edge.from), this.normalizePath(edge.to), edge.type ?? 'imports');
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** BFS reverse traversal: find all files that depend on the given file, bounded by maxDepth. */
  queryDependents(file: string, maxDepth = 3): string[] {
    const visited = new Set<string>();
    const root = this.normalizePath(file);
    let frontier = [root];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];
      for (const current of frontier) {
        const rows = this.db.query('SELECT from_file FROM dependency_edges WHERE to_file = ?').all(current) as Array<{
          from_file: string;
        }>;
        for (const row of rows) {
          if (row.from_file !== root && !visited.has(row.from_file)) {
            visited.add(row.from_file);
            nextFrontier.push(row.from_file);
          }
        }
      }
      frontier = nextFrontier;
    }

    return Array.from(visited);
  }

  /** BFS forward traversal: find all files that the given file depends on, bounded by maxDepth. */
  queryDependencies(file: string, maxDepth = 3): string[] {
    const visited = new Set<string>();
    const root = this.normalizePath(file);
    let frontier = [root];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];
      for (const current of frontier) {
        const rows = this.db.query('SELECT to_file FROM dependency_edges WHERE from_file = ?').all(current) as Array<{
          to_file: string;
        }>;
        for (const row of rows) {
          if (row.to_file !== root && !visited.has(row.to_file)) {
            visited.add(row.to_file);
            nextFrontier.push(row.to_file);
          }
        }
      }
      frontier = nextFrontier;
    }

    return Array.from(visited);
  }

  /** Remove all edges originating from the given file. */
  clearEdgesForFile(file: string): void {
    this.db.query('DELETE FROM dependency_edges WHERE from_file = ?').run(this.normalizePath(file));
  }

  // ── FP-B: Typed Causal Edge Adapters ─────────────────────────────

  /** Store a typed CausalEdge, mapping to the existing recordCausalEdge store. */
  storeCausalEdgeTyped(edge: {
    fromFile: string;
    toFile: string;
    edgeType: string;
    confidence: number;
  }): void {
    this.recordCausalEdge(edge.fromFile, edge.toFile, edge.edgeType, edge.confidence);
  }

  /** Batch store typed CausalEdges. */
  storeCausalEdgesTyped(
    edges: Array<{ fromFile: string; toFile: string; edgeType: string; confidence: number }>,
  ): void {
    for (const edge of edges) {
      this.storeCausalEdgeTyped(edge);
    }
  }

  /** Count total causal edges in the graph. */
  getCausalEdgeCount(): number {
    const row = this.db.query('SELECT COUNT(*) as cnt FROM causal_edges').get() as {
      cnt: number;
    } | null;
    return row?.cnt ?? 0;
  }

  // ── WP-5: Causal Edges (Phase 5 — Stream D1) ──────────────────────

  /** Record a causal relationship: change to sourceFile broke targetFile (detected by oracle). */
  recordCausalEdge(sourceFile: string, targetFile: string, oracleName: string, confidence: number): void {
    const now = Date.now();
    const source = this.normalizePath(sourceFile);
    const target = this.normalizePath(targetFile);
    this.db
      .query(`
      INSERT INTO causal_edges (source_file, target_file, oracle_name, confidence, observed_at, observation_count, last_observed_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(source_file, target_file, oracle_name) DO UPDATE SET
        confidence = ?,
        observation_count = observation_count + 1,
        last_observed_at = ?
    `)
      .run(source, target, oracleName, confidence, now, now, confidence, now);
  }

  /** BFS over causal_edges to find all transitively affected files. */
  queryCausalDependents(file: string, maxDepth = 3): string[] {
    const visited = new Set<string>();
    const root = this.normalizePath(file);
    let frontier = [root];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];
      for (const current of frontier) {
        const rows = this.db
          .query('SELECT target_file FROM causal_edges WHERE source_file = ?')
          .all(current) as Array<{ target_file: string }>;
        for (const row of rows) {
          if (row.target_file !== root && !visited.has(row.target_file)) {
            visited.add(row.target_file);
            nextFrontier.push(row.target_file);
          }
        }
      }
      frontier = nextFrontier;
    }

    return Array.from(visited);
  }

  /** Get direct causal edges from/to a file. */
  getCausalEdges(file: string): Array<{
    sourceFile: string;
    targetFile: string;
    oracleName: string;
    confidence: number;
    observationCount: number;
    lastObservedAt: number;
  }> {
    const target = this.normalizePath(file);
    const rows = this.db
      .query('SELECT * FROM causal_edges WHERE source_file = ? OR target_file = ?')
      .all(target, target) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      sourceFile: r.source_file as string,
      targetFile: r.target_file as string,
      oracleName: r.oracle_name as string,
      confidence: r.confidence as number,
      observationCount: r.observation_count as number,
      lastObservedAt: r.last_observed_at as number,
    }));
  }

  /** Remove causal edges not observed recently (default 90 days). */
  pruneStaleCausalEdges(maxAgeDays = 90): number {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const result = this.db.run('DELETE FROM causal_edges WHERE last_observed_at < ?', [cutoff]);
    return result.changes;
  }

  /** Close the database connection, checkpointing the WAL first to keep it small. */
  close(): void {
    try {
      // Truncate WAL before close — prevents bloat that blocks event loop on next open
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // Best-effort — don't prevent close
    }
    this.db.close();
  }
}
