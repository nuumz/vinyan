/**
 * RejectedApproachStore — persists failed approaches for cross-task learning.
 *
 * Sources:
 *   - 'task-end': approaches serialized when task completes (success or failure)
 *   - 'eviction': approaches archived before working memory eviction (G2)
 *
 * Design ref: memory-prompt-architecture-system-design.md §2.2a, §4.1
 */
import type { Database } from 'bun:sqlite';

/** 24-hour TTL for transient failures (context-specific). */
const TRANSIENT_TTL_MS = 24 * 60 * 60 * 1000;

export interface RejectedApproachRow {
  id: number;
  task_id: string;
  task_type: string | null;
  file_target: string | null;
  file_hash: string | null;
  approach: string;
  oracle_verdict: string;
  verdict_confidence: number | null;
  failure_oracle: string | null;
  routing_level: number | null;
  source: string;
  created_at: number;
  expires_at: number | null;
  /** Gap 6B: Action verb from task goal for goal-aware cross-task loading. */
  action_verb: string | null;
}

export class RejectedApproachStore {
  private insertStmt;
  private queryByFileAndTypeStmt;
  private queryByFileTypeVerbStmt;
  private queryByTypeStmt;
  private cleanupStmt;

  constructor(private db: Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO rejected_approaches
        (task_id, task_type, file_target, file_hash, approach, oracle_verdict, verdict_confidence, failure_oracle, routing_level, source, created_at, expires_at, action_verb)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.queryByFileAndTypeStmt = db.prepare(`
      SELECT * FROM rejected_approaches
      WHERE file_target = ? AND task_type = ? AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC LIMIT ?
    `);
    // Gap 6B+8A: Prefer verb-matched approaches for cross-task loading
    this.queryByFileTypeVerbStmt = db.prepare(`
      SELECT * FROM rejected_approaches
      WHERE file_target = ? AND task_type = ? AND action_verb = ? AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC LIMIT ?
    `);
    this.queryByTypeStmt = db.prepare(`
      SELECT * FROM rejected_approaches
      WHERE task_type = ? AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC LIMIT ?
    `);
    this.cleanupStmt = db.prepare('DELETE FROM rejected_approaches WHERE expires_at IS NOT NULL AND expires_at < ?');
  }

  /** Store a rejected approach with transient 24h TTL. */
  store(entry: {
    taskId: string;
    taskType?: string;
    fileTarget?: string;
    fileHash?: string;
    approach: string;
    oracleVerdict: string;
    verdictConfidence?: number;
    failureOracle?: string;
    routingLevel?: number;
    source: 'task-end' | 'eviction';
    /** Gap 6B: Action verb from goal for verb-aware cross-task loading. */
    actionVerb?: string;
  }): void {
    const now = Date.now();
    this.insertStmt.run(
      entry.taskId,
      entry.taskType ?? null,
      entry.fileTarget ?? null,
      entry.fileHash ?? null,
      entry.approach,
      entry.oracleVerdict,
      entry.verdictConfidence ?? null,
      entry.failureOracle ?? null,
      entry.routingLevel ?? null,
      entry.source,
      now,
      now + TRANSIENT_TTL_MS, // Transient by default; structural promotion is Phase 3
      entry.actionVerb ?? null,
    );
  }

  /** Load prior failed approaches matching target file and task type.
   *  Returns (file_target AND task_type) matches first, then (task_type only) matches. */
  loadForTask(fileTarget: string, taskType: string, limit = 5): RejectedApproachRow[] {
    const now = Date.now();
    const exact = this.queryByFileAndTypeStmt.all(fileTarget, taskType, now, limit) as RejectedApproachRow[];
    if (exact.length >= limit) return exact;

    const remaining = limit - exact.length;
    const typeOnly = this.queryByTypeStmt.all(taskType, now, remaining) as RejectedApproachRow[];
    // Deduplicate: exclude rows already in exact match
    const exactIds = new Set(exact.map((r) => r.id));
    const additional = typeOnly.filter((r) => !exactIds.has(r.id));
    return [...exact, ...additional].slice(0, limit);
  }

  /** Gap 8A: Load with verb-aware prioritization.
   *  Returns verb-matched first, then verb-mismatched (from same file+type). */
  loadForTaskWithVerb(fileTarget: string, taskType: string, actionVerb: string, limit = 5): RejectedApproachRow[] {
    const now = Date.now();
    // Prefer verb-matched approaches
    const verbMatched = this.queryByFileTypeVerbStmt.all(fileTarget, taskType, actionVerb, now, limit) as RejectedApproachRow[];
    if (verbMatched.length >= limit) return verbMatched;

    // Fill remaining from same file+type (any verb)
    const remaining = limit - verbMatched.length;
    const all = this.queryByFileAndTypeStmt.all(fileTarget, taskType, now, remaining + verbMatched.length) as RejectedApproachRow[];
    const matchedIds = new Set(verbMatched.map((r) => r.id));
    const additional = all.filter((r) => !matchedIds.has(r.id)).slice(0, remaining);
    return [...verbMatched, ...additional];
  }

  /** Remove expired entries. */
  cleanup(): void {
    this.cleanupStmt.run(Date.now());
  }
}
