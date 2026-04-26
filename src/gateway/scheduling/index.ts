/**
 * W3 H3 — public scheduling surface.
 *
 * Library-only; wiring into factory.ts is a separate PR.
 */

export {
  type CronParseFailure,
  type CronParseResult,
  nextFireAt,
  type ParseCronOptions,
  parseCron,
  parseCronFields,
} from './cron-parser.ts';
export { type DeliverReplyDeps, deliverCronReply } from './deliver-reply.ts';
export {
  deriveGoal,
  type InterpretedTupleDraft,
  type InterpreterDeps,
  type InterpretFailure,
  type InterpretResult,
  interpretSchedule,
} from './interpreter.ts';
export {
  type MarketSchedulerTickApi,
  ScheduleRunner,
  type ScheduleRunnerDeps,
} from './schedule-runner.ts';
export {
  SCHEDULE_FAILURE_CIRCUIT_STREAK,
  SCHEDULE_RUN_HISTORY_LIMIT,
  type ScheduledHypothesisTuple,
  type ScheduleOrigin,
  type ScheduleRunEntry,
  type ScheduleStatus,
  type SchedulingOriginPlatform,
} from './types.ts';
export {
  type ScheduleRunnerHandle,
  type SetupScheduleRunnerOptions,
  setupScheduleRunner,
} from './wiring.ts';
