/**
 * WorkerStore — SQLite persistence for worker profiles + on-demand stats.
 *
 * CRUD for WorkerProfile lifecycle: probation → active → demoted → retired.
 * Stats are computed from execution_traces via SQL aggregates, cached 60s.
 *
 * Source of truth: design/implementation-plan.md §Phase 4.1
 */
import type { Database } from "bun:sqlite";
import type { WorkerProfile, WorkerProfileStatus, WorkerStats, WorkerConfig } from "../orchestrator/types.ts";
import { WorkerProfileRowSchema } from "./schemas.ts";

export class WorkerStore {
  private db: Database;
  private insertStmt;
  private statsCache = new Map<string, { stats: WorkerStats; expiresAt: number }>();
  private statsTTL = 60_000; // 60s cache TTL

  constructor(db: Database) {
    this.db = db;
    this.insertStmt = db.prepare(`
      INSERT OR IGNORE INTO worker_profiles (
        id, model_id, model_version, temperature, tool_allowlist,
        system_prompt_tpl, max_context_tokens, status,
        created_at, promoted_at, demoted_at, demotion_reason, demotion_count
      ) VALUES (
        $id, $model_id, $model_version, $temperature, $tool_allowlist,
        $system_prompt_tpl, $max_context_tokens, $status,
        $created_at, $promoted_at, $demoted_at, $demotion_reason, $demotion_count
      )
    `);
  }

  insert(profile: WorkerProfile): void {
    this.insertStmt.run({
      $id: profile.id,
      $model_id: profile.config.modelId,
      $model_version: profile.config.modelVersion ?? null,
      $temperature: profile.config.temperature,
      $tool_allowlist: profile.config.toolAllowlist ? JSON.stringify(profile.config.toolAllowlist) : null,
      $system_prompt_tpl: profile.config.systemPromptTemplate ?? "default",
      $max_context_tokens: profile.config.maxContextTokens ?? null,
      $status: profile.status,
      $created_at: profile.createdAt,
      $promoted_at: profile.promotedAt ?? null,
      $demoted_at: profile.demotedAt ?? null,
      $demotion_reason: profile.demotionReason ?? null,
      $demotion_count: profile.demotionCount,
    });
  }

  findById(id: string): WorkerProfile | null {
    const row = this.db.prepare(
      `SELECT * FROM worker_profiles WHERE id = ?`,
    ).get(id);
    return row ? rowToProfile(row) : null;
  }

  findByStatus(status: WorkerProfileStatus): WorkerProfile[] {
    const rows = this.db.prepare(
      `SELECT * FROM worker_profiles WHERE status = ? ORDER BY created_at ASC`,
    ).all(status);
    return rows.map(rowToProfile);
  }

  findActive(): WorkerProfile[] {
    return this.findByStatus("active");
  }

  findAll(): WorkerProfile[] {
    const rows = this.db.prepare(
      `SELECT * FROM worker_profiles ORDER BY created_at ASC`,
    ).all();
    return rows.map(rowToProfile);
  }

  findByModelId(modelId: string): WorkerProfile[] {
    const rows = this.db.prepare(
      `SELECT * FROM worker_profiles WHERE model_id = ? ORDER BY created_at ASC`,
    ).all(modelId);
    return rows.map(rowToProfile);
  }

  /** Update worker status with appropriate timestamp fields. */
  updateStatus(
    id: string,
    status: WorkerProfileStatus,
    reason?: string,
  ): void {
    const now = Date.now();
    switch (status) {
      case "active":
        this.db.prepare(
          `UPDATE worker_profiles SET status = ?, promoted_at = ? WHERE id = ?`,
        ).run(status, now, id);
        break;
      case "demoted":
        this.db.prepare(
          `UPDATE worker_profiles SET status = ?, demoted_at = ?, demotion_reason = ?, demotion_count = demotion_count + 1 WHERE id = ?`,
        ).run(status, now, reason ?? null, id);
        break;
      case "retired":
        this.db.prepare(
          `UPDATE worker_profiles SET status = ?, demoted_at = ?, demotion_reason = ? WHERE id = ?`,
        ).run(status, now, reason ?? "permanent retirement", id);
        break;
      default:
        this.db.prepare(
          `UPDATE worker_profiles SET status = ? WHERE id = ?`,
        ).run(status, id);
    }
    this.statsCache.delete(id);
  }

  /** Reset demoted worker back to probation (re-enrollment). */
  reEnroll(id: string): void {
    this.db.prepare(
      `UPDATE worker_profiles SET status = 'probation', promoted_at = NULL, demoted_at = NULL, demotion_reason = NULL WHERE id = ?`,
    ).run(id);
    this.statsCache.delete(id);
  }

  countByStatus(status: WorkerProfileStatus): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM worker_profiles WHERE status = ?`,
    ).get(status) as { cnt: number };
    return row.cnt;
  }

  countActive(): number {
    return this.countByStatus("active");
  }

  count(): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM worker_profiles`,
    ).get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Compute worker stats from traces via SQL aggregates.
   * Cached in-memory with 60s TTL to avoid repeated queries.
   */
  getStats(workerId: string): WorkerStats {
    const cached = this.statsCache.get(workerId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.stats;
    }

    const stats = this.computeStats(workerId);
    this.statsCache.set(workerId, { stats, expiresAt: Date.now() + this.statsTTL });
    return stats;
  }

  /** Invalidate stats cache for a specific worker or all workers. */
  invalidateCache(workerId?: string): void {
    if (workerId) {
      this.statsCache.delete(workerId);
    } else {
      this.statsCache.clear();
    }
  }

  /**
   * Compute stats from the most recent N traces for a worker (rolling window).
   * Used by WorkerLifecycle for demotion checks (rolling 30 tasks per plan PH4.2).
   */
  getRecentStats(workerId: string, limit: number): WorkerStats {
    const agg = this.db.prepare(`
      SELECT
        COUNT(*) as total_tasks,
        AVG(CASE WHEN outcome = 'success' THEN 1.0 ELSE 0.0 END) as success_rate,
        AVG(quality_composite) as avg_quality,
        AVG(duration_ms) as avg_duration,
        AVG(tokens_consumed) as avg_tokens,
        MAX(timestamp) as last_active_at
      FROM (
        SELECT outcome, quality_composite, duration_ms, tokens_consumed, timestamp
        FROM execution_traces
        WHERE worker_id = ?
        ORDER BY timestamp DESC
        LIMIT ?
      )
    `).get(workerId, limit) as {
      total_tasks: number;
      success_rate: number | null;
      avg_quality: number | null;
      avg_duration: number | null;
      avg_tokens: number | null;
      last_active_at: number | null;
    };

    return {
      totalTasks: agg.total_tasks,
      successRate: agg.success_rate ?? 0,
      avgQualityScore: agg.avg_quality ?? 0,
      avgDuration_ms: agg.avg_duration ?? 0,
      avgTokenCost: agg.avg_tokens ?? 0,
      taskTypeBreakdown: {},
      lastActiveAt: agg.last_active_at ?? 0,
    };
  }

  /**
   * Compute stats from traces since a given timestamp for a worker.
   * Used by WorkerLifecycle for scoped safety-violation checks during probation.
   */
  getStatsSince(workerId: string, sinceTimestamp: number): WorkerStats {
    const agg = this.db.prepare(`
      SELECT
        COUNT(*) as total_tasks,
        AVG(CASE WHEN outcome = 'success' THEN 1.0 ELSE 0.0 END) as success_rate,
        AVG(quality_composite) as avg_quality,
        AVG(duration_ms) as avg_duration,
        AVG(tokens_consumed) as avg_tokens,
        MAX(timestamp) as last_active_at
      FROM execution_traces
      WHERE worker_id = ? AND timestamp >= ?
    `).get(workerId, sinceTimestamp) as {
      total_tasks: number;
      success_rate: number | null;
      avg_quality: number | null;
      avg_duration: number | null;
      avg_tokens: number | null;
      last_active_at: number | null;
    };

    return {
      totalTasks: agg.total_tasks,
      successRate: agg.success_rate ?? 0,
      avgQualityScore: agg.avg_quality ?? 0,
      avgDuration_ms: agg.avg_duration ?? 0,
      avgTokenCost: agg.avg_tokens ?? 0,
      taskTypeBreakdown: {},
      lastActiveAt: agg.last_active_at ?? 0,
    };
  }

  /**
   * Count traces for a worker since a given timestamp.
   * Used for session-based cooldown in WorkerLifecycle.
   */
  countTracesSince(workerId: string, sinceTimestamp: number): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM execution_traces WHERE worker_id = ? AND timestamp >= ?`,
    ).get(workerId, sinceTimestamp) as { cnt: number };
    return row.cnt;
  }

  /** Count distinct worker_ids in recent traces (for data gate). */
  countDistinctWorkerIds(): number {
    const row = this.db.prepare(
      `SELECT COUNT(DISTINCT worker_id) as cnt FROM execution_traces WHERE worker_id IS NOT NULL`,
    ).get() as { cnt: number };
    return row.cnt;
  }

  private computeStats(workerId: string): WorkerStats {
    // Aggregate stats
    const agg = this.db.prepare(`
      SELECT
        COUNT(*) as total_tasks,
        AVG(CASE WHEN outcome = 'success' THEN 1.0 ELSE 0.0 END) as success_rate,
        AVG(quality_composite) as avg_quality,
        AVG(duration_ms) as avg_duration,
        AVG(tokens_consumed) as avg_tokens,
        MAX(timestamp) as last_active_at
      FROM execution_traces WHERE worker_id = ?
    `).get(workerId) as {
      total_tasks: number;
      success_rate: number | null;
      avg_quality: number | null;
      avg_duration: number | null;
      avg_tokens: number | null;
      last_active_at: number | null;
    };

    // Task type breakdown
    const breakdown = this.db.prepare(`
      SELECT
        task_type_signature,
        COUNT(*) as count,
        AVG(CASE WHEN outcome = 'success' THEN 1.0 ELSE 0.0 END) as success_rate,
        AVG(quality_composite) as avg_quality,
        AVG(tokens_consumed) as avg_tokens
      FROM execution_traces
      WHERE worker_id = ? AND task_type_signature IS NOT NULL
      GROUP BY task_type_signature
    `).all(workerId) as Array<{
      task_type_signature: string;
      count: number;
      success_rate: number;
      avg_quality: number | null;
      avg_tokens: number;
    }>;

    const taskTypeBreakdown: WorkerStats["taskTypeBreakdown"] = {};
    for (const row of breakdown) {
      taskTypeBreakdown[row.task_type_signature] = {
        count: row.count,
        successRate: row.success_rate,
        avgQuality: row.avg_quality ?? 0,
        avgTokens: row.avg_tokens,
      };
    }

    return {
      totalTasks: agg.total_tasks,
      successRate: agg.success_rate ?? 0,
      avgQualityScore: agg.avg_quality ?? 0,
      avgDuration_ms: agg.avg_duration ?? 0,
      avgTokenCost: agg.avg_tokens ?? 0,
      taskTypeBreakdown,
      lastActiveAt: agg.last_active_at ?? 0,
    };
  }
}

// ── Row deserialization ───────────────────────────────────────────────────

function rowToProfile(row: unknown): WorkerProfile {
  const parsed = WorkerProfileRowSchema.safeParse(row);
  const r = parsed.success ? parsed.data : (row as any);
  if (!parsed.success) {
    console.warn("[vinyan] WorkerStore: row failed Zod validation, using fallback", parsed.error.message);
  }

  const config: WorkerConfig = {
    modelId: r.model_id,
    modelVersion: r.model_version ?? undefined,
    temperature: r.temperature,
    toolAllowlist: parsed.success ? r.tool_allowlist : (r.tool_allowlist ? JSON.parse(r.tool_allowlist) : undefined),
    systemPromptTemplate: r.system_prompt_tpl ?? undefined,
    maxContextTokens: r.max_context_tokens ?? undefined,
  };

  return {
    id: r.id,
    config,
    status: r.status,
    createdAt: r.created_at,
    promotedAt: r.promoted_at ?? undefined,
    demotedAt: r.demoted_at ?? undefined,
    demotionReason: r.demotion_reason ?? undefined,
    demotionCount: r.demotion_count,
  };
}
