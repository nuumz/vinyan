/**
 * Provider Trust Store — K2 per-provider outcome tracking in SQLite.
 *
 * Records success/failure per provider to compute Wilson LB trust scores.
 * Follows dual-write pattern (memory + SQLite, best-effort DB) consistent
 * with PatternStore, OracleAccuracyStore.
 *
 * Schema is self-initialized (CREATE TABLE IF NOT EXISTS) — no migration needed.
 */
import type { Database } from 'bun:sqlite';

export interface ProviderTrustRecord {
  provider: string;
  successes: number;
  failures: number;
  lastUpdated: number;
}

export class ProviderTrustStore {
  private db: Database;
  /** In-memory cache for hot-path reads. */
  private cache = new Map<string, { successes: number; failures: number }>();

  constructor(db: Database) {
    this.db = db;
    this.initSchema();
    this.warmCache();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_trust (
        provider TEXT PRIMARY KEY,
        successes INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0,
        last_updated INTEGER NOT NULL
      )
    `);
  }

  private warmCache(): void {
    const rows = this.db
      .prepare('SELECT provider, successes, failures FROM provider_trust')
      .all() as Array<{ provider: string; successes: number; failures: number }>;
    for (const row of rows) {
      this.cache.set(row.provider, { successes: row.successes, failures: row.failures });
    }
  }

  /** Record a task outcome for a provider. */
  recordOutcome(provider: string, success: boolean): void {
    const existing = this.cache.get(provider) ?? { successes: 0, failures: 0 };
    if (success) existing.successes++;
    else existing.failures++;
    this.cache.set(provider, existing);

    // Best-effort SQLite write
    try {
      this.db.run(
        `INSERT INTO provider_trust (provider, successes, failures, last_updated)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET
           successes = excluded.successes,
           failures = excluded.failures,
           last_updated = excluded.last_updated`,
        [provider, existing.successes, existing.failures, Date.now()],
      );
    } catch {
      // Memory cache is authoritative — DB write failure is non-fatal
    }
  }

  /** Get cached trust data for all known providers. */
  getAllProviders(): ProviderTrustRecord[] {
    return Array.from(this.cache.entries()).map(([provider, data]) => ({
      provider,
      successes: data.successes,
      failures: data.failures,
      lastUpdated: Date.now(),
    }));
  }

  /** Get trust data for a specific provider. */
  getProvider(provider: string): ProviderTrustRecord | null {
    const data = this.cache.get(provider);
    if (!data) return null;
    return { provider, ...data, lastUpdated: Date.now() };
  }
}
