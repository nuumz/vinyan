/**
 * Audit payload redaction — tree-walker that reuses the trajectory redaction
 * policy.
 *
 * The trajectory pipeline (`src/trajectory/redaction.ts`) operates on
 * serialized artifact strings. Audit entries carry structured payload trees
 * (objects, arrays, primitives) where redaction must preserve structure so
 * the projection's `bySection` grouping still works. This helper walks a
 * tree and applies `applyPolicy()` to every string leaf — one redaction
 * policy, one policy hash, no second redaction surface.
 *
 * Source-side redaction is primary: emitters MUST redact `argsRedacted` /
 * `resultRedacted` / `payloadRedacted` before publishing. This walker is
 * the publish-boundary safety net.
 */

import { applyPolicy, type RedactionPolicy } from '../trajectory/redaction.ts';

/**
 * Walk `value` and return a new tree where every string leaf has had the
 * redaction policy applied. Non-string primitives (number, boolean, null,
 * undefined, bigint) pass through. Object keys are NOT redacted — they're
 * structural, not user content.
 *
 * Cycle-safe via WeakSet — a cyclic input returns `'<CYCLE>'` at the
 * second visit so callers cannot DOS the redactor with self-referential
 * payloads. (Audit payloads are JSON-shaped today, so cycles are unlikely,
 * but the guard is cheap.)
 *
 * Symbol-keyed properties and Function values are dropped. Date / Map /
 * Set instances are stringified via `String(value)` and then redacted —
 * audit payloads should never carry these, but better to redact than to
 * crash on JSON.stringify later.
 */
export function redactAuditPayload<T>(value: T, policy: RedactionPolicy): T {
  const seen = new WeakSet<object>();
  return walk(value, policy, seen) as T;
}

function walk(value: unknown, policy: RedactionPolicy, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;

  const t = typeof value;
  if (t === 'string') return applyPolicy(value as string, policy);
  if (t === 'number' || t === 'boolean' || t === 'bigint') return value;
  if (t === 'function' || t === 'symbol') return undefined;

  if (Array.isArray(value)) {
    if (seen.has(value)) return '<CYCLE>';
    seen.add(value);
    return value.map((item) => walk(item, policy, seen));
  }

  if (t === 'object') {
    if (seen.has(value as object)) return '<CYCLE>';
    seen.add(value as object);

    if (value instanceof Date || value instanceof Map || value instanceof Set) {
      return applyPolicy(String(value), policy);
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const walked = walk(v, policy, seen);
      if (walked !== undefined) out[k] = walked;
    }
    return out;
  }

  return value;
}
