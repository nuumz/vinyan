import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { SCHEMA_SQL } from "./schema.ts";
import { runRetention, DEFAULT_RETENTION, type RetentionConfig } from "./retention.ts";
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
      INSERT OR REPLACE INTO facts (id, target, pattern, evidence, oracle_name, file_hash, source_file, verified_at, session_id, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  /** Query all facts for a given target (file path or symbol). */
  queryFacts(target: string): Fact[] {
    const rows = this.db.query("SELECT * FROM facts WHERE target = ?").all(target) as Array<Record<string, unknown>>;
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

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
