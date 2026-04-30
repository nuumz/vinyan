/**
 * Centralized LLM provider error classification.
 *
 * Outbound provider quota / rate-limit governance starts here. Every LLM
 * provider funnels failures through `classifyProviderError(...)` and throws
 * a typed {@link LLMProviderError} carrying a {@link NormalizedLLMProviderError}.
 * Downstream layers — ProviderHealthStore, the registry's health-aware
 * selection, the governance call wrapper — read the same normalized shape.
 *
 * Why central: OpenRouter wraps Google AI Studio errors inside
 * `error.metadata.raw` (a JSON string), so the retry-after lives at:
 *   error.metadata.raw -> error.details[type=google.rpc.RetryInfo].retryDelay
 *                                                                  ↑ "35.174346048s"
 * Letting individual call sites parse this would mean every provider, every
 * worker, and every retry helper would need to grow its own brittle copy.
 *
 * Axiom A3 (deterministic governance): classification is rule-based — no LLM
 * judges its own error. Axiom A9 (resilient degradation): the classifier
 * reports kind/retryAfter/recommendations; whether to wait, fall back, or
 * fail is the governance layer's call, not the classifier's.
 */

import { PromptTooLargeError } from '../types.ts';

// ────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────

export type LLMProviderErrorKind =
  | 'quota_exhausted'
  | 'rate_limited'
  | 'context_too_large'
  | 'auth_error'
  | 'transient_provider_error'
  | 'network_error'
  | 'unknown';

/**
 * Normalized cross-provider error shape — read by every governance consumer
 * (health store, registry, policy, bus events). The original raw error
 * survives in `rawProviderError` for diagnostics, but governance branches
 * MUST read the normalized fields only (cross-provider portability).
 */
export interface NormalizedLLMProviderError {
  kind: LLMProviderErrorKind;
  /** Provider id of the failing engine (e.g. `openrouter/fast/google/gemma-...`). */
  providerId: string;
  /** Provider tier (`fast` / `balanced` / `powerful` / `tool-uses`). */
  tier?: string;
  /** Upstream provider name when known — e.g. `Google AI Studio`, `Anthropic`. */
  providerName?: string;
  /** Concrete model id reported by the provider. */
  model?: string;
  /** HTTP status code that surfaced the error, if any. */
  status?: number;
  /** Sanitized one-line message for UI/event payloads. Excerpts long bodies. */
  message: string;
  /** Suggested wait before next attempt (ms). Cooldown is `now + retryAfterMs + safety`. */
  retryAfterMs?: number;
  /** Quota metric reported by the provider (e.g. Google `generativelanguage.googleapis.com/...`). */
  quotaMetric?: string;
  /** Quota id (e.g. `GenerateContentPaidTierInputTokensPerModelPerMinute`). */
  quotaId?: string;
  /** Additional quota dimensions (location, model, …). */
  quotaDimensions?: Record<string, string>;
  /** Raw provider error for diagnostics. NOT for governance branching. */
  rawProviderError?: unknown;
  /** True when the call SHOULD retry (after cooldown / fallback). */
  isRetryable: boolean;
  /** True when the policy should immediately switch to a different provider. */
  isFallbackRecommended: boolean;
  /** True when the health store should open a cooldown bucket for this provider/quota. */
  isGlobalCooldownRecommended: boolean;
}

/**
 * Typed exception thrown by every governed LLM call site. The retry helpers,
 * registry, and governance wrapper all read `.normalized`. Plain `Error`s
 * coming from the provider continue to work — the classifier accepts both.
 */
export class LLMProviderError extends Error {
  override readonly name = 'LLMProviderError';
  /** Carry the same `status`/`retryAfterHeader` props legacy retry consumers read. */
  readonly status?: number;
  readonly retryAfterHeader?: string;
  constructor(public readonly normalized: NormalizedLLMProviderError) {
    super(normalized.message);
    if (normalized.status !== undefined) this.status = normalized.status;
    if (normalized.retryAfterMs !== undefined) {
      // Surface as seconds — matches the wire shape retry helpers parse.
      this.retryAfterHeader = `${Math.ceil(normalized.retryAfterMs / 1000)}`;
    }
  }
}

export function isLLMProviderError(err: unknown): err is LLMProviderError {
  return err instanceof Error && err.name === 'LLMProviderError';
}

/** Inputs the classifier accepts. Either a parsed HTTP failure or an unknown thrown error. */
export type ClassifyInput =
  | {
      kind: 'http';
      providerId: string;
      tier?: string;
      providerName?: string;
      model?: string;
      status: number;
      bodyText?: string;
      retryAfterHeader?: string | null;
    }
  | {
      kind: 'thrown';
      providerId: string;
      tier?: string;
      providerName?: string;
      model?: string;
      error: unknown;
    };

// ────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────

const SAFETY_MARGIN_MS = 500;
const MAX_MESSAGE_LEN = 280;
/** OpenRouter wraps the upstream error message; we cap retry windows so a
 * malformed `retryDelay` cannot wedge selection forever. */
const RETRY_AFTER_HARD_CAP_MS = 5 * 60_000;

// ────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────

/**
 * Classify a provider failure into the normalized shape. Idempotent for
 * already-classified errors — re-wrapping an `LLMProviderError` returns its
 * existing `normalized` so re-throw chains stay stable.
 */
export function classifyProviderError(input: ClassifyInput): NormalizedLLMProviderError {
  if (input.kind === 'thrown' && isLLMProviderError(input.error)) {
    return input.error.normalized;
  }
  if (input.kind === 'thrown' && input.error instanceof PromptTooLargeError) {
    return base(input, {
      kind: 'context_too_large',
      message: truncate(input.error.message),
      isRetryable: false,
      isFallbackRecommended: false,
      isGlobalCooldownRecommended: false,
      rawProviderError: input.error,
    });
  }
  if (input.kind === 'http') {
    return classifyHttpFailure(input);
  }
  return classifyThrown(input);
}

/**
 * Build a stable bucket key for the cooldown store. Two provider failures
 * that hit the same `providerId` × `model` × `quotaMetric` × `quotaId` ×
 * dimension set are governed as ONE quota; different metrics on the same
 * provider get independent buckets so a per-minute quota recovery doesn't
 * release a per-day quota.
 */
export function quotaKey(err: Pick<
  NormalizedLLMProviderError,
  'providerId' | 'model' | 'quotaMetric' | 'quotaId' | 'quotaDimensions'
>): string {
  const dims = err.quotaDimensions
    ? Object.keys(err.quotaDimensions)
        .sort()
        .map((k) => `${k}=${err.quotaDimensions![k]}`)
        .join(',')
    : '';
  return [err.providerId, err.model ?? '', err.quotaMetric ?? '', err.quotaId ?? '', dims].join('|');
}

// ────────────────────────────────────────────────────────────────────────
// Internal: HTTP classification
// ────────────────────────────────────────────────────────────────────────

function classifyHttpFailure(input: Extract<ClassifyInput, { kind: 'http' }>): NormalizedLLMProviderError {
  const { status, bodyText = '', retryAfterHeader } = input;
  const parsedBody = parseOpenRouterBody(bodyText);
  const headerMs = parseRetryAfterHeader(retryAfterHeader ?? null);
  const bodyMs = parsedBody?.retryAfterMs;
  const retryAfterMs = clampRetryAfter(bodyMs ?? headerMs);

  const messageRaw = parsedBody?.message || extractFirstLine(bodyText) || `HTTP ${status}`;
  const message = truncate(`${input.providerId} ${status}: ${messageRaw}`);

  if (status === 413 || /context_length_exceeded|too large|prompt is too long/i.test(bodyText)) {
    return base(input, {
      kind: 'context_too_large',
      status,
      message,
      isRetryable: false,
      isFallbackRecommended: false,
      isGlobalCooldownRecommended: false,
      rawProviderError: bodyText,
    });
  }

  if (status === 401 || status === 403) {
    return base(input, {
      kind: 'auth_error',
      status,
      message,
      isRetryable: false,
      isFallbackRecommended: true,
      isGlobalCooldownRecommended: true,
      rawProviderError: bodyText,
    });
  }

  if (status === 429) {
    const isQuota =
      Boolean(parsedBody?.quotaMetric) ||
      /RESOURCE_EXHAUSTED|quota|paid_tier|free_tier_input_token_count/i.test(bodyText);
    return base(input, {
      kind: isQuota ? 'quota_exhausted' : 'rate_limited',
      status,
      message,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...(parsedBody?.quotaMetric ? { quotaMetric: parsedBody.quotaMetric } : {}),
      ...(parsedBody?.quotaId ? { quotaId: parsedBody.quotaId } : {}),
      ...(parsedBody?.quotaDimensions ? { quotaDimensions: parsedBody.quotaDimensions } : {}),
      ...(parsedBody?.providerName && !input.providerName ? { providerName: parsedBody.providerName } : {}),
      ...(parsedBody?.model && !input.model ? { model: parsedBody.model } : {}),
      isRetryable: true,
      isFallbackRecommended: true,
      isGlobalCooldownRecommended: true,
      rawProviderError: bodyText,
    });
  }

  if (status >= 500 && status < 600) {
    return base(input, {
      kind: 'transient_provider_error',
      status,
      message,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      isRetryable: true,
      // 5xx is provider-side flakiness; prefer a quick retry here, fall back only on repeat.
      isFallbackRecommended: false,
      isGlobalCooldownRecommended: true,
      rawProviderError: bodyText,
    });
  }

  return base(input, {
    kind: 'unknown',
    status,
    message,
    isRetryable: false,
    isFallbackRecommended: false,
    isGlobalCooldownRecommended: false,
    rawProviderError: bodyText,
  });
}

// ────────────────────────────────────────────────────────────────────────
// Internal: thrown-error classification
// ────────────────────────────────────────────────────────────────────────

function classifyThrown(input: Extract<ClassifyInput, { kind: 'thrown' }>): NormalizedLLMProviderError {
  const err = input.error;

  // Errors decorated by openrouter-provider/anthropic-provider with status +
  // retryAfterHeader fall through here when callers re-throw before we
  // classified. Reuse the HTTP path.
  const status = (err as { status?: number })?.status;
  const bodyMatch = (err as { body?: string })?.body ?? (err instanceof Error ? err.message : String(err));
  const retryHeader = (err as { retryAfterHeader?: string })?.retryAfterHeader;
  if (typeof status === 'number') {
    return classifyHttpFailure({
      kind: 'http',
      providerId: input.providerId,
      ...(input.tier ? { tier: input.tier } : {}),
      ...(input.providerName ? { providerName: input.providerName } : {}),
      ...(input.model ? { model: input.model } : {}),
      status,
      bodyText: bodyMatch,
      retryAfterHeader: retryHeader ?? null,
    });
  }

  const message = err instanceof Error ? err.message : String(err);
  // AbortError / fetch-failed / ECONNRESET / ETIMEDOUT — common Bun fetch failures.
  if (
    /AbortError|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(message)
  ) {
    return base(input, {
      kind: 'network_error',
      message: truncate(`${input.providerId}: ${message}`),
      isRetryable: true,
      isFallbackRecommended: false,
      isGlobalCooldownRecommended: false,
      rawProviderError: err,
    });
  }

  return base(input, {
    kind: 'unknown',
    message: truncate(`${input.providerId}: ${message}`),
    isRetryable: false,
    isFallbackRecommended: false,
    isGlobalCooldownRecommended: false,
    rawProviderError: err,
  });
}

// ────────────────────────────────────────────────────────────────────────
// Internal: OpenRouter / Google body parsing
// ────────────────────────────────────────────────────────────────────────

/**
 * Real-world OpenRouter 429 body for a Google-backed model:
 *
 *   {
 *     "error": {
 *       "message": "Rate limit exceeded: ...",
 *       "code": 429,
 *       "metadata": {
 *         "raw": "{\"error\":{\"code\":429,\"status\":\"RESOURCE_EXHAUSTED\",\"details\":[
 *           {\"@type\":\"type.googleapis.com/google.rpc.QuotaFailure\",\"violations\":[{...}]},
 *           {\"@type\":\"type.googleapis.com/google.rpc.RetryInfo\",\"retryDelay\":\"35.174346048s\"}
 *         ]}}",
 *         "provider_name": "Google AI Studio",
 *         "model": "google/gemma-4-26b-a4b-it:free"
 *       }
 *     }
 *   }
 *
 * We parse the outer envelope first, lift `metadata.raw` if it is a stringified
 * JSON, and walk Google's `details[]` array. Falls back to a regex against the
 * message body when the structured shape is absent.
 */
interface ParsedOpenRouterBody {
  message?: string;
  retryAfterMs?: number;
  quotaMetric?: string;
  quotaId?: string;
  quotaDimensions?: Record<string, string>;
  providerName?: string;
  model?: string;
}

function parseOpenRouterBody(body: string): ParsedOpenRouterBody | undefined {
  if (!body || !body.trim()) return undefined;
  let outer: unknown;
  try {
    outer = JSON.parse(body);
  } catch {
    // Plain-text body — try the message regex below.
    const ms = parseRetryFromText(body);
    return ms !== undefined ? { retryAfterMs: ms } : undefined;
  }

  const out: ParsedOpenRouterBody = {};
  const errObj = (outer as { error?: unknown })?.error as Record<string, unknown> | undefined;
  if (!errObj || typeof errObj !== 'object') return undefined;

  if (typeof errObj.message === 'string') out.message = errObj.message;
  const metadata = errObj.metadata as Record<string, unknown> | undefined;
  if (metadata && typeof metadata === 'object') {
    if (typeof metadata.provider_name === 'string') out.providerName = metadata.provider_name;
    if (typeof metadata.model === 'string') out.model = metadata.model;
    const raw = metadata.raw;
    if (typeof raw === 'string') {
      const inner = safeJsonParse(raw);
      if (inner) Object.assign(out, parseGoogleStatus(inner));
    } else if (raw && typeof raw === 'object') {
      Object.assign(out, parseGoogleStatus(raw));
    }
  }

  // Some OpenRouter responses surface `details` directly on the outer error.
  if (Array.isArray((errObj as { details?: unknown }).details)) {
    Object.assign(out, parseGoogleStatus(errObj));
  }

  if (out.retryAfterMs === undefined && typeof out.message === 'string') {
    const fromText = parseRetryFromText(out.message);
    if (fromText !== undefined) out.retryAfterMs = fromText;
  }
  if (out.retryAfterMs === undefined) {
    const fromBody = parseRetryFromText(body);
    if (fromBody !== undefined) out.retryAfterMs = fromBody;
  }

  return out;
}

interface GoogleStatusFields {
  retryAfterMs?: number;
  quotaMetric?: string;
  quotaId?: string;
  quotaDimensions?: Record<string, string>;
}

function parseGoogleStatus(obj: unknown): GoogleStatusFields {
  const out: GoogleStatusFields = {};
  if (!obj || typeof obj !== 'object') return out;
  const errInner = (obj as { error?: unknown }).error;
  const root = (errInner && typeof errInner === 'object' ? errInner : obj) as Record<string, unknown>;

  const details = root.details;
  if (!Array.isArray(details)) return out;

  for (const d of details) {
    if (!d || typeof d !== 'object') continue;
    const tag = ((d as { '@type'?: string })['@type'] ?? '').toString();
    if (tag.endsWith('google.rpc.RetryInfo')) {
      const delay = (d as { retryDelay?: string }).retryDelay;
      if (typeof delay === 'string') {
        const parsed = parseRetryDelayString(delay);
        if (parsed !== undefined) out.retryAfterMs = parsed;
      }
    } else if (tag.endsWith('google.rpc.QuotaFailure')) {
      const violations = (d as { violations?: unknown[] }).violations;
      if (Array.isArray(violations) && violations.length > 0) {
        const v = violations[0] as Record<string, unknown>;
        if (typeof v.quotaMetric === 'string') out.quotaMetric = v.quotaMetric;
        if (typeof v.quotaId === 'string') out.quotaId = v.quotaId;
        const dims = v.quotaDimensions;
        if (dims && typeof dims === 'object' && !Array.isArray(dims)) {
          out.quotaDimensions = Object.fromEntries(
            Object.entries(dims as Record<string, unknown>).filter(
              (e): e is [string, string] => typeof e[1] === 'string',
            ),
          );
        }
      }
    }
  }
  return out;
}

/**
 * Google's `RetryInfo.retryDelay` is a Duration: `"35s"`, `"35.174346048s"`,
 * `"0.500s"`. We accept fractional seconds and clamp at our hard ceiling.
 */
export function parseRetryDelayString(s: string): number | undefined {
  const m = /^([0-9]+(?:\.[0-9]+)?)\s*s$/i.exec(s.trim());
  if (!m) return undefined;
  const seconds = Number.parseFloat(m[1]!);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(Math.round(seconds * 1000), RETRY_AFTER_HARD_CAP_MS);
}

/**
 * Fallback: providers occasionally only embed the wait inside a free-text
 * message — `"Please retry in 35.174346048s"`, sometimes also `"... in 35s"`.
 */
export function parseRetryFromText(text: string): number | undefined {
  const m = /retry\s+(?:in|after)\s+([0-9]+(?:\.[0-9]+)?)\s*s/i.exec(text);
  if (!m) return undefined;
  const seconds = Number.parseFloat(m[1]!);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(Math.round(seconds * 1000), RETRY_AFTER_HARD_CAP_MS);
}

/**
 * HTTP `Retry-After` header parsing — supports both delta-seconds and the
 * obsolete HTTP-date form. Sub-second values round up to 1s so the next
 * attempt does not race the upstream window.
 */
export function parseRetryAfterHeader(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  const seconds = Number.parseInt(trimmed, 10);
  if (Number.isFinite(seconds) && seconds >= 0 && /^\d+$/.test(trimmed)) {
    return Math.min(seconds * 1000, RETRY_AFTER_HARD_CAP_MS);
  }
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    if (delta > 0) return Math.min(delta, RETRY_AFTER_HARD_CAP_MS);
  }
  return undefined;
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function base(
  input: Extract<ClassifyInput, { kind: 'http' | 'thrown' }>,
  rest: Omit<NormalizedLLMProviderError, 'providerId' | 'tier' | 'providerName' | 'model'>,
): NormalizedLLMProviderError {
  return {
    providerId: input.providerId,
    ...(input.tier ? { tier: input.tier } : {}),
    ...(input.providerName ? { providerName: input.providerName } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...rest,
  };
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function extractFirstLine(s: string): string {
  const i = s.indexOf('\n');
  return (i === -1 ? s : s.slice(0, i)).trim();
}

function truncate(s: string): string {
  return s.length > MAX_MESSAGE_LEN ? `${s.slice(0, MAX_MESSAGE_LEN - 1)}…` : s;
}

function clampRetryAfter(ms: number | undefined): number | undefined {
  if (ms === undefined) return undefined;
  if (ms <= 0) return undefined;
  return Math.min(ms + SAFETY_MARGIN_MS, RETRY_AFTER_HARD_CAP_MS);
}

export const SAFETY_MARGIN_MS_EXPORT = SAFETY_MARGIN_MS;
export const RETRY_AFTER_HARD_CAP_MS_EXPORT = RETRY_AFTER_HARD_CAP_MS;
