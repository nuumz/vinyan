/**
 * Provider Trust Store — K2 per-(provider, capability) outcome tracking in SQLite.
 *
 * Records success/failure per provider+capability to compute Wilson LB trust scores.
 * Follows dual-write pattern (memory + SQLite, best-effort DB) consistent
 * with PatternStore, OracleAccuracyStore.
 *
 * Schema is self-initialized (CREATE TABLE IF NOT EXISTS) — no migration needed.
 * K2.1: capability column enables per-capability trust tracking.
 * A4: evidence_hash column binds trust records to content-addressed evidence.
 */
import type { Database } from 'bun:sqlite';

export interface ProviderTrustRecord {
  provider: string;
  capability: string;
  successes: number;
  failures: number;
  lastUpdated: number;
  evidenceHash?: string;
}

/** Cache key: "provider\0capability" */
function cacheKey(provider: string, capability: string): string {
  return `${provider}\0${capability}`;
}

export class ProviderTrustStore {
  private db: Database;
  /** In-memory cache for hot-path reads, keyed by "provider\0capability". */
  private cache = new Map<string, { successes: number; failures: number; evidenceHash?: string }>();

  constructor(db: Database) {
    this.db = db;
    this.initSchema();
    this.warmCache();
  }

  private initSchema(): void {
    // Create new schema with composite PK (provider, capability)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_trust (
        provider TEXT NOT NULL,
        capability TEXT NOT NULL DEFAULT '*',
        successes INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0,
        last_updated INTEGER NOT NULL,
        evidence_hash TEXT,
        PRIMARY KEY (provider, capability)
      )
    `);

    // Migration: add capability + evidence_hash columns if upgrading from old schema
    try {
      this.db.exec(`ALTER TABLE provider_trust ADD COLUMN capability TEXT NOT NULL DEFAULT '*'`);
    } catch {
      // Column already exists — expected on new or already-migrated schemas
    }
    try {
      this.db.exec(`ALTER TABLE provider_trust ADD COLUMN evidence_hash TEXT`);
    } catch {
      // Column already exists
    }
  }

  private warmCache(): void {
    const rows = this.db
      .prepare('SELECT provider, capability, successes, failures, evidence_hash FROM provider_trust')
      .all() as Array<{ provider: string; capability: string; successes: number; failures: number; evidence_hash: string | null }>;
    for (const row of rows) {
      const key = cacheKey(row.provider, row.capability);
      this.cache.set(key, {
        successes: row.successes,
        failures: row.failures,
        evidenceHash: row.evidence_hash ?? undefined,
      });
    }
  }

  /** Record a task outcome for a provider, optionally scoped to a capability. */
  recordOutcome(provider: string, success: boolean, capability = '*', evidenceHash?: string): void {
    const key = cacheKey(provider, capability);
    const existing = this.cache.get(key) ?? { successes: 0, failures: 0 };
    if (success) existing.successes++;
    else existing.failures++;
    if (evidenceHash) existing.evidenceHash = evidenceHash;
    this.cache.set(key, existing);

    // Best-effort SQLite write
    try {
      this.db.run(
        `INSERT INTO provider_trust (provider, capability, successes, failures, last_updated, evidence_hash)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, capability) DO UPDATE SET
           successes = excluded.successes,
           failures = excluded.failures,
           last_updated = excluded.last_updated,
           evidence_hash = COALESCE(excluded.evidence_hash, provider_trust.evidence_hash)`,
        [provider, capability, existing.successes, existing.failures, Date.now(), evidenceHash ?? null],
      );
    } catch {
      // Memory cache is authoritative — DB write failure is non-fatal
    }
  }

  /** Get cached trust data for all known providers (aggregated across capabilities). */
  getAllProviders(): ProviderTrustRecord[] {
    // Aggregate by provider across all capabilities
    const aggregated = new Map<string, { successes: number; failures: number }>();
    for (const [key, data] of this.cache) {
      const provider = key.split('\0')[0]!;
      const existing = aggregated.get(provider) ?? { successes: 0, failures: 0 };
      existing.successes += data.successes;
      existing.failures += data.failures;
      aggregated.set(provider, existing);
    }

    return Array.from(aggregated.entries()).map(([provider, data]) => ({
      provider,
      capability: '*',
      successes: data.successes,
      failures: data.failures,
      lastUpdated: Date.now(),
    }));
  }

  /** Get trust data for a specific provider (aggregated across capabilities). */
  getProvider(provider: string): ProviderTrustRecord | null {
    let totalSuccesses = 0;
    let totalFailures = 0;
    let found = false;
    for (const [key, data] of this.cache) {
      if (key.split('\0')[0] === provider) {
        totalSuccesses += data.successes;
        totalFailures += data.failures;
        found = true;
      }
    }
    if (!found) return null;
    return { provider, capability: '*', successes: totalSuccesses, failures: totalFailures, lastUpdated: Date.now() };
  }

  /** Get trust data for a specific (provider, capability) pair. */
  getProviderCapability(provider: string, capability: string): ProviderTrustRecord | null {
    const data = this.cache.get(cacheKey(provider, capability));
    if (!data) return null;
    return {
      provider,
      capability,
      successes: data.successes,
      failures: data.failures,
      lastUpdated: Date.now(),
      evidenceHash: data.evidenceHash,
    };
  }

  /** Get all providers that have trust data for a specific capability. */
  getProvidersByCapability(capability: string): ProviderTrustRecord[] {
    const results: ProviderTrustRecord[] = [];
    for (const [key, data] of this.cache) {
      const [provider, cap] = key.split('\0');
      if (cap === capability || cap === '*') {
        results.push({
          provider: provider!,
          capability: cap!,
          successes: data.successes,
          failures: data.failures,
          lastUpdated: Date.now(),
          evidenceHash: data.evidenceHash,
        });
      }
    }
    return results;
  }
}
