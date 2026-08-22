/**
 * Cost Ledger — persistent time-series cost records.
 *
 * Follows dual-write pattern (in-memory cache + SQLite best-effort)
 * consistent with ProviderTrustStore, PatternStore.
 *
 * A3 compliant: deterministic queries, no LLM.
 * A5 compliant: cost_tier distinguishes billing vs estimated data.
 *
 * Source of truth: Economy OS plan §E1.4
 */
import type { Database } from 'bun:sqlite';
import type { VinyanBus } from '../core/bus.ts';

export interface CostLedgerEntry {
  id: string;
  taskId: string;
  workerId: string | null;
  engineId: string;
  timestamp: number;
  tokens_input: number;
  tokens_output: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  duration_ms: number;
  oracle_invocations: number;
  computed_usd: number;
  cost_tier: 'billing' | 'estimated';
  routing_level: number;
  task_type_signature: string | null;
  /**
   * ExecutionTrace this row was priced from. Process-local: the `cost_ledger`
   * table has no column for it (no new migration), so rows warmed from SQLite
   * carry `undefined`. Callers that need to find the row they just wrote —
   * phase-learn's cost calibration — use `queryByTraceId` within the same
   * process; anything durable must key off `taskId`.
   */
  traceId?: string;
}

interface AggregatedCost {
  total_usd: number;
  count: number;
}

/**
 * Cap on the in-memory cache. Matches the `warmCache` boot LIMIT so a
 * long-lived `vinyan serve` cannot grow the array without bound now that
 * cost accounting is on by default. Oldest entries are dropped first; the
 * SQLite table remains the complete record.
 */
const MAX_CACHE_ENTRIES = 10_000;

export class CostLedger {
  private db: Database;
  private cache: CostLedgerEntry[] = [];
  private bus?: VinyanBus;

  constructor(db: Database, bus?: VinyanBus) {
    this.db = db;
    this.bus = bus;
    this.warmCache();
  }

  private warmCache(): void {
    try {
      const rows = this.db.prepare('SELECT * FROM cost_ledger ORDER BY timestamp DESC LIMIT 10000').all() as Array<
        Record<string, unknown>
      >;
      for (const row of rows) {
        this.cache.push(this.rowToEntry(row));
      }
    } catch {
      // Table may not exist yet (migration pending) — start empty
    }
  }

  private rowToEntry(row: Record<string, unknown>): CostLedgerEntry {
    return {
      id: row.id as string,
      taskId: row.task_id as string,
      workerId: (row.worker_id as string) || null,
      engineId: row.engine_id as string,
      timestamp: row.timestamp as number,
      tokens_input: row.tokens_input as number,
      tokens_output: row.tokens_output as number,
      cache_read_tokens: row.cache_read_tokens as number,
      cache_creation_tokens: row.cache_creation_tokens as number,
      duration_ms: row.duration_ms as number,
      oracle_invocations: row.oracle_invocations as number,
      computed_usd: row.computed_usd as number,
      cost_tier: row.cost_tier as 'billing' | 'estimated',
      routing_level: row.routing_level as number,
      task_type_signature: (row.task_type_signature as string) || null,
    };
  }

  /** Record a cost entry. */
  record(entry: CostLedgerEntry): void {
    // Cache-first is deliberate and documented below: the in-memory cache is
    // authoritative and a DB write failure must not lose the row (A9
    // fail-open). The cap keeps that bounded.
    this.cache.push(entry);
    if (this.cache.length > MAX_CACHE_ENTRIES) {
      this.cache.splice(0, this.cache.length - MAX_CACHE_ENTRIES);
    }

    // Best-effort SQLite write
    try {
      this.db.run(
        `INSERT INTO cost_ledger (
          id, task_id, worker_id, engine_id, timestamp,
          tokens_input, tokens_output, cache_read_tokens, cache_creation_tokens,
          duration_ms, oracle_invocations, computed_usd, cost_tier,
          routing_level, task_type_signature
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.id,
          entry.taskId,
          entry.workerId,
          entry.engineId,
          entry.timestamp,
          entry.tokens_input,
          entry.tokens_output,
          entry.cache_read_tokens,
          entry.cache_creation_tokens,
          entry.duration_ms,
          entry.oracle_invocations,
          entry.computed_usd,
          entry.cost_tier,
          entry.routing_level,
          entry.task_type_signature,
        ],
      );
    } catch (err) {
      // Memory cache is authoritative — DB write failure is non-fatal.
      // A9: surface as `economy:accounting_failed` so the degradation
      // bridge normalizes the failure for observability while the task
      // continues uninterrupted (fail-open).
      this.bus?.emit('economy:accounting_failed', {
        taskId: entry.taskId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Query entries within a time range (from cache). */
  queryByTimeRange(from: number, to: number): CostLedgerEntry[] {
    return this.cache.filter((e) => e.timestamp >= from && e.timestamp <= to);
  }

  /** Query entries for a specific task. */
  queryByTask(taskId: string): CostLedgerEntry[] {
    return this.cache.filter((e) => e.taskId === taskId);
  }

  /**
   * Query the entries priced from one ExecutionTrace. Process-local — see
   * `CostLedgerEntry.traceId`. Used by phase-learn so cost calibration
   * consumes THIS trace's cost rather than whatever row happened to be last
   * for the task (an earlier phase's row would pin the EMA to the wrong
   * number).
   */
  queryByTraceId(traceId: string): CostLedgerEntry[] {
    return this.cache.filter((e) => e.traceId === traceId);
  }

  /** Query entries for a specific engine. */
  queryByEngine(engineId: string, since?: number): CostLedgerEntry[] {
    return this.cache.filter((e) => e.engineId === engineId && (!since || e.timestamp >= since));
  }

  /** Aggregate cost for a time window. */
  getAggregatedCost(window: 'hour' | 'day' | 'month'): AggregatedCost {
    const now = Date.now();
    let from: number;

    switch (window) {
      case 'hour':
        from = now - 3_600_000;
        break;
      case 'day': {
        const d = new Date(now);
        d.setUTCHours(0, 0, 0, 0);
        from = d.getTime();
        break;
      }
      case 'month': {
        const m = new Date(now);
        m.setUTCDate(1);
        m.setUTCHours(0, 0, 0, 0);
        from = m.getTime();
        break;
      }
    }

    const entries = this.cache.filter((e) => e.timestamp >= from);
    return {
      total_usd: entries.reduce((sum, e) => sum + e.computed_usd, 0),
      count: entries.length,
    };
  }

  /** Total number of entries in cache. */
  count(): number {
    return this.cache.length;
  }

  /** Query entries by task type signature. */
  queryByTaskType(taskTypeSignature: string, since?: number): CostLedgerEntry[] {
    return this.cache.filter((e) => e.task_type_signature === taskTypeSignature && (!since || e.timestamp >= since));
  }

  /** Get percentile token count for a task type at a routing level. */
  getTokenPercentile(taskTypeSignature: string, routingLevel: number, percentile: number): number | null {
    // Zero-token rows (phases that recorded a trace without consuming any
    // model tokens) are not evidence about how many tokens this task type
    // needs. Including them drags the percentile toward zero, which — once
    // fed to DynamicBudgetAllocator — would shrink every subsequent task's
    // budget. Filter them out of the sample rather than at each call site.
    const entries = this.cache.filter(
      (e) =>
        e.task_type_signature === taskTypeSignature &&
        e.routing_level === routingLevel &&
        e.tokens_input + e.tokens_output > 0,
    );
    if (entries.length < 5) return null;

    const sorted = entries.map((e) => e.tokens_input + e.tokens_output).sort((a, b) => a - b);
    const idx = Math.min(Math.floor(sorted.length * percentile), sorted.length - 1);
    return sorted[idx] ?? null;
  }
}
