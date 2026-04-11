/**
 * Shared retry logic for LLM providers.
 *
 * Exponential backoff with configurable max retries, base delay,
 * retryable status classification, and timeout handling.
 */

export interface RetryConfig {
  /** Maximum retry attempts (default: 3). */
  maxRetries: number;
  /** Base delay in ms for exponential backoff (default: 1000). */
  baseDelayMs: number;
  /** HTTP status codes that trigger a retry. */
  retryableStatuses: Set<number>;
  /** Request timeout in ms. */
  timeoutMs: number;
  /** Extract retry-after delay from a provider-specific error. Return ms or undefined. */
  parseRetryAfter?: (error: unknown) => number | undefined;
  /** Additional check: is this error retryable beyond status codes? */
  isRetryableError?: (error: Error) => boolean;
}

export const DEFAULT_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529]);

const DEFAULT_IS_RETRYABLE = (error: Error): boolean => {
  const msg = error.message;
  return msg.includes('fetch failed') || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT');
};

/**
 * Execute an async function with exponential backoff retry.
 *
 * The function receives an AbortSignal for timeout handling.
 * The AbortController is automatically managed per attempt.
 */
export async function retryWithBackoff<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  config: RetryConfig,
): Promise<T> {
  const { maxRetries, baseDelayMs, timeoutMs } = config;
  const isRetryable = config.isRetryableError ?? DEFAULT_IS_RETRYABLE;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await fn(controller.signal);
      clearTimeout(timer);
      return result;
    } catch (error) {
      clearTimeout(timer);
      controller.abort();

      const isTimeout = (error as Error).name === 'AbortError' || controller.signal.aborted;
      lastError = isTimeout
        ? new Error(`LLM API timeout after ${timeoutMs}ms`)
        : error instanceof Error
          ? error
          : new Error(String(error));

      if (attempt < maxRetries) {
        // Check if retryable via status code
        const status = (error as any)?.status;
        const isStatusRetryable = typeof status === 'number' && config.retryableStatuses.has(status);

        if (isStatusRetryable || isTimeout || isRetryable(lastError)) {
          // Use retry-after header if available, otherwise exponential backoff
          const retryAfterMs = config.parseRetryAfter?.(error);
          const delay = retryAfterMs ?? baseDelayMs * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      }
      throw lastError;
    }
  }
  throw lastError!;
}
