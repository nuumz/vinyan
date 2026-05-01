/**
 * Shared retry logic for LLM providers.
 *
 * Two flavours:
 *
 *   `retryWithBackoff`        — single wall-clock timeout per attempt. Use for
 *                               non-streaming `provider.generate()` calls where
 *                               there is no progress signal during the request.
 *
 *   `retryStreamWithBackoff`  — three timeouts per attempt: connect (until first
 *                               byte), idle (between chunks, reset by caller),
 *                               and wall-clock (absolute safety net). Use for
 *                               `provider.generateStream()` so a healthy stream
 *                               that emits tokens for several minutes is not
 *                               killed by a fixed wall-clock that only made
 *                               sense for blocking calls.
 *
 * Both helpers share the same backoff, retry-after header parsing, and error
 * classification so the call sites stay consistent.
 */

/**
 * Heartbeat emitted before each backoff sleep — lets callers surface the
 * retry as live activity (delegate watchdog, dashboards, telemetry) rather
 * than letting silent backoff look like a hang.
 *
 * Fires AFTER the failed attempt resolved and BEFORE `setTimeout(delayMs)`,
 * so subscribers know the next attempt is scheduled and roughly when. Not
 * called on the terminal failure (when `attempt === maxRetries` or the
 * error is non-retryable) — that path just throws.
 */
export interface RetryAttemptInfo {
  /** 0-indexed attempt that just failed; the upcoming sleep precedes attempt `attempt + 1`. */
  attempt: number;
  /** Backoff delay in ms before the next attempt fires. */
  delayMs: number;
  /** Short label — error message, status string, or timeout kind. */
  reason: string;
  /** HTTP status code when the retry was triggered by a status response. */
  status?: number;
}

export type OnRetryAttempt = (info: RetryAttemptInfo) => void;

/**
 * In-flight heartbeat — fired at a fixed cadence WHILE the user-supplied
 * `fn` is awaiting (network round-trip, SDK call, stream open). Lets
 * callers emit liveness pings (e.g. `llm:request_alive`) so external
 * watchdogs do not interpret a long single LLM call as a hang. Cleared
 * automatically on attempt resolution (success OR error).
 *
 * Distinct from `OnRetryAttempt` (which fires once per BETWEEN-attempt
 * backoff sleep): heartbeat fires N times DURING each attempt.
 */
export interface RetryHeartbeatInfo {
  /** 0-indexed attempt currently in flight. */
  attempt: number;
  /** Elapsed ms since this attempt started. */
  durationMs: number;
}

export type OnRetryHeartbeat = (info: RetryHeartbeatInfo) => void;

/** Default heartbeat cadence — well below the 180s delegate idle floor (see workflow-executor.ts). */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

export interface RetryConfig {
  /** Maximum retry attempts (default: 3). */
  maxRetries: number;
  /** Base delay in ms for exponential backoff (default: 1000). */
  baseDelayMs: number;
  /** HTTP status codes that trigger a retry. */
  retryableStatuses: Set<number>;
  /** Wall-clock timeout in ms — applies to the entire attempt. */
  timeoutMs: number;
  /** Extract retry-after delay from a provider-specific error. Return ms or undefined. */
  parseRetryAfter?: (error: unknown) => number | undefined;
  /** Additional check: is this error retryable beyond status codes? */
  isRetryableError?: (error: Error) => boolean;
  /**
   * Called immediately before the backoff sleep on each retryable failure.
   * Use to emit liveness signals (e.g. `llm:retry_attempt`) so external
   * watchdogs do not interpret the silent sleep as a stall. Must not throw —
   * the retry helper logs and continues so a buggy hook cannot break retry.
   */
  onAttempt?: OnRetryAttempt;
  /**
   * Called periodically (every `heartbeatIntervalMs`) while the in-flight
   * attempt is awaiting. Use to emit liveness signals (e.g.
   * `llm:request_alive`) so external watchdogs do not flag a long
   * single LLM call as a hang. Must not throw — errors are swallowed.
   */
  onHeartbeat?: OnRetryHeartbeat;
  /** Heartbeat cadence (ms). Defaults to 30_000. Disabled when `onHeartbeat` is omitted. */
  heartbeatIntervalMs?: number;
}

/**
 * Three-timeout configuration for streaming LLM calls.
 *
 * Why three? A single wall-clock timeout cannot tell apart these failure modes:
 *   - server is unreachable (connect)         → caller wants to fail fast
 *   - server accepted but went silent (idle)  → caller wants to retry
 *   - server is genuinely slow (wall-clock)   → caller wants a long ceiling
 *
 * Pick values per tier; sensible starting points:
 *   - connectTimeoutMs: 30_000   (TCP/TLS + provider routing)
 *   - idleTimeoutMs:    90_000   (between any wire activity — content or ping)
 *   - wallClockMs:     600_000   (absolute cap for one attempt; >10 min is almost
 *                                 always a runaway loop on the provider side)
 */
export interface StreamRetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  retryableStatuses: Set<number>;
  /** Time from request start until `hooks.firstByte()` is called. */
  connectTimeoutMs: number;
  /** Time between consecutive `hooks.activity()` calls. Reset by every call. */
  idleTimeoutMs: number;
  /** Absolute cap on a single attempt — fires regardless of activity. */
  wallClockMs: number;
  parseRetryAfter?: (error: unknown) => number | undefined;
  isRetryableError?: (error: Error) => boolean;
  /**
   * Caller-owned cancellation. If aborted, retries stop immediately and the
   * abort reason propagates as the thrown error (no synthetic timeout wrap).
   */
  externalSignal?: AbortSignal;
  /** See `RetryConfig.onAttempt`. */
  onAttempt?: OnRetryAttempt;
  /** See `RetryConfig.onHeartbeat`. */
  onHeartbeat?: OnRetryHeartbeat;
  /** Heartbeat cadence (ms). Defaults to 30_000. Disabled when `onHeartbeat` is omitted. */
  heartbeatIntervalMs?: number;
}

/**
 * Lifecycle hooks the streaming caller invokes to keep the timeout machine
 * informed about wire activity.
 *
 *   `firstByte()`  — Call once when the connection is established and the
 *                    provider has started responding (typically right after
 *                    `fetch` resolves, or on the first stream event). Cancels
 *                    the connect timer and starts the idle timer. Idempotent
 *                    — subsequent calls are no-ops.
 *   `activity()`   — Call on EVERY signal of life from the wire: text chunk,
 *                    SSE comment / ping, tool-use delta, anything. Resets the
 *                    idle timer. Implicitly calls `firstByte()` if not yet
 *                    called, so callers that don't have a separate first-byte
 *                    signal can just call `activity()` per chunk.
 */
export interface StreamHooks {
  firstByte: () => void;
  activity: () => void;
}

export type StreamRetryFn<T> = (signal: AbortSignal, hooks: StreamHooks) => Promise<T>;

export const DEFAULT_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529]);

const DEFAULT_IS_RETRYABLE = (error: Error): boolean => {
  const msg = error.message;
  return msg.includes('fetch failed') || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT');
};

/**
 * Execute an async function with exponential backoff retry.
 *
 * The function receives an AbortSignal that fires when the wall-clock timeout
 * elapses. The AbortController is automatically managed per attempt.
 */
export async function retryWithBackoff<T>(fn: (signal: AbortSignal) => Promise<T>, config: RetryConfig): Promise<T> {
  const { maxRetries, baseDelayMs, timeoutMs } = config;
  const isRetryable = config.isRetryableError ?? DEFAULT_IS_RETRYABLE;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    // In-flight heartbeat for long single LLM calls (e.g. author writing
    // a 150s prose response). Without this, the watchdog watching the
    // bus sees zero events between dispatch and completion and idles
    // out at 120s. The interval is capped well below that floor so a
    // real hang is still caught at HARD_CEILING_MS.
    const heartbeatStart = Date.now();
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    if (config.onHeartbeat) {
      const intervalMs = config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
      heartbeatTimer = setInterval(() => {
        try {
          config.onHeartbeat?.({ attempt, durationMs: Date.now() - heartbeatStart });
        } catch (err) {
          console.warn('[retry] onHeartbeat threw; ignoring', err);
        }
      }, intervalMs);
      (heartbeatTimer as { unref?: () => void }).unref?.();
    }
    try {
      const result = await fn(controller.signal);
      clearTimeout(timer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      return result;
    } catch (error) {
      clearTimeout(timer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);

      // `timedOut` is the only reliable discriminator: checking
      // `controller.signal.aborted` after an unrelated error would always
      // return true the moment we aborted defensively, so use the flag.
      const isTimeout = timedOut;
      lastError = isTimeout
        ? new Error(`LLM API timeout after ${timeoutMs}ms`)
        : error instanceof Error
          ? error
          : new Error(String(error));

      if (attempt < maxRetries) {
        const status = (error as { status?: number })?.status;
        const isStatusRetryable = typeof status === 'number' && config.retryableStatuses.has(status);

        if (isStatusRetryable || isTimeout || isRetryable(lastError)) {
          const retryAfterMs = config.parseRetryAfter?.(error);
          const delay = retryAfterMs ?? baseDelayMs * 2 ** attempt;
          // Heartbeat for the upcoming sleep so external watchdogs (e.g.
          // delegate-sub-agent watchdog) do not flag the backoff as a
          // hang. A buggy hook must not break the retry, so we swallow.
          if (config.onAttempt) {
            try {
              config.onAttempt({
                attempt,
                delayMs: delay,
                reason: lastError.message,
                ...(typeof status === 'number' ? { status } : {}),
              });
            } catch (hookErr) {
              console.warn('[retry] onAttempt threw; ignoring', hookErr);
            }
          }
          // R2 — chunk the sleep into heartbeat-cadence ticks so the
          // delegate watchdog sees an activity signal at most every
          // `heartbeatIntervalMs` (default 30s). A naive single sleep
          // longer than the watchdog's idle window (180s) would trip a
          // false-positive timeout even though the system is healthy-
          // but-paused. Each tick re-fires `onAttempt` so the existing
          // `llm:retry_attempt` bus event keeps the watchdog reset.
          // The TOTAL sleep duration is unchanged (`delay`); only the
          // emission cadence is finer.
          const heartbeat = Math.max(1_000, config.heartbeatIntervalMs ?? 30_000);
          await sleepWithHeartbeat(delay, heartbeat, () => {
            if (config.onAttempt) {
              try {
                config.onAttempt({
                  attempt,
                  delayMs: delay,
                  reason: `${lastError?.message ?? 'retry'} [heartbeat]`,
                  ...(typeof status === 'number' ? { status } : {}),
                });
              } catch (hookErr) {
                console.warn('[retry] onAttempt heartbeat threw; ignoring', hookErr);
              }
            }
          });
          continue;
        }
      }
      throw lastError;
    }
  }
  throw lastError ?? new Error('retryWithBackoff exhausted with no error');
}

/**
 * Sleep for `totalMs` while invoking `onTick` at most every
 * `intervalMs` so external watchdogs can observe liveness during a
 * long backoff. Total wall-clock duration is exactly `totalMs`.
 *
 * Internal helper — exported for tests.
 */
export async function sleepWithHeartbeat(
  totalMs: number,
  intervalMs: number,
  onTick: () => void,
): Promise<void> {
  if (totalMs <= intervalMs) {
    await new Promise((r) => setTimeout(r, totalMs));
    return;
  }
  let remaining = totalMs;
  while (remaining > intervalMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    remaining -= intervalMs;
    onTick();
  }
  if (remaining > 0) {
    await new Promise((r) => setTimeout(r, remaining));
  }
}

type TimeoutMode = 'connect' | 'idle' | 'wallClock';

const TIMEOUT_LABELS: Record<TimeoutMode, string> = {
  connect: 'connect timeout',
  idle: 'idle timeout (no activity)',
  wallClock: 'wall-clock timeout',
};

interface TimeoutMachine {
  signal: AbortSignal;
  hooks: StreamHooks;
  getMode(): TimeoutMode | null;
  cleanup(): void;
}

/**
 * Wires the three-timeout state machine for one stream attempt. Encapsulating
 * this keeps `retryStreamWithBackoff` itself short — the lifetimes of timers,
 * the firstByte/activity transitions, and the external-signal listener are all
 * managed here.
 */
function createTimeoutMachine(
  config: Pick<StreamRetryConfig, 'connectTimeoutMs' | 'idleTimeoutMs' | 'wallClockMs' | 'externalSignal'>,
): TimeoutMachine {
  const controller = new AbortController();
  let mode: TimeoutMode | null = null;
  let firstByteSeen = false;

  const fire = (m: TimeoutMode) => {
    if (mode) return;
    mode = m;
    controller.abort();
  };

  let connectTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => fire('connect'), config.connectTimeoutMs);
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const wallClockTimer = setTimeout(() => fire('wallClock'), config.wallClockMs);

  const startIdle = () => {
    firstByteSeen = true;
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
    idleTimer = setTimeout(() => fire('idle'), config.idleTimeoutMs);
  };

  const onExternalAbort = () => {
    if (!mode) controller.abort();
  };
  config.externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  return {
    signal: controller.signal,
    hooks: {
      firstByte: () => {
        if (firstByteSeen) return;
        startIdle();
      },
      activity: () => {
        if (!firstByteSeen) {
          startIdle();
          return;
        }
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => fire('idle'), config.idleTimeoutMs);
      },
    },
    getMode: () => mode,
    cleanup: () => {
      if (connectTimer) clearTimeout(connectTimer);
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(wallClockTimer);
      config.externalSignal?.removeEventListener('abort', onExternalAbort);
    },
  };
}

function timeoutMs(mode: TimeoutMode, config: StreamRetryConfig): number {
  if (mode === 'connect') return config.connectTimeoutMs;
  if (mode === 'idle') return config.idleTimeoutMs;
  return config.wallClockMs;
}

function isStreamRetryable(
  error: unknown,
  classified: Error,
  isTimeoutRetryable: boolean,
  config: StreamRetryConfig,
  isRetryable: (e: Error) => boolean,
): boolean {
  if (isTimeoutRetryable) return true;
  const status = (error as { status?: number })?.status;
  if (typeof status === 'number' && config.retryableStatuses.has(status)) return true;
  return isRetryable(classified);
}

interface StreamErrorClassification {
  wrapped: Error;
  timedOutByUs: boolean;
}

function classifyStreamError(
  error: unknown,
  mode: TimeoutMode | null,
  signal: AbortSignal,
  config: StreamRetryConfig,
): StreamErrorClassification {
  const aborted = (error as Error).name === 'AbortError' || signal.aborted;
  if (aborted && mode !== null) {
    return {
      wrapped: new Error(`LLM API ${TIMEOUT_LABELS[mode]} after ${timeoutMs(mode, config)}ms`),
      timedOutByUs: true,
    };
  }
  return {
    wrapped: error instanceof Error ? error : new Error(String(error)),
    timedOutByUs: false,
  };
}

/**
 * Streaming variant of `retryWithBackoff`. Per attempt:
 *
 *   1. A connect timer fires after `connectTimeoutMs` if `hooks.firstByte()`
 *      isn't called — typical TCP/TLS/provider-routing failure.
 *   2. Once `firstByte()` fires, an idle timer fires after `idleTimeoutMs`
 *      unless `hooks.activity()` is called again. Each `activity()` resets
 *      the timer.
 *   3. A wall-clock timer fires after `wallClockMs` regardless — safety net
 *      against provider loops or pathological streams.
 *
 * On any of those firings the supplied `signal` aborts. Callers that own the
 * underlying transport (raw fetch reader, SDK stream object) should `try/await`
 * inside `fn`; the AbortError will surface and `retryStreamWithBackoff` will
 * convert it to a typed timeout error and decide whether to retry.
 *
 * If `externalSignal` is supplied and aborts, retries stop immediately and the
 * caller's reason propagates without being wrapped in a timeout error.
 */
export async function retryStreamWithBackoff<T>(fn: StreamRetryFn<T>, config: StreamRetryConfig): Promise<T> {
  const { maxRetries, baseDelayMs, externalSignal } = config;
  const isRetryable = config.isRetryableError ?? DEFAULT_IS_RETRYABLE;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (externalSignal?.aborted) {
      throw externalSignal.reason instanceof Error ? externalSignal.reason : new Error('Aborted by caller');
    }

    const machine = createTimeoutMachine(config);
    // In-flight heartbeat — same purpose as in `retryWithBackoff`. The
    // streaming path already calls `hooks.activity()` per chunk, but
    // those hooks are LOCAL to the retry timeout machine and do NOT
    // reach the bus. The watchdog sits on the bus, so we still need
    // an explicit emit. For pure-streaming providers chunks fire often
    // enough that the heartbeat is redundant; for hybrid providers
    // that hold a long pre-stream pause it is the only liveness ping.
    const heartbeatStart = Date.now();
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    if (config.onHeartbeat) {
      const intervalMs = config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
      heartbeatTimer = setInterval(() => {
        try {
          config.onHeartbeat?.({ attempt, durationMs: Date.now() - heartbeatStart });
        } catch (err) {
          console.warn('[retry] onHeartbeat threw; ignoring', err);
        }
      }, intervalMs);
      (heartbeatTimer as { unref?: () => void }).unref?.();
    }

    try {
      const result = await fn(machine.signal, machine.hooks);
      machine.cleanup();
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      return result;
    } catch (error) {
      machine.cleanup();
      if (heartbeatTimer) clearInterval(heartbeatTimer);

      // External cancel takes precedence — propagate without retry.
      if (externalSignal?.aborted) {
        throw error instanceof Error ? error : new Error(String(error));
      }

      const { wrapped, timedOutByUs } = classifyStreamError(error, machine.getMode(), machine.signal, config);
      lastError = wrapped;

      if (attempt < maxRetries && isStreamRetryable(error, wrapped, timedOutByUs, config, isRetryable)) {
        const retryAfterMs = config.parseRetryAfter?.(error);
        const delay = retryAfterMs ?? baseDelayMs * 2 ** attempt;
        if (config.onAttempt) {
          const status = (error as { status?: number })?.status;
          try {
            config.onAttempt({
              attempt,
              delayMs: delay,
              reason: wrapped.message,
              ...(typeof status === 'number' ? { status } : {}),
            });
          } catch (hookErr) {
            console.warn('[retry] onAttempt threw; ignoring', hookErr);
          }
        }
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError ?? new Error('retryStreamWithBackoff exhausted with no error');
}
