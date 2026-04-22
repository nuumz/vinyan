/**
 * GatewayScheduleStore — read/write surface for `gateway_schedules`
 * (migration 006). First consumer of the table; the W2 PR only shipped
 * the schema.
 *
 * Profile scoping (w1-contracts §3) is strict: every reader takes a
 * `profile` argument and filters by it. Cross-profile reads are not
 * supported by this store — a separate admin query would need to pass
 * `'ALL'` explicitly (not implemented; H3 scope is single-profile usage).
 *
 * Storage notes
 * -------------
 *   - `origin`       → JSON blob in `origin_json`
 *   - `run_history`  → JSON blob in `run_history_json`, bounded to 20 entries
 *   - `confidenceAtCreation`, `failureStreak`, `nlOriginal`, `goal` are
 *     stored alongside the bare-minimum schema in a second JSON column
 *     (`origin_json.meta`) to avoid an additive migration. If H3 graduates,
 *     we'll split these into columns in a follow-up migration.
 */
import type { Database } from 'bun:sqlite';
import {
  SCHEDULE_RUN_HISTORY_LIMIT,
  type ScheduledHypothesisTuple,
  type ScheduleRunEntry,
  type ScheduleStatus,
} from '../gateway/scheduling/types.ts';

interface ScheduleRow {
  id: string;
  profile: string;
  created_at: number;
  cron: string;
  timezone: string;
  goal: string;
  origin_json: string;
  status: string;
  next_fire_at: number | null;
  run_history_json: string | null;
}

interface StoredOriginBlob {
  origin: ScheduledHypothesisTuple['origin'];
  meta: {
    nlOriginal: string;
    createdByHermesUserId: string | null;
    confidenceAtCreation: number;
    evidenceHash: string;
    failureStreak: number;
    constraints: Record<string, unknown>;
  };
}

export class GatewayScheduleStore {
  constructor(private readonly db: Database) {}

  /** Insert or replace a schedule. Row identity is `id`. */
  save(tuple: ScheduledHypothesisTuple): void {
    const originBlob: StoredOriginBlob = {
      origin: tuple.origin,
      meta: {
        nlOriginal: tuple.nlOriginal,
        createdByHermesUserId: tuple.createdByHermesUserId,
        confidenceAtCreation: tuple.confidenceAtCreation,
        evidenceHash: tuple.evidenceHash,
        failureStreak: tuple.failureStreak,
        constraints: tuple.constraints,
      },
    };
    const runHistory = tuple.runHistory.slice(-SCHEDULE_RUN_HISTORY_LIMIT);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO gateway_schedules
           (id, profile, created_at, cron, timezone, goal,
            origin_json, status, next_fire_at, run_history_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tuple.id,
        tuple.profile,
        tuple.createdAt,
        tuple.cron,
        tuple.timezone,
        tuple.goal,
        JSON.stringify(originBlob),
        tuple.status,
        tuple.nextFireAt,
        JSON.stringify(runHistory),
      );
  }

  get(id: string, profile: string): ScheduledHypothesisTuple | null {
    const row = this.db
      .prepare(
        `SELECT id, profile, created_at, cron, timezone, goal,
                origin_json, status, next_fire_at, run_history_json
           FROM gateway_schedules
          WHERE id = ? AND profile = ?`,
      )
      .get(id, profile) as ScheduleRow | null;
    return row ? rowToTuple(row) : null;
  }

  /** List all `active` schedules for a profile whose `next_fire_at` is in the past. */
  listDueBefore(profile: string, epochMs: number): ScheduledHypothesisTuple[] {
    const rows = this.db
      .prepare(
        `SELECT id, profile, created_at, cron, timezone, goal,
                origin_json, status, next_fire_at, run_history_json
           FROM gateway_schedules
          WHERE profile = ?
            AND status = 'active'
            AND next_fire_at IS NOT NULL
            AND next_fire_at <= ?
          ORDER BY next_fire_at ASC`,
      )
      .all(profile, epochMs) as ScheduleRow[];
    return rows.map(rowToTuple);
  }

  /** Append a run entry (trimmed to the last 20). Profile-scoped. */
  updateRunHistory(id: string, profile: string, run: ScheduleRunEntry): void {
    const row = this.get(id, profile);
    if (!row) return;
    const next: ScheduleRunEntry[] = [...row.runHistory, run].slice(-SCHEDULE_RUN_HISTORY_LIMIT);
    this.db
      .prepare(
        `UPDATE gateway_schedules
            SET run_history_json = ?
          WHERE id = ? AND profile = ?`,
      )
      .run(JSON.stringify(next), id, profile);
  }

  setStatus(id: string, profile: string, status: ScheduleStatus): void {
    this.db.prepare(`UPDATE gateway_schedules SET status = ? WHERE id = ? AND profile = ?`).run(status, id, profile);
  }

  setNextFire(id: string, profile: string, nextFireAt: number | null): void {
    this.db
      .prepare(`UPDATE gateway_schedules SET next_fire_at = ? WHERE id = ? AND profile = ?`)
      .run(nextFireAt, id, profile);
  }

  /**
   * Persist an updated failure-streak value. Stored inside `origin_json`
   * until a proper column migration ships.
   */
  setFailureStreak(id: string, profile: string, streak: number): void {
    const existing = this.get(id, profile);
    if (!existing) return;
    const withNewStreak: ScheduledHypothesisTuple = {
      ...existing,
      failureStreak: streak,
    };
    this.save(withNewStreak);
  }
}

function rowToTuple(row: ScheduleRow): ScheduledHypothesisTuple {
  const blob = safeParseOriginBlob(row.origin_json);
  const runHistory = safeParseRunHistory(row.run_history_json);
  return {
    id: row.id,
    profile: row.profile,
    createdAt: row.created_at,
    createdByHermesUserId: blob.meta.createdByHermesUserId,
    origin: blob.origin,
    cron: row.cron,
    timezone: row.timezone,
    nlOriginal: blob.meta.nlOriginal,
    goal: row.goal,
    constraints: blob.meta.constraints,
    confidenceAtCreation: blob.meta.confidenceAtCreation,
    evidenceHash: blob.meta.evidenceHash,
    status: row.status as ScheduleStatus,
    failureStreak: blob.meta.failureStreak,
    nextFireAt: row.next_fire_at,
    runHistory,
  };
}

function safeParseOriginBlob(json: string): StoredOriginBlob {
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && 'origin' in parsed && 'meta' in parsed) {
      return parsed as StoredOriginBlob;
    }
  } catch {
    // fall through
  }
  return {
    origin: { platform: 'cli', chatId: null },
    meta: {
      nlOriginal: '',
      createdByHermesUserId: null,
      confidenceAtCreation: 0,
      evidenceHash: '',
      failureStreak: 0,
      constraints: {},
    },
  };
}

function safeParseRunHistory(json: string | null): ScheduleRunEntry[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed as ScheduleRunEntry[];
  } catch {
    // fall through
  }
  return [];
}
