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
  detectRetryContinuation,
  detectShortAffirmativeContinuation,
} from './intent/short-affirmative.ts';
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
import { classifyExternalCodingCliIntent } from './intent/external-coding-cli-classifier.ts';
import { detectCodingCliContinuation } from './intent/external-coding-cli-continuation.ts';
import { userConstraintsOnly } from './constraints/pipeline-constraints.ts';
import type {
  AgentSpec,
  CapabilityRequirement,
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

// ---------------------------------------------------------------------------
// W3 H3 — schedule pre-classifier (add-only, does not touch existing strategies).
//
// A pre-filter: when the input text matches a small scheduling grammar AND is
// NOT a code-mutation task, we return `{ strategy: 'schedule', scheduleText }`.
// Callers (follow-up PR wires this into the orchestrator) dispatch this to
// `interpretSchedule()` instead of the normal pipeline. When the input does
// not match, the classifier returns `null` and the caller runs `resolveIntent`
// as before — existing behaviour is unchanged.
// ---------------------------------------------------------------------------

/** Strategy emitted by the NL-cron pre-classifier. Kept local to preserve the frozen `ExecutionStrategy` union. */
export interface ScheduleStrategyClassification {
  readonly strategy: 'schedule';
  readonly scheduleText: string;
}

const SCHEDULE_TRIGGER_RE =
  /\b(every\b|daily\b|weekly\b|at\s+\d|on\s+(mon|tue|wed|thu|fri|sat|sun|weekday|weekend))/i;

/**
 * Return `{ strategy: 'schedule', scheduleText }` when `text` matches the NL
 * scheduling grammar, `null` otherwise. Code-mutation hints (presence of
 * `targetFiles` or a domain of `code-mutation` in the supplied STU) suppress
 * the match so a scheduled-code-change reading (rare) does not swallow a
 * real code-mutation request.
 */
export function classifyScheduleStrategy(
  input: Pick<TaskInput, 'goal' | 'targetFiles'>,
  understanding?: SemanticTaskUnderstanding,
): ScheduleStrategyClassification | null {
  const text = input.goal;
  if (!text || !SCHEDULE_TRIGGER_RE.test(text)) return null;
  if (input.targetFiles && input.targetFiles.length > 0) return null;
  if (understanding?.taskDomain === 'code-mutation') return null;
  return { strategy: 'schedule', scheduleText: text };
}

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

/**
 * Map LLM-extracted capability requirements (from IntentResponseSchema) into
 * the internal `CapabilityRequirement` shape with `source: 'llm-extract'`.
 * Returns undefined when the LLM emitted nothing — keeps the field optional
 * so deterministic / no-LLM paths stay byte-identical.
 */
function mapLLMCapabilityRequirements(
  raw:
    | Array<{
        id: string;
        weight: number;
        fileExtensions?: string[];
        actionVerbs?: string[];
        domains?: string[];
        frameworkMarkers?: string[];
        role?: string;
      }>
    | undefined,
): CapabilityRequirement[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.map((r) => ({
    id: r.id,
    weight: r.weight,
    fileExtensions: r.fileExtensions,
    actionVerbs: r.actionVerbs,
    domains: r.domains,
    frameworkMarkers: r.frameworkMarkers,
    role: r.role,
    source: 'llm-extract' as const,
  }));
}

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

  const cacheKey = buildCacheKey(
    input.goal,
    deps.sessionId,
    understanding,
    deps.comprehension,
  );

  // [A.0] External Coding CLI deterministic pre-classifier — runs BEFORE
  // the cache lookup. If a stale cache entry from a prior LLM-tier
  // resolution exists for the same fingerprint (e.g., the user retried
  // before the orchestrator was upgraded to know about external-coding-
  // cli routing), the cache would otherwise serve the wrong strategy.
  // Structural matches MUST always win — that's the deterministic
  // governance invariant (A3).
  //
  // Continuation: when the user types a bare routing directive
  // ("full-pipeline", "retry", "ลองใหม่") right after a prior CLI
  // delegation, re-issue THAT delegation through the same dispatch.
  // Without this, the LLM workflow planner takes over and produces a
  // 7-step plan that *describes* "Generate and execute claude-code CLI
  // commands" as llm-reasoning steps, which never actually invoke the
  // controller and time out at L2 budget.
  {
    let cliIntent = classifyExternalCodingCliIntent(input.goal);
    if (!cliIntent.matched || cliIntent.confidence < 0.85) {
      const continuation = detectCodingCliContinuation({
        goal: input.goal,
        turns: deps.turns,
      });
      if (continuation.matched && continuation.reconstructed) {
        cliIntent = continuation.reconstructed;
        deps.bus?.emit('intent:short_retry_matched', {
          taskId: input.id,
          reconstructedFromTurnSeq: continuation.reconstructedFromTurnSeq ?? -1,
          reason: continuation.reason ?? 'cli-continuation',
        });
      }
    }
    if (cliIntent.matched && cliIntent.confidence >= 0.85) {
      const { agentId, agentSelectionReason } = resolveSelectedAgent(
        input,
        deps.agents,
        deps.defaultAgentId,
        undefined,
        `external-coding-cli pre-classifier (provider=${cliIntent.providerId}, conf=${cliIntent.confidence})`,
      );
      const result: IntentResolution = {
        strategy: 'agentic-workflow',
        refinedGoal: input.goal,
        workflowPrompt: `External coding CLI delegation: provider=${cliIntent.providerId}, mode=${cliIntent.requestedMode}. Task: ${cliIntent.taskText}${cliIntent.cwd ? `\nWorkspace: ${cliIntent.cwd}` : ''}${cliIntent.targetPaths.length > 0 ? `\nTargets: ${cliIntent.targetPaths.join(', ')}` : ''}`,
        confidence: cliIntent.confidence,
        reasoning: `Deterministic external-coding-cli classifier matched: ${cliIntent.reason}.`,
        reasoningSource: 'deterministic',
        type: 'known',
        agentId,
        agentSelectionReason,
        externalCodingCli: {
          providerId: cliIntent.providerId,
          mode: cliIntent.requestedMode,
          taskText: cliIntent.taskText,
          cwd: cliIntent.cwd,
          targetPaths: cliIntent.targetPaths,
          requiresVerification: true,
          reason: cliIntent.reason,
        },
      };
      // Overwrite any stale cache entry for this fingerprint so subsequent
      // turns see the deterministic verdict, not the LLM-tier ghost.
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
  }

  // [A] Cache — prefer comprehension.inputHash (A4 content-addressed) →
  // understandingFingerprint → (session, goal) as a last resort.
  const cached = intentCache.get(cacheKey, now);
  if (cached) {
    deps.bus?.emit('intent:cache_hit', { taskId: input.id, cacheKey });
    return { ...cached, reasoningSource: 'cache' };
  }

  // [A.5] Short-affirmative pre-classifier. Deterministic; runs before any LLM
  // call so a "จัดการให้เลย" / "go" / "do it" continuation does NOT get
  // re-classified as conversational and emit another empty acknowledgment.
  // Conservative match: requires both a tight affirmative regex AND a recent
  // assistant turn that promised a deliverable without producing it.
  const affirmative = detectShortAffirmativeContinuation({ goal: input.goal, turns: deps.turns });
  if (affirmative.matched && affirmative.reconstructedWorkflowPrompt) {
    const { agentId, agentSelectionReason } = resolveSelectedAgent(
      input,
      deps.agents,
      deps.defaultAgentId,
      undefined,
      `short-affirmative continuation (${affirmative.reason ?? 'matched'})`,
    );
    const result: IntentResolution = {
      strategy: 'agentic-workflow',
      refinedGoal: input.goal,
      workflowPrompt: affirmative.reconstructedWorkflowPrompt,
      confidence: 0.85,
      reasoning: `Short-affirmative continuation: ${affirmative.reason ?? 'matched prior unfulfilled deliverable proposal'}.`,
      reasoningSource: 'short-affirmative-continuation',
      type: 'known',
      agentId,
      agentSelectionReason,
    };
    intentCache.set(cacheKey, result, now);
    intentCache.prune(now);
    if (typeof affirmative.reconstructedFromTurnSeq === 'number') {
      deps.bus?.emit('intent:short_affirmative_matched', {
        taskId: input.id,
        reconstructedFromTurnSeq: affirmative.reconstructedFromTurnSeq,
        reason: affirmative.reason ?? 'matched',
      });
    }
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

  // [A.6] Short-retry pre-classifier. When the user types just "retry" /
  // "ลองใหม่" right after a failed or refused assistant turn, treat it as
  // re-issuing the prior user request — without this, the bare "retry"
  // routes to conversational shortcircuit and the persona answers as if it
  // were a new question, dropping the original intent entirely.
  const retry = detectRetryContinuation({ goal: input.goal, turns: deps.turns });
  if (retry.matched && retry.reconstructedWorkflowPrompt) {
    const { agentId, agentSelectionReason } = resolveSelectedAgent(
      input,
      deps.agents,
      deps.defaultAgentId,
      undefined,
      `short-retry continuation (${retry.reason ?? 'matched'})`,
    );
    const result: IntentResolution = {
      strategy: 'agentic-workflow',
      refinedGoal: input.goal,
      workflowPrompt: retry.reconstructedWorkflowPrompt,
      confidence: 0.85,
      reasoning: `Short-retry continuation: ${retry.reason ?? 'matched prior failed assistant turn'}.`,
      reasoningSource: 'short-retry-continuation',
      type: 'known',
      agentId,
      agentSelectionReason,
    };
    intentCache.set(cacheKey, result, now);
    intentCache.prune(now);
    if (typeof retry.reconstructedFromTurnSeq === 'number') {
      deps.bus?.emit('intent:short_retry_matched', {
        taskId: input.id,
        reconstructedFromTurnSeq: retry.reconstructedFromTurnSeq,
        reason: retry.reason ?? 'matched',
      });
    }
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

  // [A.7] Direct-tool pre-classifier — runs INDEPENDENTLY of STU so high-
  // confidence filesystem/shell goals short-circuit even when comprehension
  // hasn't built an understanding object. Without this, "ช่วยตรวจสอบไฟล์บน
  // ` ~/Desktop/`" falls through to the LLM intent classifier, which often
  // picks `full-pipeline` and dispatches a worker subprocess that hangs at
  // 90s waiting for a tool the planner already knew was a one-shot `ls`.
  //
  // Triggered only when the deterministic classifier returns a pre-resolved
  // shell_exec command at confidence ≥ 0.85 — that branch already validates
  // the path looks real (looksLikePath) and rejects bare nouns.
  {
    const directClass = classifyDirectTool(input.goal);
    if (
      directClass &&
      directClass.confidence >= 0.85 &&
      directClass.type === 'shell_exec' &&
      directClass.command
    ) {
      const { agentId, agentSelectionReason } = resolveSelectedAgent(
        input,
        deps.agents,
        deps.defaultAgentId,
        undefined,
        `direct-tool pre-classifier (shell_exec, conf=${directClass.confidence})`,
      );
      const result: IntentResolution = {
        strategy: 'direct-tool',
        refinedGoal: input.goal,
        directToolCall: { tool: 'shell_exec', parameters: { command: directClass.command } },
        confidence: directClass.confidence,
        reasoning: `Deterministic pre-classifier matched filesystem/shell goal → ${directClass.command}.`,
        reasoningSource: 'deterministic',
        type: 'known',
        agentId,
        agentSelectionReason,
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
  // Adaptive parameter — falls back to module-scope default when no store
  // is wired (existing callers preserve byte-identical behavior).
  const skipThreshold =
    deps.params?.getNumber('intent.deterministic_skip_threshold') ?? DETERMINISTIC_SKIP_THRESHOLD;
  if (
    deterministic &&
    deterministic.confidence >= skipThreshold &&
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
    capabilityRequirements: mapLLMCapabilityRequirements(parsed.capabilityRequirements),
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
