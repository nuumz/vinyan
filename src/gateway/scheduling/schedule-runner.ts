/**
 * W3 H3 — schedule runner.
 *
 * Polls (or hooks) for due schedules and fires `executeTask` for each.
 * Every firing goes through the canonical `executeTask` entry point
 * (`source: 'gateway-cron'`) so governance (Budget → Risk → Verify → Learn)
 * applies identically to cron-triggered tasks (A3, Decision 21).
 *
 * Tick source preference (highest → lowest):
 *   1. `marketScheduler.registerTickHook` — when MarketScheduler exposes
 *      the public hook API. As of 2026-04-21 the symbol is absent; see
 *      the W3 contract amendment request below.
 *   2. Local `setInterval` — fallback used when no market scheduler or
 *      hook API is available. Interval: 30s, configurable via `tickIntervalMs`.
 *
 * ⚠️ Contract amendment request (w1-contracts §9 candidate):
 *     MarketScheduler does not currently expose `registerTickHook(fn)`.
 *     The H3 MVP ships a local-timer fallback. When MarketScheduler
 *     adds the hook, `ScheduleRunner` should prefer it to avoid double
 *     clocks.
 *
 * Circuit-breaker: a schedule that fails 5 consecutive times flips its
 * status to `failed-circuit` and stops firing until an operator
 * re-activates it (rule-based, A3).
 */
import type { GatewayScheduleStore } from '../../db/gateway-schedule-store.ts';
import type { TaskInput, TaskResult, TaskType } from '../../orchestrator/types.ts';
import { nextFireAt } from './cron-parser.ts';
import { SCHEDULE_FAILURE_CIRCUIT_STREAK, SCHEDULE_RUN_HISTORY_LIMIT, type ScheduledHypothesisTuple } from './types.ts';

export interface MarketSchedulerTickApi {
  readonly registerTickHook: (fn: () => void | Promise<void>) => () => void;
}

export interface ScheduleRunnerDeps {
  readonly store: GatewayScheduleStore;
  readonly executeTask: (input: TaskInput) => Promise<TaskResult>;
  readonly deliverReply: (schedule: ScheduledHypothesisTuple, result: TaskResult) => Promise<void>;
  readonly clock?: () => number;
  readonly marketScheduler?: MarketSchedulerTickApi;
  /** Profiles the runner polls on every tick. Defaults to `['default']`. */
  readonly profiles?: ReadonlyArray<string>;
  /** Local-timer interval (ms) used when MarketScheduler is unavailable. */
  readonly tickIntervalMs?: number;
  /**
   * TaskType forwarded to `executeTask`. Cron-triggered work defaults to
   * `'reasoning'` unless the caller overrides — orchestrator risk routing
   * will adjust as needed.
   */
  readonly defaultTaskType?: TaskType;
  /** Budget forwarded to `TaskInput.budget` for each firing. */
  readonly defaultBudget?: TaskInput['budget'];
  /** Test hook: crypto.randomUUID fallback. */
  readonly uuid?: () => string;
}

const DEFAULT_TICK_INTERVAL_MS = 30_000;

export class ScheduleRunner {
  private stopFn: (() => void) | null = null;
  private started = false;

  constructor(private readonly deps: ScheduleRunnerDeps) {}

  /**
   * Begin delivering ticks. Registers with MarketScheduler when available,
   * otherwise spawns a local timer. Calling `start()` twice is a no-op.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    if (this.deps.marketScheduler?.registerTickHook) {
      const unregister = this.deps.marketScheduler.registerTickHook(async () => {
        await this.runTick();
      });
      this.stopFn = unregister;
      return;
    }

    const interval = this.deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    const handle = setInterval(() => {
      // Swallow per-tick errors — one misbehaving schedule must not kill
      // the runner. Errors are logged through the outcome on the tuple.
      void this.runTick().catch(() => undefined);
    }, interval);
    this.stopFn = () => clearInterval(handle);
  }

  /** Unregister hooks / stop the local timer. Safe to call when already stopped. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    const fn = this.stopFn;
    this.stopFn = null;
    fn?.();
  }

  /**
   * Test hook — runs a single tick against a caller-supplied wall-clock
   * value. Returns the number of schedules fired.
   */
  async tickAt(epochMs: number): Promise<number> {
    return this.runTick(epochMs);
  }

  /**
   * Drive a single tick. Visits every configured profile, loads all due
   * schedules, fires each, and writes back status/nextFire/runHistory.
   */
  private async runTick(nowOverride?: number): Promise<number> {
    const now = nowOverride ?? this.deps.clock?.() ?? Date.now();
    const profiles = this.deps.profiles ?? ['default'];
    let fired = 0;
    for (const profile of profiles) {
      const due = this.deps.store.listDueBefore(profile, now);
      for (const schedule of due) {
        await this.fire(schedule, now);
        fired++;
      }
    }
    return fired;
  }

  /**
   * Fire a single schedule: build TaskInput → executeTask → record outcome
   * → advance nextFireAt → maybe deliverReply.
   */
  private async fire(schedule: ScheduledHypothesisTuple, now: number): Promise<void> {
    const taskId = this.deps.uuid?.() ?? cryptoRandomId();

    let result: TaskResult | null = null;
    let outcome = 'failed';
    try {
      result = await this.deps.executeTask(this.buildTaskInput(schedule, taskId));
      outcome = result.status;
    } catch (err) {
      outcome = err instanceof Error ? `threw:${err.message}` : 'threw:unknown';
    }

    // Circuit-breaker bookkeeping.
    const failed = !result || (result.status !== 'completed' && result.status !== 'input-required');
    const nextStreak = failed ? schedule.failureStreak + 1 : 0;

    this.deps.store.updateRunHistory(schedule.id, schedule.profile, {
      ranAt: now,
      taskId,
      outcome,
    });

    if (nextStreak >= SCHEDULE_FAILURE_CIRCUIT_STREAK) {
      this.deps.store.setStatus(schedule.id, schedule.profile, 'failed-circuit');
      this.deps.store.setFailureStreak(schedule.id, schedule.profile, nextStreak);
      this.deps.store.setNextFire(schedule.id, schedule.profile, null);
    } else {
      // Advance to the next fire time. `from = now + 1` so we never
      // re-fire the same minute we just fired.
      const nextEpoch = safeNextFire(schedule, now);
      this.deps.store.setFailureStreak(schedule.id, schedule.profile, nextStreak);
      this.deps.store.setNextFire(schedule.id, schedule.profile, nextEpoch);
    }

    if (result) {
      // Swallow deliver errors so one broken adapter doesn't kill the tick.
      await this.deps.deliverReply({ ...schedule, failureStreak: nextStreak }, result).catch(() => undefined);
    }
  }

  private buildTaskInput(schedule: ScheduledHypothesisTuple, taskId: string): TaskInput {
    const budget =
      this.deps.defaultBudget ??
      ({ maxTokens: 4_000, maxDurationMs: 60_000, maxRetries: 1 } satisfies TaskInput['budget']);
    return {
      id: taskId,
      source: 'gateway-cron',
      goal: schedule.goal,
      taskType: this.deps.defaultTaskType ?? 'reasoning',
      profile: schedule.profile,
      originEnvelope: schedule,
      priority: 'background',
      constraints: schedule.constraints
        ? Object.keys(schedule.constraints).map((k) => `${k}=${String(schedule.constraints[k])}`)
        : undefined,
      budget,
    };
  }
}

/**
 * Compute the next fire time, defending against evaluator errors.
 * Returns `null` when no valid future fire time exists.
 */
function safeNextFire(schedule: ScheduledHypothesisTuple, now: number): number | null {
  try {
    return nextFireAt(schedule.cron, schedule.timezone, now);
  } catch {
    return null;
  }
}

function cryptoRandomId(): string {
  // Bun/Node both expose `crypto.randomUUID` — guard only for test
  // environments that stub globals.
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  // Fallback: timestamp + random suffix.
  return `sched-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

// Re-export for ergonomic imports.
export { SCHEDULE_FAILURE_CIRCUIT_STREAK, SCHEDULE_RUN_HISTORY_LIMIT };
