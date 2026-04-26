/**
 * W3 H3 — factory wiring for the NL-cron ScheduleRunner.
 *
 * Export: {@link setupScheduleRunner} — constructs a live
 * {@link ScheduleRunner} with a real `executeTask` closure and a
 * reply-routing `deliverReply` that dispatches through the
 * {@link MessagingAdapterLifecycleManager}.
 *
 * The factory (src/orchestrator/factory.ts) calls this helper during boot
 * and then `handle.start()` to begin delivering ticks. CLI-only deployments
 * may omit `lifecycle`; CLI-origin schedules log the result instead of
 * dispatching.
 *
 * Why a separate module: factory.ts is edited by a coordinator track; this
 * isolation lets the gateway/economy tracks add the runner without
 * editing the factory in the same PR. The factory simply wires
 * `setupScheduleRunner({ ... })` into its existing boot sequence.
 *
 * A3: every start/stop action is rule-based; no LLM in the governance path.
 */
import type { Database } from 'bun:sqlite';
import { GatewayScheduleStore } from '../../db/gateway-schedule-store.ts';
import type { MarketScheduler } from '../../economy/market/market-scheduler.ts';
import type { TaskInput, TaskResult } from '../../orchestrator/types.ts';
import type { MessagingAdapterLifecycleManager } from '../lifecycle.ts';
import { deliverCronReply } from './deliver-reply.ts';
import { type MarketSchedulerTickApi, ScheduleRunner } from './schedule-runner.ts';
import type { ScheduledHypothesisTuple } from './types.ts';

export interface SetupScheduleRunnerOptions {
  readonly db: Database;
  readonly executeTask: (input: TaskInput) => Promise<TaskResult>;
  /** Optional — CLI-only deployments don't need it. */
  readonly lifecycle?: MessagingAdapterLifecycleManager;
  /** Optional — falls back to a local setInterval when absent. */
  readonly marketScheduler?: MarketScheduler;
  readonly log: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
  /** Profiles the runner polls on every tick. Defaults to `['default']`. */
  readonly profiles?: ReadonlyArray<string>;
  /** Local-timer interval (ms) used when {@link marketScheduler} is absent. */
  readonly tickIntervalMs?: number;
  /** Test hook — inject a deterministic clock. */
  readonly clock?: () => number;
  /** Test hook — inject deterministic task ids. */
  readonly uuid?: () => string;
}

export interface ScheduleRunnerHandle {
  readonly runner: ScheduleRunner;
  readonly store: GatewayScheduleStore;
  start(): void;
  stop(): void;
}

/**
 * Construct a ScheduleRunner with production-shaped dependencies.
 *
 * Start/stop are surfaced directly so the factory can drive the lifecycle
 * from its existing boot/teardown hooks without reaching into
 * `handle.runner`.
 */
export function setupScheduleRunner(opts: SetupScheduleRunnerOptions): ScheduleRunnerHandle {
  const store = new GatewayScheduleStore(opts.db);

  const deliverReply = async (schedule: ScheduledHypothesisTuple, result: TaskResult): Promise<void> => {
    if (!opts.lifecycle) {
      opts.log('info', '[schedule] no messaging lifecycle configured; dropping reply', {
        scheduleId: schedule.id,
        platform: schedule.origin.platform,
        taskStatus: result.status,
      });
      return;
    }
    await deliverCronReply(schedule, result, {
      lifecycle: opts.lifecycle,
      log: opts.log,
    });
  };

  const runner = new ScheduleRunner({
    store,
    executeTask: opts.executeTask,
    deliverReply,
    ...(opts.marketScheduler ? { marketScheduler: asTickApi(opts.marketScheduler) } : {}),
    ...(opts.profiles ? { profiles: opts.profiles } : {}),
    ...(opts.tickIntervalMs !== undefined ? { tickIntervalMs: opts.tickIntervalMs } : {}),
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...(opts.uuid ? { uuid: opts.uuid } : {}),
  });

  return {
    runner,
    store,
    start: () => runner.start(),
    stop: () => runner.stop(),
  };
}

/**
 * Narrow a full `MarketScheduler` to the structural `MarketSchedulerTickApi`
 * that `ScheduleRunner` depends on. Keeps the runner free of a hard import
 * cycle on the economy module.
 */
function asTickApi(market: MarketScheduler): MarketSchedulerTickApi {
  return {
    registerTickHook: (fn) => market.registerTickHook(fn),
  };
}
