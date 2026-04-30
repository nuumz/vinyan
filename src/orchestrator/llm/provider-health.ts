/**
 * Provider quota / rate-limit cooldown store — Axiom A9 resilient
 * degradation for outbound LLM calls.
 *
 * Tracks cooldowns at the QUOTA-BUCKET grain (provider × model × quotaMetric ×
 * quotaId × dimensions) rather than per provider id, because the OpenRouter
 * provider id stays the same while the failing quota varies (per-minute
 * input-token vs per-day request count vs free-tier sample). One bucket
 * exhausting must not lock out the others.
 *
 * The store is in-memory and synchronous on purpose:
 *   - All call sites already run in one process; cross-process state is the
 *     LLM proxy's job (subprocess workers go through it for credentials, so
 *     they pick up the orchestrator's health view automatically).
 *   - Reading `isAvailable(...)` happens on the hot path of provider
 *     selection. A DB hit there would be a regression.
 *
 * Axiom A3 — every cooldown decision is rule-based: open on
 * quota_exhausted/rate_limited, exponential backoff on repeat 429 with no
 * `retryAfterMs`, longer cooldown on auth_error, short cooldown on transient
 * 5xx, decay on success. No LLM judges its own backoff.
 */

import type { VinyanBus } from '../../core/bus.ts';
import type { LLMProvider } from '../types.ts';
import {
  type LLMProviderErrorKind,
  type NormalizedLLMProviderError,
  quotaKey,
} from './provider-errors.ts';

// ────────────────────────────────────────────────────────────────────────
// Tunables — exported as constants so tests can read the same numbers.
// ────────────────────────────────────────────────────────────────────────

/** Min cooldown when the upstream did not provide `retryAfterMs`. */
export const HEALTH_DEFAULT_BASE_COOLDOWN_MS = 5_000;
/** Multiplier applied per repeat failure with no retryAfter. */
export const HEALTH_BACKOFF_FACTOR = 2;
/** Hard cap on exponential backoff so a stuck provider does not stay locked forever. */
export const HEALTH_MAX_COOLDOWN_MS = 5 * 60_000;
/** Cooldown applied to `transient_provider_error`. Shorter than 429 — usually flaps. */
export const HEALTH_TRANSIENT_COOLDOWN_MS = 5_000;
/** Cooldown applied to `auth_error` — usually requires operator action. */
export const HEALTH_AUTH_COOLDOWN_MS = 10 * 60_000;
/** Failure-counter half-life on success. */
export const HEALTH_FAILURE_DECAY = 0.5;

export interface ProviderHealthRecord {
  /** Bucket key from `quotaKey(...)`. */
  key: string;
  providerId: string;
  tier?: string;
  model?: string;
  providerName?: string;
  quotaMetric?: string;
  quotaId?: string;
  /** Until when this bucket is unavailable (epoch ms). */
  cooldownUntil: number;
  /** When the cooldown was opened (epoch ms). */
  openedAt: number;
  /** Number of consecutive failures captured under this bucket. */
  failureCount: number;
  /** Most recent normalized error kind that caused/extended cooldown. */
  lastKind: LLMProviderErrorKind;
  /** Sanitized excerpt of the last error message. */
  lastErrorMessage: string;
  /** Last suggested wait reported by the upstream. */
  retryAfterMs?: number;
  /** taskId of the call that triggered the most recent open. */
  sourceTaskId?: string;
}

export interface HealthEventEnvelope {
  type: 'cooldown_started' | 'cooldown_extended' | 'recovered' | 'unavailable';
  record: ProviderHealthRecord;
  taskId?: string;
}

export interface ProviderHealthDeps {
  /** Optional bus — when absent the store is silent (tests / standalone use). */
  bus?: VinyanBus;
  /** Pluggable wall-clock for deterministic tests. */
  now?: () => number;
}

/**
 * In-memory cooldown manager. Stateful per orchestrator process.
 *
 * The store does NOT decide what to do with an unavailable provider — that's
 * `provider-selection-policy.ts`'s job. The store only records, reports, and
 * emits events.
 */
export class ProviderHealthStore {
  private readonly records = new Map<string, ProviderHealthRecord>();
  private readonly listeners = new Set<(env: HealthEventEnvelope) => void>();
  private readonly clock: () => number;
  private readonly bus?: VinyanBus;

  constructor(deps: ProviderHealthDeps = {}) {
    this.clock = deps.now ?? Date.now;
    this.bus = deps.bus;
  }

  /**
   * Record a normalized failure. Opens / extends a cooldown bucket according
   * to error kind. Returns the resulting record (post-mutation) so callers
   * can include it in observability events without re-reading the store.
   */
  recordFailure(
    provider: Pick<LLMProvider, 'id' | 'tier'>,
    err: NormalizedLLMProviderError,
    context: { taskId?: string; sessionId?: string } = {},
  ): ProviderHealthRecord | null {
    if (!err.isGlobalCooldownRecommended) return null;

    const key = quotaKey({
      providerId: provider.id,
      ...(err.model ? { model: err.model } : {}),
      ...(err.quotaMetric ? { quotaMetric: err.quotaMetric } : {}),
      ...(err.quotaId ? { quotaId: err.quotaId } : {}),
      ...(err.quotaDimensions ? { quotaDimensions: err.quotaDimensions } : {}),
    });

    const now = this.clock();
    const prior = this.records.get(key);
    const failureCount = (prior?.failureCount ?? 0) + 1;

    const cooldownMs = computeCooldownMs(err, failureCount);
    const cooldownUntil = now + cooldownMs;

    const next: ProviderHealthRecord = {
      key,
      providerId: provider.id,
      ...(provider.tier ? { tier: provider.tier } : {}),
      ...(err.model ? { model: err.model } : {}),
      ...(err.providerName ? { providerName: err.providerName } : {}),
      ...(err.quotaMetric ? { quotaMetric: err.quotaMetric } : {}),
      ...(err.quotaId ? { quotaId: err.quotaId } : {}),
      cooldownUntil,
      openedAt: prior?.openedAt ?? now,
      failureCount,
      lastKind: err.kind,
      lastErrorMessage: err.message,
      ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
      ...(context.taskId ? { sourceTaskId: context.taskId } : {}),
    };
    this.records.set(key, next);

    const eventType: HealthEventEnvelope['type'] =
      prior && prior.cooldownUntil > now ? 'cooldown_extended' : 'cooldown_started';
    this.emit({ type: eventType, record: next, ...(context.taskId ? { taskId: context.taskId } : {}) });
    if (err.kind === 'auth_error') {
      this.emit({ type: 'unavailable', record: next, ...(context.taskId ? { taskId: context.taskId } : {}) });
    }
    return next;
  }

  /**
   * Decay the failure counter for any bucket pinned to this provider id. We
   * decay rather than clear so a flap-and-recover provider does not get full
   * trust restored after one good call.
   */
  recordSuccess(provider: Pick<LLMProvider, 'id'>): void {
    const now = this.clock();
    for (const [key, record] of this.records.entries()) {
      if (record.providerId !== provider.id) continue;
      const decayed = Math.floor(record.failureCount * HEALTH_FAILURE_DECAY);
      const cleared = decayed === 0 && record.cooldownUntil <= now;
      if (cleared) {
        this.records.delete(key);
        this.emit({ type: 'recovered', record: { ...record, failureCount: 0 } });
      } else if (decayed !== record.failureCount) {
        this.records.set(key, { ...record, failureCount: decayed });
      }
    }
  }

  /**
   * Cooldown-aware availability check. A provider is unavailable when ANY of
   * its quota buckets is in cooldown — different metrics on the same provider
   * id share the routing slot.
   */
  isAvailable(provider: Pick<LLMProvider, 'id'>, now: number = this.clock()): boolean {
    for (const record of this.records.values()) {
      if (record.providerId !== provider.id) continue;
      if (record.cooldownUntil > now) return false;
    }
    return true;
  }

  /** Return the soonest-expiring active cooldown for this provider, or `null`. */
  getCooldown(provider: Pick<LLMProvider, 'id'>, now: number = this.clock()): ProviderHealthRecord | null {
    let soonest: ProviderHealthRecord | null = null;
    for (const record of this.records.values()) {
      if (record.providerId !== provider.id) continue;
      if (record.cooldownUntil <= now) continue;
      if (!soonest || record.cooldownUntil < soonest.cooldownUntil) soonest = record;
    }
    return soonest;
  }

  /** All active and recently-active records (caller filters as needed). */
  listHealth(): ProviderHealthRecord[] {
    return Array.from(this.records.values());
  }

  /** Drop expired buckets. Useful for `/api/v1/providers/health` so stale rows do not pile up. */
  clearExpired(now: number = this.clock()): void {
    for (const [key, record] of this.records.entries()) {
      if (record.cooldownUntil <= now && record.failureCount === 0) {
        this.records.delete(key);
      }
    }
  }

  /**
   * Observability hook. The bus integration of governance events lives in
   * `provider-governance.ts`, but local tests / debug sinks can subscribe
   * here for the raw envelope without touching the bus.
   */
  onChange(listener: (env: HealthEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(env: HealthEventEnvelope): void {
    for (const listener of this.listeners) {
      try {
        listener(env);
      } catch (err) {
        // Listener errors must never break health bookkeeping.
        console.warn('[provider-health] listener threw; ignoring', err);
      }
    }
    this.bus?.emit('llm:provider_health_changed', {
      type: env.type,
      providerId: env.record.providerId,
      ...(env.record.tier ? { tier: env.record.tier } : {}),
      ...(env.record.model ? { model: env.record.model } : {}),
      cooldownUntil: env.record.cooldownUntil,
      failureCount: env.record.failureCount,
      kind: env.record.lastKind,
      ...(env.taskId ? { taskId: env.taskId } : {}),
    });
  }
}

// ────────────────────────────────────────────────────────────────────────
// Cooldown math — exported for tests
// ────────────────────────────────────────────────────────────────────────

export function computeCooldownMs(err: NormalizedLLMProviderError, failureCount: number): number {
  if (err.kind === 'auth_error') return HEALTH_AUTH_COOLDOWN_MS;
  if (err.retryAfterMs !== undefined) return Math.min(err.retryAfterMs, HEALTH_MAX_COOLDOWN_MS);
  if (err.kind === 'transient_provider_error') {
    return Math.min(HEALTH_TRANSIENT_COOLDOWN_MS * failureCount, HEALTH_MAX_COOLDOWN_MS);
  }
  // Repeated 429 with no retryAfter → exponential backoff with cap.
  const expo = HEALTH_DEFAULT_BASE_COOLDOWN_MS * Math.pow(HEALTH_BACKOFF_FACTOR, failureCount - 1);
  return Math.min(expo, HEALTH_MAX_COOLDOWN_MS);
}
