/**
 * VinyanDB — shared SQLite database for trace storage and model parameters.
 *
 * Phase 5: Uses MigrationRunner for versioned schema management.
 * Path: <workspace>/.vinyan/vinyan.db
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { ALL_MIGRATIONS, MigrationRunner } from './migrations/index.ts';
import { migratePipelineConfidenceColumns, migrateThinkingColumns, migrateTranscriptColumns } from './trace-schema.ts';

export class VinyanDB {
  private db: Database;

  constructor(dbPath: string) {
    // Ensure parent directory exists
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');

    // Apply versioned migrations (TDD §20)
    const runner = new MigrationRunner();
    runner.migrate(this.db, ALL_MIGRATIONS);

    // Safe column additions for EHD Phase 3 (idempotent ALTER TABLE)
    migratePipelineConfidenceColumns(this.db);
    // Safe column additions for Phase 6 transcript storage (idempotent)
    migrateTranscriptColumns(this.db);
    // Safe column additions for Extensible Thinking (idempotent)
    migrateThinkingColumns(this.db);
  }

  getDb(): Database {
    return this.db;
  }

  /** Flush WAL file to prevent unbounded growth in long-running sessions. */
  checkpoint(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (err) {
      console.warn('[vinyan] WAL checkpoint failed:', err);
    }
  }

  close(): void {
    this.checkpoint();
    this.db.close();
  }
}
