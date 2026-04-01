/**
 * Pattern Store — CRUD for ExtractedPattern records in SQLite.
 *
 * Source of truth: spec/tdd.md §12B (Sleep Cycle)
 */
import type { Database } from 'bun:sqlite';
import type { ExtractedPattern } from '../orchestrator/types.ts';

export class PatternStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  insert(pattern: ExtractedPattern): void {
    this.db.run(
      `INSERT OR REPLACE INTO extracted_patterns
       (id, type, description, frequency, confidence, task_type_signature,
        approach, compared_approach, quality_delta, source_trace_ids,
        created_at, expires_at, decay_weight, derived_from,
        worker_id, compared_worker_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        pattern.id,
        pattern.type,
        pattern.description,
        pattern.frequency,
        pattern.confidence,
        pattern.taskTypeSignature,
        pattern.approach ?? null,
        pattern.comparedApproach ?? null,
        pattern.qualityDelta ?? null,
        JSON.stringify(pattern.sourceTraceIds),
        pattern.createdAt,
        pattern.expiresAt ?? null,
        pattern.decayWeight,
        pattern.derivedFrom ?? null,
        pattern.workerId ?? null,
        pattern.comparedWorkerId ?? null,
      ],
    );
  }

  queryByType(type: ExtractedPattern['type'], limit = 100): ExtractedPattern[] {
    const rows = this.db
      .prepare(`SELECT * FROM extracted_patterns WHERE type = ? ORDER BY created_at DESC LIMIT ?`)
      .all(type, limit) as PatternRow[];
    return rows.map(rowToPattern);
  }

  findByTaskSignature(signature: string, limit = 50): ExtractedPattern[] {
    const rows = this.db
      .prepare(`SELECT * FROM extracted_patterns WHERE task_type_signature = ? ORDER BY confidence DESC LIMIT ?`)
      .all(signature, limit) as PatternRow[];
    return rows.map(rowToPattern);
  }

  findActive(minDecayWeight = 0.1): ExtractedPattern[] {
    const rows = this.db
      .prepare(`SELECT * FROM extracted_patterns WHERE decay_weight >= ? ORDER BY confidence DESC`)
      .all(minDecayWeight) as PatternRow[];
    return rows.map(rowToPattern);
  }

  updateDecayWeight(id: string, newWeight: number): void {
    this.db.run(`UPDATE extracted_patterns SET decay_weight = ? WHERE id = ?`, [newWeight, id]);
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM extracted_patterns`).get() as { cnt: number };
    return row.cnt;
  }

  countByType(type: 'anti-pattern' | 'success-pattern'): number {
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM extracted_patterns WHERE type = ?`).get(type) as {
      cnt: number;
    };
    return row.cnt;
  }

  // Sleep cycle run tracking
  recordCycleStart(cycleId: string): void {
    this.db.run(`INSERT INTO sleep_cycle_runs (id, started_at, status) VALUES (?, ?, 'running')`, [
      cycleId,
      Date.now(),
    ]);
  }

  recordCycleComplete(cycleId: string, tracesAnalyzed: number, patternsFound: number): void {
    this.db.run(
      `UPDATE sleep_cycle_runs SET completed_at = ?, traces_analyzed = ?, patterns_found = ?, status = 'completed'
       WHERE id = ?`,
      [Date.now(), tracesAnalyzed, patternsFound, cycleId],
    );
  }

  countCycleRuns(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM sleep_cycle_runs WHERE status = 'completed'`).get() as {
      cnt: number;
    };
    return row.cnt;
  }

  /** PH3.5: Get the started_at timestamps of the last N completed sleep cycles. */
  getRecentCycleTimestamps(count: number): number[] {
    const rows = this.db
      .prepare(
        `SELECT started_at FROM sleep_cycle_runs WHERE status = 'completed'
       ORDER BY started_at DESC LIMIT ?`,
      )
      .all(count) as { started_at: number }[];
    return rows.map((r) => r.started_at);
  }

  /** PH3.5: Follow derivedFrom chain for pattern lineage. */
  findLineage(patternId: string): ExtractedPattern[] {
    const chain: ExtractedPattern[] = [];
    let currentId: string | undefined = patternId;
    const visited = new Set<string>();

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const row = this.db.prepare(`SELECT * FROM extracted_patterns WHERE id = ?`).get(currentId) as PatternRow | null;
      if (!row) break;
      const pattern = rowToPattern(row);
      chain.push(pattern);
      currentId = pattern.derivedFrom;
    }

    return chain;
  }
}

// ── Row mapping ────────────────────────────────────────────────────────

interface PatternRow {
  id: string;
  type: string;
  description: string;
  frequency: number;
  confidence: number;
  task_type_signature: string;
  approach: string | null;
  compared_approach: string | null;
  quality_delta: number | null;
  source_trace_ids: string;
  created_at: number;
  expires_at: number | null;
  decay_weight: number;
  derived_from: string | null;
  worker_id: string | null;
  compared_worker_id: string | null;
}

function rowToPattern(row: PatternRow): ExtractedPattern {
  return {
    id: row.id,
    type: row.type as ExtractedPattern['type'],
    description: row.description,
    frequency: row.frequency,
    confidence: row.confidence,
    taskTypeSignature: row.task_type_signature,
    approach: row.approach ?? undefined,
    comparedApproach: row.compared_approach ?? undefined,
    qualityDelta: row.quality_delta ?? undefined,
    sourceTraceIds: JSON.parse(row.source_trace_ids),
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? undefined,
    decayWeight: row.decay_weight,
    derivedFrom: row.derived_from ?? undefined,
    workerId: row.worker_id ?? undefined,
    comparedWorkerId: row.compared_worker_id ?? undefined,
  };
}
