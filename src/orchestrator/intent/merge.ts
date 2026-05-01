/**
 * Tier-merge logic for intent resolution (plan commit D7).
 *
 * Combines the deterministic tier (rule-based, trust 0.8) with the LLM tier
 * (classifier, trust 0.4 by A5) into a single IntentResolution. Extracted
 * from `src/orchestrator/intent-resolver.ts` so the decision algebra lives
 * in one place and is independently testable.
 *
 * Axiom A5: on true contradiction, the deterministic tier wins; the LLM
 * provides refinements (richer payloads, narrower scope, wider scope within
 * the allowed upgrade pairs) and tiebreakers, not overrides.
 *
 * Pure: no I/O, no module state. The `bus` parameter is optional; when
 * present, the merger emits `intent:uncertain` / `intent:contradiction`
 * events so upstream observability can record tier-disagreement rates.
 */

import { z } from 'zod';
import type { VinyanBus } from '../../core/bus.ts';
import type {
  ExecutionStrategy,
  IntentDeterministicCandidate,
  IntentResolution,
  IntentResolutionType,
  SemanticTaskUnderstanding,
  TaskInput,
} from '../types.ts';
import { buildClarificationRequest } from './formatters.ts';
import type { IntentResponseSchema } from './parser.ts';

/**
 * LLM confidence below this threshold is treated as "uncertain" — the merger
 * keeps the deterministic strategy and surfaces a clarification rather than
 * gambling on a weak tier-0.4 signal.
 */
export const LLM_UNCERTAIN_THRESHOLD = 0.5;

/**
 * An LLM strategy "refines" the deterministic strategy when it is either:
 *   - identical (agreement), or
 *   - a known upgrade pair (full-pipeline ↔ agentic-workflow,
 *     conversational → agentic-workflow) where the LLM is narrowing or
 *     widening scope in a way the rule tier would endorse.
 *
 * Everything else is a contradiction (A5: rule wins).
 */
export function isLLMRefinement(
  rule: ExecutionStrategy,
  llm: ExecutionStrategy,
): boolean {
  if (rule === llm) return true;
  if (rule === 'full-pipeline' && llm === 'agentic-workflow') return true;
  if (rule === 'agentic-workflow' && llm === 'full-pipeline') return true;
  if (rule === 'conversational' && llm === 'agentic-workflow') return true;
  return false;
}

/**
 * A5-safe merge — deterministic (tier 0.8) wins over LLM (tier 0.4) on true
 * contradictions; refinements are accepted; agreements are recorded as
 * known. Three branches:
 *
 *   1. LLM is low-confidence (< LLM_UNCERTAIN_THRESHOLD) → keep the rule's
 *      strategy, surface a clarification, emit `intent:uncertain`.
 *   2. Rule said `direct-tool` but produced no `directToolCall` (hollow
 *      rule) AND the LLM disagrees → A5 carve-out: trust the LLM as a
 *      refinement. A hollow rule has no artifact to defend.
 *   3. LLM is NOT a refinement of the rule → A5 contradiction; rule wins,
 *      emit `intent:contradiction`, surface a clarification.
 *   4. Otherwise (agreement or refinement) → accept the LLM's richer
 *      payload (refinedGoal, directToolCall, workflowPrompt) at
 *      confidence = max(det, llm).
 */
export function mergeDeterministicAndLLM(
  input: TaskInput,
  understanding: SemanticTaskUnderstanding,
  det: IntentResolution & { deterministicCandidate: IntentDeterministicCandidate },
  llm: z.infer<typeof IntentResponseSchema>,
  bus: VinyanBus | undefined,
  taskId: string,
): { resolution: IntentResolution; type: IntentResolutionType } {
  const llmConfidence = llm.confidence ?? 0.8;

  // Case 1: LLM low-confidence → uncertain. Keep deterministic strategy.
  if (llmConfidence < LLM_UNCERTAIN_THRESHOLD) {
    const { request, options } = buildClarificationRequest(
      input,
      understanding,
      det.strategy,
    );
    bus?.emit('intent:uncertain', {
      taskId,
      reason: `LLM confidence ${llmConfidence.toFixed(2)} below threshold ${LLM_UNCERTAIN_THRESHOLD}`,
      clarificationRequest: request,
    });
    // `...det` already preserves `collaboration` — the spread is the load-
    // bearing part. No explicit carry needed in this branch.
    return {
      resolution: {
        ...det,
        reasoning: `${det.reasoning} LLM uncertain (${llmConfidence.toFixed(2)}).`,
        reasoningSource: 'merged',
        clarificationRequest: request,
        clarificationOptions: options,
      },
      type: 'uncertain',
    };
  }

  // A5 carve-out: rule said 'direct-tool' but never resolved a concrete
  // `directToolCall` (hollow rule — just an opinion). A5's tier-0.8 trust
  // applies to deterministic FACTS, not unresolved hunches. Treat LLM
  // disagreement as refinement (LLM fills the gap) instead of contradiction.
  if (
    det.strategy === 'direct-tool' &&
    !det.directToolCall &&
    llm.strategy !== 'direct-tool'
  ) {
    const mergedStrategy = llm.strategy;
    const mergedConfidence = Math.max(det.confidence ?? 0, llmConfidence);
    return {
      resolution: {
        strategy: mergedStrategy,
        refinedGoal: llm.refinedGoal,
        directToolCall: llm.directToolCall,
        workflowPrompt: llm.workflowPrompt,
        confidence: mergedConfidence,
        reasoning: `A5 carve-out: rule=direct-tool had no resolved command (hollow); LLM=${llm.strategy} accepted as refinement. ${llm.reasoning}`,
        reasoningSource: 'merged',
        deterministicCandidate: det.deterministicCandidate,
        // The hollow-rule carve-out only fires for `direct-tool`, which is
        // mutually exclusive with the multi-agent-collaboration branch; so
        // `det.collaboration` is virtually never set here. Carry it anyway
        // for shape consistency — if a future deterministic source ever
        // produces both, the LLM's refinement should NOT drop the directive.
        ...(det.collaboration ? { collaboration: det.collaboration } : {}),
      },
      type: 'known',
    };
  }

  // Case 2: Contradiction — rule and LLM disagree and LLM isn't a pure
  // refinement. A5: rule wins (tier 0.8 > tier 0.4). Emit event, surface
  // clarification.
  if (!isLLMRefinement(det.strategy, llm.strategy)) {
    const { request, options } = buildClarificationRequest(
      input,
      understanding,
      det.strategy,
      llm.strategy,
    );
    bus?.emit('intent:contradiction', {
      taskId,
      ruleStrategy: det.strategy,
      llmStrategy: llm.strategy,
      ruleConfidence: det.confidence,
      llmConfidence,
      winner: det.strategy,
    });
    return {
      resolution: {
        ...det,
        reasoning: `A5 contradiction: rule=${det.strategy} (${(det.confidence ?? 0).toFixed(2)}) vs llm=${llm.strategy} (${llmConfidence.toFixed(2)}). Rule wins.`,
        reasoningSource: 'merged',
        clarificationRequest: request,
        clarificationOptions: options,
      },
      type: 'contradictory',
    };
  }

  // Case 3: Agreement or LLM refinement — accept LLM's richer payload.
  // Confidence = max of the two (they agree), but never below the
  // deterministic floor.
  //
  // Carry `det.collaboration` through. The deterministic multi-agent rule
  // emits at confidence 0.9, which usually bypasses the LLM advisory tier
  // entirely — but the merge function can still be invoked on
  // re-resolution paths (clarification answers, replans). The LLM does
  // NOT emit a CollaborationDirective; dropping the deterministic one
  // here would silently regress the user back to the flat workflow path.
  const mergedStrategy = llm.strategy;
  const mergedConfidence = Math.max(det.confidence ?? 0, llmConfidence);
  return {
    resolution: {
      strategy: mergedStrategy,
      refinedGoal: llm.refinedGoal,
      directToolCall: llm.directToolCall ?? det.directToolCall,
      workflowPrompt: llm.workflowPrompt,
      confidence: mergedConfidence,
      reasoning: llm.reasoning,
      reasoningSource: 'merged',
      deterministicCandidate: det.deterministicCandidate,
      ...(det.collaboration ? { collaboration: det.collaboration } : {}),
    },
    type: 'known',
  };
}
