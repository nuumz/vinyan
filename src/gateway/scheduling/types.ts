/**
 * W3 H3 — Natural-Language Cron scheduling types.
 *
 * `ScheduledHypothesisTuple` is the canonical shape a natural-language
 * scheduling request ("every weekday at 9am summarize backlog") is parsed
 * into. The scheduler fires `executeTask({ source: 'gateway-cron', … })`
 * when the tuple becomes due; the same governance pipeline (Budget, Risk
 * Router, Oracle Gate) runs as on any other ingress — A3 Deterministic
 * Governance is preserved because the tuple itself is rule-based.
 *
 * Persisted in `gateway_schedules` (migration 006). See
 * `docs/spec/w1-contracts.md` §3 (profile column) and §4 (executeTask
 * invariants for source='gateway-cron').
 */
export type SchedulingOriginPlatform = 'telegram' | 'slack' | 'discord' | 'whatsapp' | 'signal' | 'email' | 'cli';

/** Where the scheduler delivers the reply once the task completes. */
export interface ScheduleOrigin {
  /** Platform the reply goes back to. `cli` means deliver to stdout/log. */
  readonly platform: SchedulingOriginPlatform;
  /** Platform-specific chat id. Null for CLI-originated schedules. */
  readonly chatId: string | null;
  /** Optional thread/topic key (e.g. Slack thread_ts, Discord thread id). */
  readonly threadKey?: string;
}

export type ScheduleStatus = 'active' | 'paused' | 'expired' | 'failed-circuit';

export interface ScheduleRunEntry {
  readonly ranAt: number;
  readonly taskId: string;
  readonly outcome: string;
}

export interface ScheduledHypothesisTuple {
  /** UUID assigned at interpretation time. */
  readonly id: string;
  /** w1-contracts §3 profile namespace. */
  readonly profile: string;
  readonly createdAt: number;
  /**
   * Gateway user id of the creator, or null when the schedule was created
   * from the CLI (no paired identity).
   */
  readonly createdByHermesUserId: string | null;
  readonly origin: ScheduleOrigin;
  /** Normalized CRON string (`m h dom mon dow`, UTC-agnostic — TZ lives alongside). */
  readonly cron: string;
  /** IANA timezone, e.g. `Asia/Bangkok`. */
  readonly timezone: string;
  /** Verbatim user text the tuple was derived from. */
  readonly nlOriginal: string;
  /** Goal synthesized for `TaskInput.goal` on each fire. */
  readonly goal: string;
  /** Task constraints forwarded verbatim to `executeTask`. */
  readonly constraints: Record<string, unknown>;
  /** Goal-alignment oracle confidence at creation time (0..1). */
  readonly confidenceAtCreation: number;
  /** SHA-256 over `goal | cron | origin` — A4 content-addressed key. */
  readonly evidenceHash: string;
  readonly status: ScheduleStatus;
  /** Consecutive failure count; 5 in a row flips status to `failed-circuit`. */
  readonly failureStreak: number;
  /** Next fire time in epoch milliseconds; null when paused/expired. */
  readonly nextFireAt: number | null;
  /** Bounded to last 20 runs (A3 rule-based, bounded memory). */
  readonly runHistory: ReadonlyArray<ScheduleRunEntry>;
}

/** Maximum number of historical runs kept per schedule. */
export const SCHEDULE_RUN_HISTORY_LIMIT = 20;

/** Consecutive failure threshold before the runner circuit-breaks. */
export const SCHEDULE_FAILURE_CIRCUIT_STREAK = 5;
