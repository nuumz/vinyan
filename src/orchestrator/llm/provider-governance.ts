/**
 * Provider governance — the policy seam between an `LLMProvider` and the
 * orchestrator. One file owns the four moves:
 *
 *   1. **Wrap** — every provider that joins the registry passes through
 *      `wrapProviderWithGovernance(...)`. The wrapper is shape-equivalent to
 *      the original `LLMProvider` (same `id`/`tier`/`generate`/
 *      `generateStream`), so existing call sites keep working unchanged.
 *   2. **Normalize** — when the underlying provider throws, the wrapper runs
 *      the error through `classifyProviderError(...)` and re-throws an
 *      `LLMProviderError`. Anything that bypassed the OpenRouter classifier
 *      (Anthropic SDK, fetch failure, third-party wrap) becomes a typed
 *      error here.
 *   3. **Record** — a normalized failure feeds `ProviderHealthStore` so the
 *      next selection skips the failing quota bucket. Success decays the
 *      counter and emits `llm:provider_recovered` if the bucket clears.
 *   4. **Surface** — the wrapper is the single emitter for
 *      `llm:provider_quota_exhausted` / `llm:provider_cooldown_started` /
 *      `llm:provider_unavailable`. Call-site code never has to remember to
 *      emit them.
 *
 * Axiom A3 — every decision (wrap, classify, record, emit) is rule-based.
 * Axiom A6 — the wrapper does not see API credentials; it only sits between
 * the orchestrator and the provider object that already holds them.
 * Axiom A9 — the wrapper degrades capability (cooldown + fallback hooks),
 * never corrupts task state.
 */

import type { VinyanBus } from '../../core/bus.ts';
import type { LLMProvider, LLMRequest, LLMResponse, OnTextDelta } from '../types.ts';
import { getCurrentLLMTrace } from './llm-trace-context.ts';
import {
  classifyProviderError,
  isLLMProviderError,
  LLMProviderError,
  type NormalizedLLMProviderError,
} from './provider-errors.ts';
import type { ProviderHealthStore } from './provider-health.ts';
import type { LLMProviderRegistry, SelectionResult } from './provider-registry.ts';

export interface ProviderGovernanceDeps {
  healthStore: ProviderHealthStore;
  bus?: VinyanBus;
}

/**
 * Decorate a provider so every call goes through the governance pipeline.
 *
 * Returns a new `LLMProvider` whose `id`/`tier` match the original — the
 * registry sees an indistinguishable slot. Re-wrapping is detected via a
 * symbol so calling this in a loop (factory rebuild) does not double-emit.
 */
const GOVERNED_MARKER = Symbol.for('vinyan.llm.providerGoverned');

export function wrapProviderWithGovernance(
  provider: LLMProvider,
  deps: ProviderGovernanceDeps,
): LLMProvider {
  if ((provider as { [GOVERNED_MARKER]?: boolean })[GOVERNED_MARKER]) return provider;

  const wrapped: LLMProvider = {
    id: provider.id,
    tier: provider.tier,
    ...(provider.capabilities ? { capabilities: provider.capabilities } : {}),
    ...(provider.maxContextTokens !== undefined ? { maxContextTokens: provider.maxContextTokens } : {}),
    ...(provider.supportsToolUse !== undefined ? { supportsToolUse: provider.supportsToolUse } : {}),
    async generate(request: LLMRequest): Promise<LLMResponse> {
      const cooldownBefore = deps.healthStore.getCooldown({ id: provider.id });
      try {
        const res = await provider.generate(request);
        onSuccess(provider, deps, cooldownBefore?.cooldownUntil);
        return res;
      } catch (err) {
        throw onFailure(provider, request, err, deps);
      }
    },
  };
  if (provider.generateStream) {
    wrapped.generateStream = async (request: LLMRequest, onDelta: OnTextDelta): Promise<LLMResponse> => {
      const cooldownBefore = deps.healthStore.getCooldown({ id: provider.id });
      try {
        const res = await provider.generateStream!(request, onDelta);
        onSuccess(provider, deps, cooldownBefore?.cooldownUntil);
        return res;
      } catch (err) {
        throw onFailure(provider, request, err, deps);
      }
    };
  }
  Object.defineProperty(wrapped, GOVERNED_MARKER, { value: true, enumerable: false });
  return wrapped;
}

/** Wrap every provider in a registry. Idempotent. Used by `factory.ts`. */
export function applyGovernanceToRegistry(
  registry: LLMProviderRegistry,
  deps: ProviderGovernanceDeps,
): void {
  registry.setHealthStore(deps.healthStore);
  for (const provider of registry.listProviders()) {
    const wrapped = wrapProviderWithGovernance(provider, deps);
    if (wrapped !== provider) registry.register(wrapped); // overwrite same id
  }
}

// ────────────────────────────────────────────────────────────────────────
// Selection-time helpers
// ────────────────────────────────────────────────────────────────────────

export interface GovernedSelectionInput {
  registry: LLMProviderRegistry;
  tier: LLMProvider['tier'];
  taskId?: string;
  bus?: VinyanBus;
  /** Try adjacent tiers when the requested tier is exhausted. Default true. */
  allowAdjacentTier?: boolean;
}

/**
 * Health-aware selection that ALSO emits the UI-visible bus events.
 *
 * Existing call sites (`selectByTier('balanced') ?? selectByTier('fast')`)
 * keep working because the registry skips cooled-down providers
 * automatically. This helper is for the few places that want to surface
 * fallback/unavailable events to the UI deterministically.
 */
export function selectGoverned(input: GovernedSelectionInput): LLMProvider | null {
  const detail: SelectionResult = input.registry.selectByTierDetailed(input.tier, {
    // Governance opts INTO adjacent-tier fallback; the bare `selectByTier`
    // defaults to `false` so legacy "no provider for tier" callers see
    // `undefined` like they did before.
    allowAdjacentTier: input.allowAdjacentTier ?? true,
    ...(input.taskId ? { taskId: input.taskId } : {}),
  });

  if (detail.skipped && detail.skippedCooldownUntil !== undefined && input.bus) {
    input.bus.emit('llm:provider_cooldown_skipped', {
      ...(input.taskId ? { taskId: input.taskId } : {}),
      providerId: detail.skipped.id,
      tier: detail.skipped.tier,
      cooldownUntil: detail.skippedCooldownUntil,
      rationale: detail.fellBackTier ? 'cooled-down; falling back to alternate tier' : 'cooled-down',
    });
  }

  if (!detail.provider) {
    input.bus?.emit('llm:provider_unavailable', {
      ...(input.taskId ? { taskId: input.taskId } : {}),
      requestedTier: input.tier,
      rationale: 'no healthy provider for tier or adjacent tiers',
      ...(detail.skippedCooldownUntil !== undefined
        ? { nextRetryHintMs: Math.max(0, detail.skippedCooldownUntil - Date.now()) }
        : {}),
    });
    return null;
  }

  if (detail.fellBackTier && detail.skipped && input.bus) {
    input.bus.emit('llm:provider_fallback_selected', {
      ...(input.taskId ? { taskId: input.taskId } : {}),
      fromProviderId: detail.skipped.id,
      fromTier: detail.skipped.tier,
      toProviderId: detail.provider.id,
      toTier: detail.provider.tier,
      rationale: 'preferred tier in cooldown',
    });
  }
  return detail.provider;
}

// ────────────────────────────────────────────────────────────────────────
// Internal: shared success / failure handling for the wrapper
// ────────────────────────────────────────────────────────────────────────

function onSuccess(
  provider: LLMProvider,
  deps: ProviderGovernanceDeps,
  cooldownUntilBefore: number | undefined,
): void {
  const now = Date.now();
  const wasCooled = cooldownUntilBefore !== undefined && cooldownUntilBefore > now;
  deps.healthStore.recordSuccess({ id: provider.id });
  if (wasCooled && deps.bus) {
    deps.bus.emit('llm:provider_recovered', {
      providerId: provider.id,
      tier: provider.tier,
      // Best-effort: cooldown was scheduled to last `cooldownUntilBefore - openedAt`
      // ms; without `openedAt` we approximate by reporting how much of the
      // window we still had at success time.
      cooldownDurationMs: Math.max(0, cooldownUntilBefore - now),
    });
  }
}

function onFailure(
  provider: LLMProvider,
  request: LLMRequest,
  rawErr: unknown,
  deps: ProviderGovernanceDeps,
): unknown {
  // PromptTooLargeError is a non-quota signal — let it pass through unmodified
  // so compress-and-retry logic upstream still works. Health bookkeeping does
  // not apply.
  if (rawErr instanceof Error && rawErr.name === 'PromptTooLargeError') {
    return rawErr;
  }
  // Use the existing normalized error if the provider already threw one
  // (OpenRouter does this); otherwise classify on the way through.
  const normalized: NormalizedLLMProviderError = isLLMProviderError(rawErr)
    ? rawErr.normalized
    : classifyProviderError({
        kind: 'thrown',
        providerId: provider.id,
        tier: provider.tier,
        error: rawErr,
      });

  const taskId = request.trace?.traceId ?? getCurrentLLMTrace()?.traceId;
  const ctx: { taskId?: string } = taskId ? { taskId } : {};
  const record = deps.healthStore.recordFailure(provider, normalized, ctx);

  if (deps.bus) {
    if (normalized.kind === 'quota_exhausted' || normalized.kind === 'rate_limited') {
      const evt: import('../../core/bus.ts').VinyanBusEvents['llm:provider_quota_exhausted'] = {
        taskId: taskId ?? '',
        providerId: provider.id,
        tier: provider.tier,
        errorKind: normalized.kind,
        message: normalized.message,
        ...(normalized.model ? { model: normalized.model } : {}),
        ...(normalized.status !== undefined ? { status: normalized.status } : {}),
        ...(normalized.retryAfterMs !== undefined ? { retryAfterMs: normalized.retryAfterMs } : {}),
        ...(normalized.quotaMetric ? { quotaMetric: normalized.quotaMetric } : {}),
        ...(normalized.quotaId ? { quotaId: normalized.quotaId } : {}),
      };
      // Recorder needs a non-empty taskId; suppress emit when we cannot
      // attribute. The health record was still updated above.
      if (taskId) deps.bus.emit('llm:provider_quota_exhausted', evt);
    }
    if (record) {
      const cdEvt: import('../../core/bus.ts').VinyanBusEvents['llm:provider_cooldown_started'] = {
        ...(taskId ? { taskId } : {}),
        providerId: record.providerId,
        ...(record.tier ? { tier: record.tier } : {}),
        ...(record.model ? { model: record.model } : {}),
        errorKind: record.lastKind,
        cooldownUntil: record.cooldownUntil,
        ...(record.retryAfterMs !== undefined ? { retryAfterMs: record.retryAfterMs } : {}),
        ...(record.quotaMetric ? { quotaMetric: record.quotaMetric } : {}),
        ...(record.quotaId ? { quotaId: record.quotaId } : {}),
        failureCount: record.failureCount,
        message: record.lastErrorMessage,
      };
      deps.bus.emit('llm:provider_cooldown_started', cdEvt);
    }
  }

  // Return the typed error so retry helpers and policy code see the
  // normalized shape consistently. The wrapper's caller decides what to do.
  return isLLMProviderError(rawErr) ? rawErr : new LLMProviderError(normalized);
}
