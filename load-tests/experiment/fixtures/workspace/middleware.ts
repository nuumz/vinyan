import { MAX_RETRIES, RETRY_DELAY_MS } from './constants.ts';
import { AppError } from './errors.ts';

export function withErrorHandler<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(error instanceof Error ? error.message : 'Unknown error', 'INTERNAL_ERROR', 500);
  }
}

export async function withRetry<T>(fn: () => Promise<T>, maxRetries: number = MAX_RETRIES): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }
  throw lastError;
}
