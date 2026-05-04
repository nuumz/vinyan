/**
 * `PersonaFactCitationsStore` — Phase C1 substrate for the
 * Reality-Anchoring layer (DelusionDetector + PsychosisMonitor).
 *
 * Records (persona, fact-target, hash) triples whenever a `verified`
 * oracle verdict fires for a persona's task. Survives world-graph
 * cascades (no FK to `facts`) so citations remain queryable after a
 * file mutates and the corresponding fact row is invalidated.
 *
 * Bounded write rate: phase-verify writes one row per (verified
 * verdict × file-target) — typical 3-10 rows per task. Sleep-cycle
 * retention prunes rows older than the configured window
 * (`world_graph.retention_max_age_days`, default 30 days).
 *
 * The class is intentionally minimal — recording, three filtered
 * reads, and a stale-citation API the DelusionDetector consumes. Bulk
 * analytics live downstream in C3 (PsychosisMonitor).
 */
import type { Database } from 'bun:sqlite';

export interface PersonaFactCitationRecord {
  personaId: string;
  factId: string;
  citedAtHash: string;
  citedAtTs: number;
  taskId: string;
  phase: string;
  claimExcerpt: string;
}

interface PersonaFactCitationRow {
  persona_id: string;
  fact_id: string;
  cited_at_hash: string;
  cited_at_ts: number;
  task_id: string;
  phase: string;
  claim_excerpt: string;
}

export interface RecordCitationInput {
  readonly personaId: string;
  readonly factId: string;
  readonly citedAtHash: string;
  readonly taskId: string;
  readonly phase: string;
  readonly claimExcerpt: string;
  readonly citedAtTs?: number;
}

/** Entry shape for `listStaleForPersona`'s current-hash lookup. */
export type CurrentHashLookup = (factId: string) => string | undefined;

/** A citation whose recorded hash no longer matches the current source hash. */
export interface StaleCitation extends PersonaFactCitationRecord {
  /** Current hash of `factId` reported by the lookup (`undefined` when factId is gone). */
  readonly currentHash: string | undefined;
}

const CLAIM_EXCERPT_MAX_CHARS = 256;

export class PersonaFactCitationsStore {
  constructor(private readonly db: Database) {}

  /**
   * Append a citation row. Idempotent on (persona_id, fact_id, task_id,
   * cited_at_ts) — duplicate writes within a single millisecond are
   * silently dropped via INSERT OR IGNORE.
   *
   * `claim_excerpt` is truncated to {@link CLAIM_EXCERPT_MAX_CHARS}
   * characters before insert. Truncation is deterministic (slice from
   * index 0) so the same input always produces the same row.
   */
  recordCitation(input: RecordCitationInput): void {
    const ts = input.citedAtTs ?? Date.now();
    const excerpt =
      input.claimExcerpt.length <= CLAIM_EXCERPT_MAX_CHARS
        ? input.claimExcerpt
        : input.claimExcerpt.slice(0, CLAIM_EXCERPT_MAX_CHARS);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO persona_fact_citations
           (persona_id, fact_id, cited_at_hash, cited_at_ts, task_id, phase, claim_excerpt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.personaId, input.factId, input.citedAtHash, ts, input.taskId, input.phase, excerpt);
  }

  /** Recent citations for a persona, newest-first. Used by DelusionDetector. */
  listForPersona(personaId: string, limit = 1000): PersonaFactCitationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM persona_fact_citations
          WHERE persona_id = ?
          ORDER BY cited_at_ts DESC
          LIMIT ?`,
      )
      .all(personaId, limit) as PersonaFactCitationRow[];
    return rows.map(rowToRecord);
  }

  /**
   * Recent citations of a single fact across all personas. When a file
   * mutates the operator can run this to surface every persona whose
   * cached belief is now stale (cross-persona delusion impact).
   */
  listForFact(factId: string, limit = 1000): PersonaFactCitationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM persona_fact_citations
          WHERE fact_id = ?
          ORDER BY cited_at_ts DESC
          LIMIT ?`,
      )
      .all(factId, limit) as PersonaFactCitationRow[];
    return rows.map(rowToRecord);
  }

  /** Citations belonging to a single task, in citation order. Used by trace replay. */
  listForTask(taskId: string): PersonaFactCitationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM persona_fact_citations
          WHERE task_id = ?
          ORDER BY cited_at_ts ASC`,
      )
      .all(taskId) as PersonaFactCitationRow[];
    return rows.map(rowToRecord);
  }

  /**
   * Citations for `personaId` whose recorded hash differs from the
   * current hash returned by `currentHash(factId)`. Returns most recent
   * citation per `(persona_id, fact_id)` pair so the detector doesn't
   * raise duplicate alerts when a persona cited the same fact multiple
   * times — only the latest belief matters for "is the persona's
   * current model stale?"
   *
   * `currentHash(factId)` returns:
   *   - `string` → factId still exists; compare against `cited_at_hash`
   *   - `undefined` → factId no longer reachable (file deleted / moved);
   *     citation is stale by gone-source
   *
   * The hash-equality check is plain string compare — both sides are
   * SHA-256 hex digests written by the world-graph trigger.
   */
  listStaleForPersona(personaId: string, currentHash: CurrentHashLookup, limit = 1000): StaleCitation[] {
    // Pick latest citation per (persona, fact) using row_number window
    // function. SQLite supports it from 3.25+; bun:sqlite is well above.
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT *,
                  ROW_NUMBER() OVER (
                    PARTITION BY persona_id, fact_id
                    ORDER BY cited_at_ts DESC
                  ) AS rn
             FROM persona_fact_citations
            WHERE persona_id = ?
         )
         WHERE rn = 1
         ORDER BY cited_at_ts DESC
         LIMIT ?`,
      )
      .all(personaId, limit) as Array<PersonaFactCitationRow & { rn: number }>;
    const out: StaleCitation[] = [];
    for (const row of rows) {
      const current = currentHash(row.fact_id);
      if (current === row.cited_at_hash) continue;
      out.push({ ...rowToRecord(row), currentHash: current });
    }
    return out;
  }

  /** Delete citations older than `cutoffTs`. Returns the row count removed. */
  pruneOlderThan(cutoffTs: number): number {
    const result = this.db.prepare('DELETE FROM persona_fact_citations WHERE cited_at_ts < ?').run(cutoffTs);
    return Number(result.changes ?? 0);
  }

  /**
   * Delete citations older than `cutoffTs` belonging to a single persona.
   * Used by Phase C4's `rebuild` sub-action — when a persona enters
   * recovery, citations older than the rebuild horizon are dropped so
   * the next verify cycle writes fresh ones at current hashes.
   * Returns the row count removed.
   */
  pruneOlderThanForPersona(personaId: string, cutoffTs: number): number {
    const result = this.db
      .prepare('DELETE FROM persona_fact_citations WHERE persona_id = ? AND cited_at_ts < ?')
      .run(personaId, cutoffTs);
    return Number(result.changes ?? 0);
  }

  /**
   * Delete the persona's "superseded" citations — for each `fact_id` the
   * persona has cited multiple times, keep ONLY the latest (largest
   * `cited_at_ts`); delete every older entry.
   *
   * Semantically: collapses the persona's belief ledger so that exactly
   * one citation per fact remains. Used by Phase C4's `prune` sub-action.
   * Different from `pruneOlderThanForPersona` (which is time-based) and
   * different from `listStaleForPersona` (which compares against current
   * source hash) — this method handles the case where the persona has
   * REPLACED their belief about a fact (e.g., re-cited at a different
   * hash in a later task) but the old citation row was kept appended.
   *
   * Returns the row count removed. Idempotent: repeated calls remove
   * nothing further once deduped.
   */
  pruneSupersededForPersona(personaId: string): number {
    // For each (persona, fact) pair, find MAX(cited_at_ts) and delete
    // every row that doesn't match. SQLite supports tuple-IN subqueries
    // since 3.15+; bun:sqlite ships well above.
    const sql = `
      DELETE FROM persona_fact_citations
      WHERE persona_id = ?
        AND (fact_id, cited_at_ts) NOT IN (
          SELECT fact_id, MAX(cited_at_ts)
            FROM persona_fact_citations
           WHERE persona_id = ?
           GROUP BY fact_id
        )
    `;
    const result = this.db.prepare(sql).run(personaId, personaId);
    return Number(result.changes ?? 0);
  }

  /** Total citation count for a persona — cheap summary for sleep-cycle health checks. */
  countForPersona(personaId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM persona_fact_citations WHERE persona_id = ?')
      .get(personaId) as { n: number } | undefined;
    return row?.n ?? 0;
  }
}

function rowToRecord(row: PersonaFactCitationRow): PersonaFactCitationRecord {
  return {
    personaId: row.persona_id,
    factId: row.fact_id,
    citedAtHash: row.cited_at_hash,
    citedAtTs: row.cited_at_ts,
    taskId: row.task_id,
    phase: row.phase,
    claimExcerpt: row.claim_excerpt,
  };
}
