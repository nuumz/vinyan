/**
 * `SkillAutogenStateStore` — persistent companion to the in-memory
 * `proposal-autogen.ts` tracker.
 *
 * Hermes lesson revisited (R3): we want to pick up where the runtime
 * left off across restarts, but we ALSO want zero-trust against false
 * promotions. The previous implementation reset to zero on every boot
 * — safe but threw away progress. The new contract:
 *
 *   1. Persist `(profile, signature_key) → successes / lastSeen /
 *      taskIds / cooldownUntil / lastEmittedAt`.
 *   2. On boot, snapshot `successes_at_boot = successes` per row so
 *      the caller can compute "successes accumulated since this boot".
 *   3. Prune rows older than `MAX_TRACKER_AGE_MS` so a long-idle
 *      signature does not promote on the next stray success.
 *   4. Drop rows with an unknown `state_version` — schema migration
 *      breakage falls back to "no prior history" (A9).
 *   5. Refuse promotion until `successes_since_boot >=
 *      MIN_POST_RESTART_EVIDENCE`. The autogenerator queries
 *      `canPromote()` rather than reading `successes` directly.
 *
 * The store does NOT decide whether to emit a proposal — that's the
 * autogenerator's policy. The store only stores facts.
 *
 * A3 — every state transition is rule-based. A6 — promotion gate
 * checks observable durable counters; no LLM in the path. A8 — every
 * row carries a `boot_id` so an audit query can replay which runtime
 * touched the counter.
 */
import type { Database, Statement } from 'bun:sqlite';

/** Default TTL: 14 days. Stale rows older than this are pruned at boot. */
export const MAX_TRACKER_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * Minimum successful runs we must observe AFTER the runtime came up
 * before we trust a counter enough to promote. Without this, a row
 * carrying `successes >= threshold` from a previous boot could promote
 * on the very first emit post-restart — defeating zero-trust.
 *
 * G7 (deployment knob): override per-instance via the `minPostRestartEvidence`
 * constructor option. The default of 1 is the minimum that still preserves
 * the R3 invariant; raising it makes the system more conservative at the
 * cost of slower learning post-restart.
 */
export const MIN_POST_RESTART_EVIDENCE = 1;
const ABSOLUTE_FRESH_EVIDENCE_FLOOR = 1;
/** Default debounce window so the same signature does not flood the queue. */
export const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h
/** Maximum task ids carried per row. Matches in-memory ring. */
export const MAX_PERSISTED_TASK_IDS = 25;
/** Schema version. Boot reconciliation drops rows with any other value. */
const STATE_VERSION = 1;

export interface AutogenStateRecord {
  readonly profile: string;
  readonly signatureKey: string;
  readonly successes: number;
  readonly successesAtBoot: number;
  readonly lastSeen: number;
  readonly bootId: string | null;
  readonly cooldownUntil: number;
  readonly taskIds: readonly string[];
  readonly stateVersion: number;
  readonly lastEmittedAt: number | null;
}

export interface ReconcileResult {
  readonly bootId: string;
  readonly loaded: number;
  readonly prunedStale: number;
  readonly invalidatedSchema: number;
  readonly invalidatedCorrupt: number;
}

interface RawRow {
  profile: string;
  signature_key: string;
  successes: number;
  successes_at_boot: number;
  last_seen: number;
  boot_id: string | null;
  cooldown_until: number;
  task_ids_json: string;
  state_version: number;
  last_emitted_at: number | null;
}

export class SkillAutogenStateStore {
  private readonly upsertStmt: Statement;
  private readonly bumpStmt: Statement;
  private readonly recordEmitStmt: Statement;
  private readonly getStmt: Statement;
  private readonly listForProfileStmt: Statement;
  private readonly clock: () => number;
  /** TTL applied at reconcile-time. Configurable for tests. */
  private readonly maxAgeMs: number;
  /** Bound on how many rows reconciliation will retain. */
  private readonly maxRows: number;

  /** Minimum fresh-evidence count post-boot (G7 deployment knob). */
  private readonly minFreshEvidence: number;
  /** Reusable transactional bumper — resolves the read-modify-write race (G8). */
  private readonly recordSuccessTx: (args: {
    profile: string;
    signatureKey: string;
    bootId: string;
    taskId: string;
  }) => AutogenStateRecord;

  constructor(
    private readonly db: Database,
    opts?: {
      clock?: () => number;
      maxAgeMs?: number;
      maxRows?: number;
      /**
       * Override the minimum fresh-evidence floor. Clamped to a minimum
       * of 1 so a deployment can't accidentally disable the zero-trust
       * gate by passing 0 / negative. (G7)
       */
      minPostRestartEvidence?: number;
    },
  ) {
    this.clock = opts?.clock ?? Date.now;
    this.maxAgeMs = opts?.maxAgeMs ?? MAX_TRACKER_AGE_MS;
    this.maxRows = opts?.maxRows ?? 1000;
    this.minFreshEvidence = Math.max(
      ABSOLUTE_FRESH_EVIDENCE_FLOOR,
      opts?.minPostRestartEvidence ?? MIN_POST_RESTART_EVIDENCE,
    );
    this.upsertStmt = db.prepare(
      `INSERT INTO skill_autogen_state
         (profile, signature_key, successes, successes_at_boot, last_seen,
          boot_id, cooldown_until, task_ids_json, state_version, last_emitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (profile, signature_key) DO UPDATE SET
         successes         = excluded.successes,
         successes_at_boot = excluded.successes_at_boot,
         last_seen         = excluded.last_seen,
         boot_id           = excluded.boot_id,
         cooldown_until    = excluded.cooldown_until,
         task_ids_json     = excluded.task_ids_json,
         state_version     = excluded.state_version,
         last_emitted_at   = excluded.last_emitted_at`,
    );
    this.bumpStmt = db.prepare(
      `UPDATE skill_autogen_state
          SET successes      = ?,
              last_seen      = ?,
              task_ids_json  = ?
        WHERE profile = ? AND signature_key = ?`,
    );
    this.recordEmitStmt = db.prepare(
      `UPDATE skill_autogen_state
          SET cooldown_until   = ?,
              last_emitted_at  = ?
        WHERE profile = ? AND signature_key = ?`,
    );
    this.getStmt = db.prepare(
      `SELECT * FROM skill_autogen_state
        WHERE profile = ? AND signature_key = ?`,
    );
    this.listForProfileStmt = db.prepare(
      `SELECT * FROM skill_autogen_state
        WHERE profile = ?
        ORDER BY last_seen DESC
        LIMIT ?`,
    );

    // G8 — wrap recordSuccess in a transaction so a multi-process
    // deployment (or a future async listener path) can't lose
    // increments to a read-modify-write race. SQLite serialises
    // transactions on a single DB; the tx body is the only writer
    // for this signature_key.
    this.recordSuccessTx = db.transaction((args: {
      profile: string;
      signatureKey: string;
      bootId: string;
      taskId: string;
    }): AutogenStateRecord => {
      const now = this.clock();
      const existing = this.get(args.profile, args.signatureKey);
      const taskIds = existing
        ? appendBoundedTaskId(existing.taskIds, args.taskId)
        : [args.taskId];
      if (existing) {
        this.bumpStmt.run(
          existing.successes + 1,
          now,
          JSON.stringify(taskIds),
          args.profile,
          args.signatureKey,
        );
        return {
          ...existing,
          successes: existing.successes + 1,
          lastSeen: now,
          taskIds,
        };
      }
      this.upsertStmt.run(
        args.profile,
        args.signatureKey,
        1,
        1,
        now,
        args.bootId,
        0,
        JSON.stringify(taskIds),
        STATE_VERSION,
        null,
      );
      return {
        profile: args.profile,
        signatureKey: args.signatureKey,
        successes: 1,
        successesAtBoot: 1,
        lastSeen: now,
        bootId: args.bootId,
        cooldownUntil: 0,
        taskIds,
        stateVersion: STATE_VERSION,
        lastEmittedAt: null,
      };
    }) as (args: {
      profile: string;
      signatureKey: string;
      bootId: string;
      taskId: string;
    }) => AutogenStateRecord;
  }

  /**
   * Reconcile persisted state with a freshly-booted runtime.
   *
   *   1. Generate a new `bootId` so post-load successes are
   *      attributable to this run.
   *   2. Drop rows older than `maxAgeMs` — stale TTL prune.
   *   3. Drop rows whose `state_version` doesn't match the schema
   *      we know how to read (A9: corrupt state degrades, never
   *      poisons the runtime).
   *   4. For every surviving row, snapshot `successes_at_boot =
   *      successes` so the autogenerator can require fresh evidence
   *      before promoting.
   *   5. Optionally bound the row count — older rows beyond `maxRows`
   *      are pruned to prevent unbounded growth from one-shot
   *      signatures that survived TTL.
   *
   * Returns counts for observability events
   * (`tracker_state_loaded` / `_pruned` / `_invalidated`).
   */
  reconcile(): ReconcileResult {
    const bootId = newBootId();
    const now = this.clock();
    const cutoff = now - this.maxAgeMs;

    // Schema invalidation. SQLite has no parameterized DROP, but
    // here we DELETE rows that fail validation in a single statement.
    const schemaPrune = this.db.run(
      `DELETE FROM skill_autogen_state WHERE state_version <> ?`,
      [STATE_VERSION],
    );

    // TTL prune.
    const ttlPrune = this.db.run(
      `DELETE FROM skill_autogen_state WHERE last_seen < ?`,
      [cutoff],
    );

    // Capacity cap — keep newest `maxRows`. Rare in practice; the TTL
    // already trims most of the tail.
    const total = this.db
      .query('SELECT COUNT(*) AS c FROM skill_autogen_state')
      .get() as { c: number };
    let capPrune = 0;
    if (total.c > this.maxRows) {
      const overflow = total.c - this.maxRows;
      const res = this.db.run(
        `DELETE FROM skill_autogen_state
          WHERE rowid IN (
            SELECT rowid FROM skill_autogen_state
              ORDER BY last_seen ASC
              LIMIT ?
          )`,
        [overflow],
      );
      capPrune = res.changes;
    }

    // Validate JSON in surviving rows. A row whose `task_ids_json`
    // doesn't parse is corrupt — drop it rather than serve garbage.
    const allRows = this.db
      .query(`SELECT profile, signature_key, task_ids_json FROM skill_autogen_state`)
      .all() as Array<{ profile: string; signature_key: string; task_ids_json: string }>;
    let corruptPrune = 0;
    for (const r of allRows) {
      try {
        const parsed = JSON.parse(r.task_ids_json);
        if (!Array.isArray(parsed)) throw new Error('not-array');
      } catch {
        this.db.run(
          `DELETE FROM skill_autogen_state WHERE profile = ? AND signature_key = ?`,
          [r.profile, r.signature_key],
        );
        corruptPrune += 1;
      }
    }

    // Snapshot `successes_at_boot` for every surviving row.
    const snapshot = this.db.run(
      `UPDATE skill_autogen_state
          SET successes_at_boot = successes,
              boot_id = ?`,
      [bootId],
    );

    return {
      bootId,
      loaded: snapshot.changes,
      prunedStale: ttlPrune.changes + capPrune,
      invalidatedSchema: schemaPrune.changes,
      invalidatedCorrupt: corruptPrune,
    };
  }

  /** Read a single row. Used for diagnostics + the `canPromote` gate. */
  get(profile: string, signatureKey: string): AutogenStateRecord | null {
    const row = this.getStmt.get(profile, signatureKey) as RawRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  /**
   * Append a success to `(profile, signatureKey)`. Creates the row if
   * absent. Persists the new bounded task-id ring. Returns the post-
   * mutation record.
   *
   * G8: the read-modify-write is wrapped in a SQLite transaction so a
   * multi-process or future async-listener deployment can't lose
   * increments under contention.
   *
   * Fresh-row semantics — `successes_at_boot = 1` so the listener
   * computes `successes - successes_at_boot = 0` for the FIRST emit
   * after the row was created. Once the next success arrives, the
   * diff reaches the fresh-evidence floor. A brand-new row alone
   * never promotes on the same emit that created it (R3 invariant).
   */
  recordSuccess(args: {
    profile: string;
    signatureKey: string;
    bootId: string;
    taskId: string;
  }): AutogenStateRecord {
    return this.recordSuccessTx(args);
  }

  /**
   * Mark a successful proposal emission. Sets `last_emitted_at` and a
   * cooldown window so the same signature does not flood the queue
   * with back-to-back proposals on every subsequent success.
   */
  recordEmit(args: { profile: string; signatureKey: string; cooldownMs?: number }): void {
    const now = this.clock();
    const cooldown = args.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.recordEmitStmt.run(now + cooldown, now, args.profile, args.signatureKey);
  }

  /**
   * Compute whether a signature can promote right now. Returns a
   * verdict + reason for diagnostics.
   *
   *   - Cooldown window not yet expired → block.
   *   - `successes_since_boot < MIN_POST_RESTART_EVIDENCE` → block.
   *     Prevents a half-counted signature from a previous run from
   *     promoting on the first post-restart emit.
   *   - Otherwise → allow.
   *
   * The threshold check itself is the autogenerator's responsibility;
   * this gate is the zero-trust hardening on top.
   */
  canPromote(record: AutogenStateRecord, threshold: number): {
    ok: boolean;
    reason?: 'cooldown' | 'fresh-evidence' | 'below-threshold';
  } {
    const now = this.clock();
    if (record.cooldownUntil > now) return { ok: false, reason: 'cooldown' };
    const sinceBoot = Math.max(0, record.successes - record.successesAtBoot);
    if (sinceBoot < this.minFreshEvidence) {
      return { ok: false, reason: 'fresh-evidence' };
    }
    if (record.successes < threshold) {
      return { ok: false, reason: 'below-threshold' };
    }
    return { ok: true };
  }

  /** Read the configured minimum fresh-evidence floor (G7 diagnostics). */
  getMinFreshEvidence(): number {
    return this.minFreshEvidence;
  }

  /** Operator-visible list — drives the diagnostics endpoint. */
  list(profile: string, limit = 200): readonly AutogenStateRecord[] {
    const rows = this.listForProfileStmt.all(profile, limit) as RawRow[];
    return rows.map(rowToRecord);
  }
}

function rowToRecord(row: RawRow): AutogenStateRecord {
  let taskIds: readonly string[] = [];
  try {
    const parsed = JSON.parse(row.task_ids_json);
    if (Array.isArray(parsed)) taskIds = parsed.map(String);
  } catch {
    /* validated by reconcile, but defend anyway */
  }
  return {
    profile: row.profile,
    signatureKey: row.signature_key,
    successes: row.successes,
    successesAtBoot: row.successes_at_boot,
    lastSeen: row.last_seen,
    bootId: row.boot_id,
    cooldownUntil: row.cooldown_until,
    taskIds,
    stateVersion: row.state_version,
    lastEmittedAt: row.last_emitted_at,
  };
}

function appendBoundedTaskId(existing: readonly string[], taskId: string): string[] {
  if (existing.includes(taskId)) return existing.slice();
  const next = [...existing, taskId];
  if (next.length <= MAX_PERSISTED_TASK_IDS) return next;
  return next.slice(next.length - MAX_PERSISTED_TASK_IDS);
}

function newBootId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  return g.crypto?.randomUUID?.() ?? `boot-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}
