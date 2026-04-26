/**
 * Shared types for the intent-resolver module family.
 *
 * Extracted from `src/orchestrator/intent-resolver.ts` (plan commit D6).
 *
 * Keeping the dependency surface in a dedicated types module lets other
 * intent/ submodules (prompt builders, merge logic) accept the full deps
 * object without creating circular imports with intent-resolver.ts.
 */

import type { VinyanBus } from '../../core/bus.ts';
import type { UserInterestMiner } from '../user-context/user-interest-miner.ts';
import type { LLMProviderRegistry } from '../llm/provider-registry.ts';
import type { AgentSpec, SemanticTaskUnderstanding, Turn } from '../types.ts';

export interface IntentResolverDeps {
  registry: LLMProviderRegistry;
  availableTools?: string[];
  bus?: VinyanBus;
  /** Formatted user preferences string for prompt injection (from UserPreferenceStore). */
  userPreferences?: string;
  /**
   * Turn-model conversation history for multi-turn context. A6 renamed
   * from `conversationHistory: ConversationEntry[]`.
   */
  turns?: Turn[];
  /**
   * Multi-agent: roster of specialist agents. When provided, resolver picks
   * the best-fit agentId based on goal + task characteristics.
   */
  agents?: AgentSpec[];
  /** Default agent id used when resolver cannot confidently pick one. */
  defaultAgentId?: string;
  /**
   * Mines user interests / recent topics from TraceStore + SessionStore. When
   * provided, the resolver includes a "User context" block so the classifier
   * can reason about ambiguous goals against real past activity.
   */
  userInterestMiner?: UserInterestMiner;
  /** Session id for user-context mining (keyword extraction scoped to session). */
  sessionId?: string;
  /** Test hook for deterministic clock (cache TTL). */
  now?: () => number;
  /**
   * Pre-computed SemanticTaskUnderstanding. When supplied, the deterministic
   * path runs BEFORE the LLM (tier 0.8 candidate + ambiguity detection). When
   * absent, the resolver falls back to the pure-LLM path for backwards compat.
   */
  understanding?: SemanticTaskUnderstanding;
  /**
   * Oracle-verified conversation comprehension (pre-routing). When present:
   *  - `state.isClarificationAnswer=true` → resolver preserves the prior
   *    workflow (suppresses re-classification to conversational/direct-tool)
   *    by blending the signal into the cache key and the LLM user prompt.
   *  - `state.rootGoal` / `data.resolvedGoal` → appended to the prompt as
   *    grounding; classifier sees the user's real intent, not just the
   *    short reply text.
   *  - `state.hasAmbiguousReferents=true` without a resolved rootGoal →
   *    forces the resolver to treat the literal message as provisional
   *    (LLM advisory path even if deterministic would skip).
   */
  comprehension?: import('../comprehension/types.ts').ComprehendedTaskMessage;
}
