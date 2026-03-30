/**
 * World Graph Retention Policy — prevents unbounded DB growth.
 *
 * TDD §5: maxAgeDays=30, keepLastSessions=10, maxFactCount=50,000.
 * Runs every N storeFact() calls (default: 100).
 */
import type { Database } from "bun:sqlite";

export interface RetentionConfig {
  maxAgeDays: number;
  keepLastSessions: number;
  maxFactCount: number;
}

export const DEFAULT_RETENTION: RetentionConfig = {
  maxAgeDays: 30,
  keepLastSessions: 10,
  maxFactCount: 50_000,
};

/** Run retention policy. Returns number of facts deleted. */
export function runRetention(db: Database, config: RetentionConfig = DEFAULT_RETENTION): number {
  let deleted = 0;

  // Step 1: Find protected session IDs (last N sessions by most recent fact)
  const protectedSessions = db
    .query(
      `SELECT session_id FROM facts
       WHERE session_id IS NOT NULL
       GROUP BY session_id
       ORDER BY MAX(verified_at) DESC
       LIMIT ?`,
    )
    .all(config.keepLastSessions) as Array<{ session_id: string }>;

  const protectedIds = new Set(protectedSessions.map((r) => r.session_id));

  // Step 2: Delete facts older than maxAge that are NOT in protected sessions
  const cutoff = Date.now() - config.maxAgeDays * 24 * 60 * 60 * 1000;

  if (protectedIds.size > 0) {
    const placeholders = [...protectedIds].map(() => "?").join(",");
    const result = db
      .query(
        `DELETE FROM facts WHERE verified_at < ? AND (session_id IS NULL OR session_id NOT IN (${placeholders}))`,
      )
      .run(cutoff, ...protectedIds);
    deleted += result.changes;
  } else {
    const result = db.query("DELETE FROM facts WHERE verified_at < ?").run(cutoff);
    deleted += result.changes;
  }

  // Step 3: Hard cap — if still over maxFactCount, delete oldest beyond cap
  const countRow = db.query("SELECT COUNT(*) as cnt FROM facts").get() as { cnt: number };
  if (countRow.cnt > config.maxFactCount) {
    const excess = countRow.cnt - config.maxFactCount;
    const result = db
      .query(
        `DELETE FROM facts WHERE id IN (
           SELECT id FROM facts ORDER BY verified_at ASC LIMIT ?
         )`,
      )
      .run(excess);
    deleted += result.changes;
  }

  return deleted;
}
