/**
 * Ambient LLM trace context — propagated via AsyncLocalStorage so providers
 * can attach session/trace metadata to outbound API calls without threading
 * extra parameters through every layer of the orchestrator.
 *
 * Currently consumed by the OpenRouter provider to populate `session_id`,
 * `user`, and the free-form `trace` object (see
 * https://openrouter.ai/docs/guides/features/broadcast/overview). Other
 * providers may opt in by reading `getCurrentLLMTrace()` in their request
 * builder.
 *
 * Callers wrap a chunk of work — typically `executeTask` — with
 * `runWithLLMTrace({ sessionId, traceId })`. Nested calls inherit and may
 * shallow-merge additional fields (e.g. `generationName: 'critic'`).
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Trace metadata recognized by OpenRouter's broadcast/trace feature. Field
 * names map 1:1 to the wire format. `extra` lets callers attach platform-
 * specific keys (e.g. Langfuse tags) without widening this type.
 */
export interface LLMTraceMetadata {
  /** Up to 128 chars. Groups requests in OpenRouter's session view. */
  sessionId?: string;
  /** Up to 128 chars. End-user identifier. */
  userId?: string;
  /** Workflow / task correlation id. Distinct from sessionId. */
  traceId?: string;
  /** Human-readable trace label (defaults to operation name). */
  traceName?: string;
  /** Per-call span name within the trace. */
  spanName?: string;
  /** Per-generation label (e.g. phase name: 'plan', 'critic'). */
  generationName?: string;
  /** Parent span id when this call is nested inside another span. */
  parentSpanId?: string;
  /** 'production' | 'staging' | 'dev' — surfaces as an environment tag. */
  environment?: string;
  /** Free-form extras forwarded into the `trace` object verbatim. */
  extra?: Record<string, unknown>;
}

const storage = new AsyncLocalStorage<LLMTraceMetadata>();

/**
 * Run `fn` with `meta` as the ambient LLM trace context. Nested calls merge
 * shallowly: missing fields inherit from the outer scope, present fields
 * override.
 */
export function runWithLLMTrace<T>(meta: LLMTraceMetadata, fn: () => T): T {
  const merged = mergeTrace(storage.getStore(), meta);
  return storage.run(merged, fn);
}

/** Read the current ambient trace context, if any. */
export function getCurrentLLMTrace(): LLMTraceMetadata | undefined {
  return storage.getStore();
}

/**
 * Merge ambient context with an explicit per-request override. Explicit
 * fields win; `extra` objects are shallow-merged so callers can layer extras
 * without dropping ambient ones.
 */
export function resolveLLMTrace(explicit?: LLMTraceMetadata): LLMTraceMetadata | undefined {
  const ambient = storage.getStore();
  if (!ambient && !explicit) return undefined;
  return mergeTrace(ambient, explicit);
}

function mergeTrace(base: LLMTraceMetadata | undefined, next: LLMTraceMetadata | undefined): LLMTraceMetadata {
  if (!base) return { ...(next ?? {}) };
  if (!next) return { ...base };
  return {
    ...base,
    ...next,
    extra: base.extra || next.extra ? { ...(base.extra ?? {}), ...(next.extra ?? {}) } : undefined,
  };
}

/** Trim a value to OpenRouter's 128-char limit on session_id/user. */
export function clampOpenRouterId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.length <= 128 ? value : value.slice(0, 128);
}
