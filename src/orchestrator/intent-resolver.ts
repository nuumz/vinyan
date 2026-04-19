/**
 * Intent Resolver — deterministic-first, LLM-advisory, tier-merged.
 *
 * Pipeline (§task-routing-spec.md v3 + axioms A3/A5):
 *   [A] cache lookup (understandingFingerprint | session+goal)
 *   [B] deterministic candidate    — classifyDirectTool + mapUnderstandingToStrategy (tier 0.8)
 *   [C] LLM advisory               — skipped when [B] confidence ≥ 0.85 AND !ambiguous
 *   [D] verify + merge             — agree / LLM-enrichment / A5 tier-winner / uncertain
 *   [E] cache write + bus emit
 *
 * A3: governance stays deterministic — LLM output is advisory and merged under
 * A5 tier order. A5: deterministic (tier 0.8) wins over LLM (tier 0.4) on disagreement.
 *
 * Source of truth: docs/spec/tdd.md §16 (Core Loop), docs/foundation/task-routing-spec.md
 */

import { z } from 'zod';
import type { VinyanBus } from '../core/bus.ts';
import { LRUTTLCache } from './intent/cache.ts';
import {
  computeStructuralFeatures,
  renderStructuralFeatures,
  type StructuralFeatures,
} from './intent/features.ts';
import {
  buildClarificationRequest,
  formatAgentCatalog,
  formatConversationContext,
  resolveSelectedAgent,
} from './intent/formatters.ts';
import {
  classifyWithFallback,
  pickPrimaryProvider,
} from './intent/llm-client.ts';
import {
  isLLMRefinement,
  LLM_UNCERTAIN_THRESHOLD,
  mergeDeterministicAndLLM,
} from './intent/merge.ts';
import {
  buildClassifierUserPrompt,
  buildComprehensionBlock,
} from './intent/prompt.ts';
import {
  composeDeterministicCandidate,
  fallbackStrategy,
  mapUnderstandingToStrategy,
} from './intent/strategy.ts';
import type { IntentResolverDeps } from './intent/types.ts';
import {
  containsShellFallbackChain,
  IntentResponseSchema,
  normalizeDirectToolCall,
  parseIntentResponse,
  stripJsonFences,
  withTimeout,
} from './intent/parser.ts';
import type { LLMProviderRegistry } from './llm/provider-registry.ts';
import { classifyDirectTool, resolveCommand } from './tools/direct-tool-resolver.ts';
import { userConstraintsOnly } from './constraints/pipeline-constraints.ts';
import type {
  AgentSpec,
  ConversationEntry,
  ExecutionStrategy,
  IntentDeterministicCandidate,
  IntentResolution,
  IntentResolutionType,
  LLMProvider,
  SemanticTaskUnderstanding,
  TaskInput,
} from './types.ts';
import {
  formatUserContextForPrompt,
  type UserInterestMiner,
} from './user-context/user-interest-miner.ts';

// ---------------------------------------------------------------------------
// Zod schema for LLM response parsing
// ---------------------------------------------------------------------------

// Commit D3: stripJsonFences / parseIntentResponse / containsShellFallbackChain
// / normalizeDirectToolCall / withTimeout moved to
// `src/orchestrator/intent/parser.ts` and imported at the top of this file.

// ---------------------------------------------------------------------------
// Structural features — deterministic metadata fed into the classifier prompt.
// We do NOT pattern-match semantic intent here (that's the LLM's job). We only
// compute signals that are unambiguous: length, end-punctuation, turn number.
// The classifier uses these alongside the goal text itself.
// ---------------------------------------------------------------------------

// Commit D2: StructuralFeatures + computeStructuralFeatures +
// renderStructuralFeatures moved to `src/orchestrator/intent/features.ts`
// — re-exported here to preserve the public surface area while call sites
// migrate.
export { computeStructuralFeatures, type StructuralFeatures };

// ---------------------------------------------------------------------------
// Session cache — skip re-classifying identical goals within a short TTL.
// Keyed by (sessionId, goal). Process-global; tests must call
// clearIntentResolverCache() between cases to avoid cross-contamination.
// ---------------------------------------------------------------------------

const INTENT_CACHE_TTL_MS = 30_000;
const INTENT_CACHE_PRUNE_THRESHOLD = 64;
const INTENT_CACHE_MAX_SIZE = 256;

// Commit D1: extracted LRU+TTL cache (src/orchestrator/intent/cache.ts) —
// same semantics as the prior inline Map + pruneIntentCache, now reusable
// and independently unit-tested.
const intentCache = new LRUTTLCache<IntentResolution>({
  ttlMs: INTENT_CACHE_TTL_MS,
  pruneThreshold: INTENT_CACHE_PRUNE_THRESHOLD,
  maxSize: INTENT_CACHE_MAX_SIZE,
});

function buildCacheKey(
  goal: string,
  sessionId?: string,
  understanding?: SemanticTaskUnderstanding,
  comprehension?: import('./comprehension/types.ts').ComprehendedTaskMessage,
): string {
  // When comprehension is available, bind the cache entry to its inputHash
  // (A4: content-addressed). Conversation state changes (new user turn,
  // pending-clarification flip) → comprehension inputHash changes → stale
  // cache auto-invalidates. This fixes the prior footgun where the same
  // `(session+goal)` across turns would reuse an intent that predated the
  // new context.
  if (comprehension?.params.inputHash) {
    return `cmp::${comprehension.params.inputHash}`;
  }
  // Prefer the content-addressed understandingFingerprint when available — it
  // invalidates automatically when the goal OR resolved paths OR task signature
  // change, giving us a stable cross-task key that survives minor goal edits
  // in the same session.
  if (understanding?.understandingFingerprint) {
    return `fp::${understanding.understandingFingerprint}`;
  }
  return `${sessionId ?? '__nosess__'}::${goal.trim().toLowerCase()}`;
}

/** Test-only: reset the module-level cache so each test starts clean. */
export function clearIntentResolverCache(): void {
  intentCache.clear();
}

/** Test-only: introspect cache size (for eviction assertions). */
export function intentResolverCacheSize(): number {
  return intentCache.size;
}

// ---------------------------------------------------------------------------
// Fallback: map existing regex-based classification to ExecutionStrategy
// ---------------------------------------------------------------------------

// Commit D5: fallbackStrategy / mapUnderstandingToStrategy /
// composeDeterministicCandidate moved to `src/orchestrator/intent/strategy.ts`
// and imported at the top of this file. Re-exported for backward compat.
export { composeDeterministicCandidate, fallbackStrategy, mapUnderstandingToStrategy };

// Commit D4: buildClarificationRequest / formatConversationContext /
// formatAgentCatalog / resolveSelectedAgent moved to
// `src/orchestrator/intent/formatters.ts` and imported at the top.

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

// Commit D6: IntentResolverDeps moved to `src/orchestrator/intent/types.ts`
// and imported at the top. Re-exported for legacy call sites.
export type { IntentResolverDeps };


/**
 * Threshold at which a deterministic candidate is trusted enough to bypass
 * the LLM entirely. Below this, we consult the LLM as an advisor.
 */
const DETERMINISTIC_SKIP_THRESHOLD = 0.85;

/**
 * Strategy pairs where rule vs. LLM disagreement is merely refinement (not
 * contradiction). Rule says X, LLM says Y — we accept Y because it carries
 * strictly more information (e.g. full-pipeline vs agentic-workflow with a
 * concrete workflowPrompt).
 */
// Commit D7: isLLMRefinement / mergeDeterministicAndLLM /
// LLM_UNCERTAIN_THRESHOLD moved to `src/orchestrator/intent/merge.ts` and
// imported at the top. The finalize* helpers stay here — they mutate the
// module-level intentCache and emit orchestrator-scoped bus events.

/** [B.skip] Finalize + emit a pure-deterministic resolution (no LLM consulted). */
function finalizeDeterministicSkip(
  input: TaskInput,
  deterministic: ReturnType<typeof composeDeterministicCandidate>,
  deps: IntentResolverDeps,
  cacheKey: string,
  now: number,
): IntentResolution {
  const { agentId, agentSelectionReason } = resolveSelectedAgent(
    input,
    deps.agents,
    deps.defaultAgentId,
    undefined,
    'deterministic skip (no LLM consulted)',
  );
  const result: IntentResolution = {
    ...deterministic,
    agentId,
    agentSelectionReason,
    type: 'known',
  };
  intentCache.set(cacheKey, result, now);
  intentCache.prune(now);
  deps.bus?.emit('intent:resolved', {
    taskId: input.id,
    strategy: result.strategy,
    confidence: result.confidence,
    reasoning: result.reasoning,
    type: 'known',
    source: 'deterministic',
  });
  return result;
}

/** [C.no-llm] Return the deterministic candidate when no LLM provider is registered. */
function finalizeDeterministicOnly(
  input: TaskInput,
  understanding: SemanticTaskUnderstanding,
  deterministic: ReturnType<typeof composeDeterministicCandidate>,
  deps: IntentResolverDeps,
  cacheKey: string,
  now: number,
): IntentResolution {
  const { agentId, agentSelectionReason } = resolveSelectedAgent(
    input,
    deps.agents,
    deps.defaultAgentId,
    undefined,
    'deterministic-only (no LLM available)',
  );
  const detType: IntentResolutionType = deterministic.deterministicCandidate.ambiguous ? 'uncertain' : 'known';
  const clarif =
    detType === 'uncertain' ? buildClarificationRequest(input, understanding, deterministic.strategy) : undefined;
  const result: IntentResolution = {
    ...deterministic,
    agentId,
    agentSelectionReason,
    type: detType,
    clarificationRequest: clarif?.request,
    clarificationOptions: clarif?.options,
  };
  intentCache.set(cacheKey, result, now);
  intentCache.prune(now);
  deps.bus?.emit('intent:resolved', {
    taskId: input.id,
    strategy: result.strategy,
    confidence: result.confidence,
    reasoning: result.reasoning,
    type: detType,
    source: 'deterministic',
  });
  if (detType === 'uncertain' && clarif) {
    deps.bus?.emit('intent:uncertain', {
      taskId: input.id,
      reason: 'Deterministic rule flagged ambiguity; no LLM available to advise.',
      clarificationRequest: clarif.request,
    });
  }
  return result;
}

// Commit D6: buildClassifierUserPrompt / buildComprehensionBlock moved to
// `src/orchestrator/intent/prompt.ts` and imported at the top of this file.


export async function resolveIntent(
  input: TaskInput,
  deps: IntentResolverDeps,
): Promise<IntentResolution> {
  const now = deps.now?.() ?? Date.now();
  const understanding = deps.understanding;

  // [A] Cache — prefer comprehension.inputHash (A4 content-addressed) →
  // understandingFingerprint → (session, goal) as a last resort.
  const cacheKey = buildCacheKey(
    input.goal,
    deps.sessionId,
    understanding,
    deps.comprehension,
  );
  const cached = intentCache.get(cacheKey, now);
  if (cached) {
    deps.bus?.emit('intent:cache_hit', { taskId: input.id, cacheKey });
    return { ...cached, reasoningSource: 'cache' };
  }

  // [B] Deterministic candidate (tier 0.8). Null when caller supplied no STU.
  const deterministic = understanding ? composeDeterministicCandidate(input, understanding) : null;

  // [B.skip] High-confidence deterministic → bypass LLM entirely.
  // Exception: when this turn is a clarification answer, the user's reply
  // may contradict the deterministic candidate (which was computed on the
  // original, ambiguous goal). Defer to the LLM so it can honor the reply
  // via the ROUTING RULE emitted in the classifier prompt.
  const isClarificationAnswer =
    deps.comprehension?.params.data?.state.isClarificationAnswer === true;
  if (
    deterministic &&
    deterministic.confidence >= DETERMINISTIC_SKIP_THRESHOLD &&
    !deterministic.deterministicCandidate.ambiguous &&
    !isClarificationAnswer
  ) {
    return finalizeDeterministicSkip(input, deterministic, deps, cacheKey, now);
  }

  // [C] LLM advisory. When no provider is registered, fall back to deterministic
  // or surface the legacy error (preserves backwards compatibility).
  const primary = pickPrimaryProvider(deps.registry);
  if (!primary) {
    if (deterministic && understanding) {
      return finalizeDeterministicOnly(input, understanding, deterministic, deps, cacheKey, now);
    }
    throw new Error('No LLM provider available for intent resolution');
  }

  const userPrompt = buildClassifierUserPrompt(input, deps, deterministic);
  const parsed = await classifyWithFallback(deps.registry, primary, userPrompt);

  // [D] Verify + merge. Rule + LLM → known / uncertain / contradictory.
  let mergeResult: { resolution: IntentResolution; type: IntentResolutionType } =
    deterministic && understanding
      ? mergeDeterministicAndLLM(input, understanding, deterministic, parsed, deps.bus, input.id)
      : {
          resolution: {
            strategy: parsed.strategy,
            refinedGoal: parsed.refinedGoal,
            directToolCall: parsed.directToolCall,
            workflowPrompt: parsed.workflowPrompt,
            confidence: parsed.confidence ?? 0.8,
            reasoning: parsed.reasoning,
            reasoningSource: 'llm',
          },
          type: 'known',
        };

  // [D.2] Clarification-answer bypass. When the comprehender flagged this
  // turn as an answer to a prior clarification, the user has JUST disambiguated
  // — surfacing another `uncertain` / `contradictory` verdict re-shows the same
  // clarification UI and traps the session in a loop. Trust the LLM strategy
  // (it received an explicit ROUTING RULE instructing it to honor the user's
  // reply) and promote the result to `known`. Deterministic still contributed
  // via the prompt; this only gates the verdict emission, not the generation.
  if (
    (mergeResult.type === 'contradictory' || mergeResult.type === 'uncertain') &&
    isClarificationAnswer
  ) {
    const bypassedType = mergeResult.type;
    mergeResult = {
      resolution: {
        strategy: parsed.strategy,
        refinedGoal: parsed.refinedGoal,
        directToolCall: parsed.directToolCall,
        workflowPrompt: parsed.workflowPrompt,
        confidence: parsed.confidence ?? 0.8,
        reasoning:
          `${parsed.reasoning ?? ''} [clarification-answer: bypassed ${bypassedType} gate, user already disambiguated]`.trim(),
        reasoningSource: 'merged',
      },
      type: 'known',
    };
  }

  const { agentId, agentSelectionReason } = resolveSelectedAgent(
    input,
    deps.agents,
    deps.defaultAgentId,
    { agentId: parsed.agentId, agentSelectionReason: parsed.agentSelectionReason },
  );

  const result: IntentResolution = {
    ...mergeResult.resolution,
    type: mergeResult.type,
    agentId,
    agentSelectionReason,
  };

  // [E] Cache write + bus emit.
  intentCache.set(cacheKey, result, now);
  intentCache.prune(now);
  deps.bus?.emit('intent:resolved', {
    taskId: input.id,
    strategy: result.strategy,
    confidence: result.confidence,
    reasoning: result.reasoning,
    type: result.type ?? 'known',
    source: result.reasoningSource ?? 'llm',
  });
  return result;
}
