/**
 * Migration Runner — forward-only versioned schema migrations.
 *
 * Replaces the Phase 0-4 `CREATE TABLE IF NOT EXISTS` pattern with
 * tracked, atomic, additive-only migrations.
 *
 * Source of truth: spec/tdd.md §20
 */
import type { Database } from "bun:sqlite";

export interface Migration {
  version: number;
  description: string;
  up(db: Database): void;
}

export interface MigrateResult {
  applied: number[];   // versions applied in this run
  current: number;     // final version after migration
  pending: number[];   // versions that would be applied (always populated)
}

const SCHEMA_VERSION_DDL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at  INTEGER NOT NULL
);
`;

export class MigrationRunner {
  /** Bootstrap schema_version table and return current version. */
  getCurrentVersion(db: Database): number {
    db.exec(SCHEMA_VERSION_DDL);
    const row = db.query("SELECT MAX(version) as v FROM schema_version").get() as { v: number | null } | null;
    return row?.v ?? 0;
  }

  /** Apply all pending migrations in order. Idempotent. */
  migrate(
    db: Database,
    migrations: Migration[],
    options?: { dryRun?: boolean },
  ): MigrateResult {
    const dryRun = options?.dryRun ?? false;
    const currentVersion = this.getCurrentVersion(db);

    // Sort migrations by version (defensive — callers should provide sorted)
    const sorted = [...migrations].sort((a, b) => a.version - b.version);

    const pending = sorted
      .filter((m) => m.version > currentVersion)
      .map((m) => m.version);

    if (dryRun) {
      return { applied: [], current: currentVersion, pending };
    }

    const applied: number[] = [];

    for (const migration of sorted) {
      if (migration.version <= currentVersion) continue;

      // Each migration runs in its own transaction — atomic per-migration
      const tx = db.transaction(() => {
        migration.up(db);
        db.run(
          "INSERT INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)",
          [migration.version, migration.description, Date.now()],
        );
      });

      tx();
      applied.push(migration.version);
    }

    const finalVersion = applied.length > 0
      ? (applied[applied.length - 1] ?? currentVersion)
      : currentVersion;

    return { applied, current: finalVersion, pending };
  }
}
