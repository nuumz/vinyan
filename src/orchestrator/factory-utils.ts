/**
 * Factory utilities — shared helpers for orchestrator wiring.
 */

import type { VinyanBus } from '../core/bus.ts';

interface SafeInitSuccess<T> {
  ok: true;
  value: T;
}

interface SafeInitFailure {
  ok: false;
  error: unknown;
}

type SafeInitResult<T> = SafeInitSuccess<T> | SafeInitFailure;

/**
 * Best-effort component initialization — returns the value or a structured failure.
 * Replaces silent `try { ... } catch {}` blocks with observable error surface.
 */
export function safeInit<T>(
  component: string,
  fn: () => T,
  bus?: VinyanBus,
): SafeInitResult<T> {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    bus?.emit('factory:component_unavailable' as any, {
      component,
      error: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    });
    return { ok: false, error };
  }
}

/**
 * Async best-effort initialization — same as safeInit but for async constructors.
 */
export async function safeInitAsync<T>(
  component: string,
  fn: () => Promise<T>,
  bus?: VinyanBus,
): Promise<SafeInitResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    bus?.emit('factory:component_unavailable' as any, {
      component,
      error: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    });
    return { ok: false, error };
  }
}

/** Yield event loop long enough for render loop (33ms interval) to paint at least 1 frame. */
export const yieldFrame = () => new Promise<void>((r) => setTimeout(r, 16));
