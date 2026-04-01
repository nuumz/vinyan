import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { SCHEMA_SQL } from "./schema.ts";
import { runRetention, DEFAULT_RETENTION, type RetentionConfig } from "./retention.ts";
import { parseFalsifiableConditions } from "../oracle/falsifiable-parser.ts";
import type { Evidence, Fact } from "../core/types.ts";

export class WorldGraph {
  private db: Database;
  private storeCount = 0;
  private retentionInterval: number;
  private retentionConfig: RetentionConfig;

  constructor(dbPath: string = ":memory:", options?: { retention?: Partial<RetentionConfig>; retentionInterval?: number }) {
    this.retentionConfig = { ...DEFAULT_RETENTION, ...options?.retention };
    this.retentionInterval = options?.retentionInterval ?? 100;
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA_SQL);

    // Safe additive migration for ECP temporal context columns (Gap 3)
    try { this.db.exec("ALTER TABLE facts ADD COLUMN valid_until INTEGER"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE facts ADD COLUMN decay_model TEXT DEFAULT 'none'"); } catch { /* column exists */ }
  }

  /** Compute content-hash ID for a fact (deterministic deduplication). */
  private computeFactId(target: string, pattern: string, evidence: Evidence[]): string {
    const content = JSON.stringify({ target, pattern, evidence });
    return createHash("sha256").update(content).digest("hex");
  }

  /** Compute SHA-256 hash of a file's contents. */
  computeFileHash(filePath: string): string {
    const content = readFileSync(filePath);
    return createHash("sha256").update(content).digest("hex");
  }

  /** Store a verified fact in the World Graph. */
  storeFact(fact: Omit<Fact, "id">): Fact {
    const id = this.computeFactId(fact.target, fact.pattern, fact.evidence);
    this.db.query(`
      INSERT OR REPLACE INTO facts (id, target, pattern, evidence, oracle_name, file_hash, source_file, verified_at, session_id, confidence, valid_until, decay_model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      fact.target,
      fact.pattern,
      JSON.stringify(fact.evidence),
      fact.oracle_name,
      fact.file_hash,
      fact.source_file,
      fact.verified_at,
      fact.session_id ?? null,
      fact.confidence,
      fact.valid_until ?? null,
      fact.decay_model ?? "none",
    );

    // Populate evidence-file junction table for cross-file cascade invalidation
    const evidenceFiles = new Set(fact.evidence.map((e) => e.file).filter(Boolean));
    for (const filePath of evidenceFiles) {
      this.db.query(
        "INSERT OR IGNORE INTO fact_evidence_files (fact_id, file_path) VALUES (?, ?)",
      ).run(id, filePath);
    }

    // Run retention policy periodically
    this.storeCount++;
    if (this.storeCount % this.retentionInterval === 0) {
      runRetention(this.db, this.retentionConfig);
    }

    return { ...fact, id };
  }

  /**
   * Query all facts for a given target (file path or symbol).
   * A4: Excludes stale facts whose source file hash no longer matches.
   */
  queryFacts(target: string): Fact[] {
    // LEFT JOIN: facts without a tracked file hash are preserved (system-provided facts).
    // Facts whose file hash mismatches current_hash are excluded (stale).
    // ECP §3.6: Exclude fully expired facts (valid_until passed), except step-decay (never fully expires).
    const now = Date.now();
    const rows = this.db.query(`
      SELECT f.* FROM facts f
      LEFT JOIN file_hashes fh ON f.source_file = fh.path
      WHERE f.target = ? AND (fh.current_hash IS NULL OR f.file_hash = fh.current_hash)
        AND (f.valid_until IS NULL OR f.valid_until > ? OR f.decay_model = 'step')
    `).all(target, now) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      target: row.target as string,
      pattern: row.pattern as string,
      evidence: JSON.parse(row.evidence as string) as Evidence[],
      oracle_name: row.oracle_name as string,
      file_hash: row.file_hash as string,
      source_file: row.source_file as string,
      verified_at: row.verified_at as number,
      session_id: row.session_id as string | undefined,
      confidence: row.confidence as number,
      valid_until: (row.valid_until as number) || undefined,
      decay_model: (row.decay_model as string as Fact["decay_model"]) || undefined,
    }));
  }

  /** Update the stored hash for a file path. Triggers cascade invalidation via SQLite trigger. */
  updateFileHash(filePath: string, hash: string): void {
    const now = Date.now();
    const existing = this.db.query("SELECT path FROM file_hashes WHERE path = ?").get(filePath);
    if (existing) {
      this.db.query("UPDATE file_hashes SET current_hash = ?, updated_at = ? WHERE path = ?").run(hash, now, filePath);
    } else {
      this.db.query("INSERT INTO file_hashes (path, current_hash, updated_at) VALUES (?, ?, ?)").run(filePath, hash, now);
    }

    // ECP §4.5: Invalidate facts whose falsifiable_by includes this file path
    this.db.query(`
      DELETE FROM facts WHERE id IN (
        SELECT fact_id FROM falsifiable_conditions
        WHERE scope = 'file' AND target = ? AND event = 'content-change'
      )
    `).run(filePath);
  }

  /**
   * Store parsed falsifiable_by conditions for a fact (ECP spec §4.5).
   * Called after storeFact() with the verdict's falsifiable_by array.
   */
  storeFalsifiableConditions(factId: string, conditions: string[]): void {
    const parsed = parseFalsifiableConditions(conditions);
    for (const p of parsed) {
      if (!p.condition) continue;
      this.db.query(
        "INSERT OR IGNORE INTO falsifiable_conditions (fact_id, scope, target, event, raw_condition) VALUES (?, ?, ?, ?, ?)",
      ).run(factId, p.condition.scope, p.condition.target, p.condition.event, p.raw);
    }
  }

  /** Invalidate all facts for a file by recomputing its hash and updating file_hashes. */
  invalidateByFile(filePath: string): void {
    const newHash = this.computeFileHash(filePath);
    this.updateFileHash(filePath, newHash);
  }

  /** Get the current stored hash for a file. */
  getFileHash(filePath: string): string | undefined {
    const row = this.db.query("SELECT current_hash FROM file_hashes WHERE path = ?").get(filePath) as
      | { current_hash: string }
      | undefined;
    return row?.current_hash;
  }

  // ── WP-3: Dependency Edges ─────────────────────────────────────────

  /** Store a single dependency edge. */
  storeEdge(fromFile: string, toFile: string, edgeType = "imports"): void {
    this.db.query(`
      INSERT OR REPLACE INTO dependency_edges (from_file, to_file, edge_type, updated_at)
      VALUES (?, ?, ?, unixepoch())
    `).run(fromFile, toFile, edgeType);
  }

  /** Store multiple dependency edges in a single transaction. */
  storeEdges(edges: Array<{ from: string; to: string; type?: string }>): void {
    const stmt = this.db.query(`
      INSERT OR REPLACE INTO dependency_edges (from_file, to_file, edge_type, updated_at)
      VALUES (?, ?, ?, unixepoch())
    `);
    this.db.exec("BEGIN");
    try {
      for (const edge of edges) {
        stmt.run(edge.from, edge.to, edge.type ?? "imports");
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** BFS reverse traversal: find all files that depend on the given file, bounded by maxDepth. */
  queryDependents(file: string, maxDepth = 3): string[] {
    const visited = new Set<string>();
    let frontier = [file];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];
      for (const current of frontier) {
        const rows = this.db.query(
          "SELECT from_file FROM dependency_edges WHERE to_file = ?",
        ).all(current) as Array<{ from_file: string }>;
        for (const row of rows) {
          if (row.from_file !== file && !visited.has(row.from_file)) {
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
    let frontier = [file];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];
      for (const current of frontier) {
        const rows = this.db.query(
          "SELECT to_file FROM dependency_edges WHERE from_file = ?",
        ).all(current) as Array<{ to_file: string }>;
        for (const row of rows) {
          if (row.to_file !== file && !visited.has(row.to_file)) {
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
    this.db.query("DELETE FROM dependency_edges WHERE from_file = ?").run(file);
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
