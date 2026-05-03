/**
 * Memory Wiki — periodic consolidation + lint scheduler.
 *
 * Closes the loop the design doc describes ("sleep-cycle integration"
 * §4.4). Without this scheduler:
 *   - drafts accumulate forever, never promoting to canonical;
 *   - lint findings never refresh — `memory_wiki_lint_findings`
 *     stays whatever-it-was-at-startup;
 *   - failure-pattern clusters never mirror into MemoryProvider;
 *   - idle pages never archive.
 *
 * The scheduler runs `consolidation.run(profile)` every
 * `consolidationIntervalMs` (default 1 hour) and `lint.run({profile})`
 * every `lintIntervalMs` (default 6 hours). Both are best-effort: a
 * single failed tick is logged and skipped; subsequent ticks proceed.
 *
 * Timers are unref'd so they never hold the Bun process alive on their
 * own (the API server is what holds the process; if the server stops,
 * the scheduler stops with it).
 *
 * ## NREM scope only (this slice)
 *
 * The design doc §4.4 splits consolidation into NREM (deterministic —
 * promote/demote/archive/cluster) and REM (LLM-driven — community
 * summarisation, semantic contradiction, date normalisation). This
 * scheduler only fires the NREM half today; REM remains future work
 * because it requires LLM cost design + governance.
 *
 * ## Multi-profile note
 *
 * Calls run per-profile. The current API surface accepts a single
 * `defaultProfile` string; future operators with multiple active
 * profiles will need a profile enumeration hook (out of scope here —
 * surface as a follow-up if profile fan-out becomes load-bearing).
 */
import type { MemoryWikiConsolidation } from './consolidation.ts';
import type { MemoryWikiLint } from './lint.ts';

export const DEFAULT_CONSOLIDATION_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
export const DEFAULT_LINT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
/** Stagger first run so it doesn't race with serve startup. */
export const DEFAULT_INITIAL_DELAY_MS = 30_000;

/**
 * Opaque timer handle. Bun's setTimeout returns `Timer` (not Node's
 * `Timeout`), so we type by what we actually use: clearable via the
 * paired clear function and optionally `unref`-able. Keeping it
 * structural avoids the Bun-vs-Node lib mismatch.
 */
type SchedulerTimerHandle = { unref?: () => void };
type SchedulerTimerSet = (fn: () => void, ms: number) => SchedulerTimerHandle;
type SchedulerTimerClear = (handle: SchedulerTimerHandle) => void;

export interface WikiSchedulerOptions {
  readonly consolidation: MemoryWikiConsolidation;
  readonly lint: MemoryWikiLint;
  readonly defaultProfile: string;
  readonly consolidationIntervalMs?: number;
  readonly lintIntervalMs?: number;
  readonly initialDelayMs?: number;
  /** Test seam — replace with a fake timer in unit tests. */
  readonly setTimeoutImpl?: SchedulerTimerSet;
  readonly clearTimeoutImpl?: SchedulerTimerClear;
  readonly onError?: (op: 'consolidation' | 'lint', err: unknown) => void;
  /**
   * Hook run on every consolidation tick after success. Used by
   * doctor / tests to observe activity. Receives the report.
   */
  readonly onConsolidation?: (
    report: Awaited<ReturnType<MemoryWikiConsolidation['run']>>,
  ) => void;
  readonly onLint?: (result: ReturnType<MemoryWikiLint['run']>) => void;
}

export interface WikiScheduler {
  /** Total NREM consolidation ticks fired since start. */
  readonly stats: WikiSchedulerStats;
  /** Stop both timers. Idempotent. Pending in-flight tick may still finish. */
  stop(): void;
  /** Force one consolidation + lint cycle now (test/operator hook). */
  tickNow(): Promise<void>;
}

export interface WikiSchedulerStats {
  consolidationTicks: number;
  lintTicks: number;
  consolidationErrors: number;
  lintErrors: number;
  lastConsolidationAt: number | null;
  lastLintAt: number | null;
}

const defaultOnError = (op: string, err: unknown): void => {
  console.warn(
    `[vinyan-wiki] scheduler ${op} tick failed:`,
    err instanceof Error ? err.message : err,
  );
};

export function startWikiScheduler(opts: WikiSchedulerOptions): WikiScheduler {
  const setT: SchedulerTimerSet =
    opts.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms) as unknown as SchedulerTimerHandle);
  const clearT: SchedulerTimerClear =
    opts.clearTimeoutImpl ?? ((h) => clearTimeout(h as unknown as Parameters<typeof clearTimeout>[0]));
  const onError = opts.onError ?? defaultOnError;
  const consolidationIntervalMs = opts.consolidationIntervalMs ?? DEFAULT_CONSOLIDATION_INTERVAL_MS;
  const lintIntervalMs = opts.lintIntervalMs ?? DEFAULT_LINT_INTERVAL_MS;
  const initialDelayMs = opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;

  const stats: WikiSchedulerStats = {
    consolidationTicks: 0,
    lintTicks: 0,
    consolidationErrors: 0,
    lintErrors: 0,
    lastConsolidationAt: null,
    lastLintAt: null,
  };

  let stopped = false;
  let consolidationHandle: SchedulerTimerHandle | null = null;
  let lintHandle: SchedulerTimerHandle | null = null;

  const runConsolidationOnce = async (): Promise<void> => {
    try {
      const report = await opts.consolidation.run(opts.defaultProfile);
      stats.consolidationTicks += 1;
      stats.lastConsolidationAt = Date.now();
      opts.onConsolidation?.(report);
    } catch (err) {
      stats.consolidationErrors += 1;
      onError('consolidation', err);
    }
  };

  const runLintOnce = (): void => {
    try {
      const result = opts.lint.run({ profile: opts.defaultProfile });
      stats.lintTicks += 1;
      stats.lastLintAt = Date.now();
      opts.onLint?.(result);
    } catch (err) {
      stats.lintErrors += 1;
      onError('lint', err);
    }
  };

  const scheduleConsolidation = (delayMs: number): void => {
    if (stopped) return;
    consolidationHandle = setT(() => {
      void runConsolidationOnce();
      scheduleConsolidation(consolidationIntervalMs);
    }, delayMs);
    consolidationHandle.unref?.();
  };

  const scheduleLint = (delayMs: number): void => {
    if (stopped) return;
    lintHandle = setT(() => {
      runLintOnce();
      scheduleLint(lintIntervalMs);
    }, delayMs);
    lintHandle.unref?.();
  };

  scheduleConsolidation(initialDelayMs);
  scheduleLint(initialDelayMs + Math.floor(consolidationIntervalMs / 2));

  return {
    stats,
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (consolidationHandle) clearT(consolidationHandle);
      if (lintHandle) clearT(lintHandle);
    },
    async tickNow(): Promise<void> {
      await runConsolidationOnce();
      runLintOnce();
    },
  };
}
