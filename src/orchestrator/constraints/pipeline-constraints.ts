/**
 * Pipeline-vs-user constraint partitioning.
 *
 * `TaskInput.constraints` mixes two very different kinds of entries:
 *   (a) USER-FACING text — "respect line-length limit", "must use the
 *       existing logger helper". These are grounding the LLM should read.
 *   (b) PIPELINE METADATA — `CLARIFIED:Q=>A`, `COMPREHENSION_SUMMARY:{...}`,
 *       `MIN_ROUTING_LEVEL:2`, `THINKING:enabled`, etc. These are
 *       orchestrator-internal signals that specific consumers
 *       (buildInitUserMessage, risk-router) parse with their own grammars.
 *
 * Before this module, every prompt-building call site (decomposer,
 * replanner, workflow planner, intent resolver) dumped the whole array
 * into the LLM prompt as `- ${c}` bullets — so the LLM saw opaque JSON
 * blobs like `COMPREHENSION_SUMMARY:{"rootGoal":"write poem","state":...}`
 * alongside real user constraints. Effect: prompt clutter, risk that the
 * LLM "preserves" JSON into its plan, confused cache boundaries.
 *
 * This module defines the single source of truth for internal prefixes
 * and exposes `partitionConstraints()` so call sites render only
 * `.user` to the LLM. Pipeline metadata still reaches its specific
 * consumers via their own parsers (buildInitUserMessage still reads
 * CLARIFIED: / CLARIFICATION_BATCH: / COMPREHENSION_SUMMARY: directly
 * off `understanding.constraints`).
 *
 * When you add a new internal prefix, register it here. One source of
 * truth beats dozens of ad-hoc `startsWith('FOO:')` checks scattered
 * across the codebase.
 */

/**
 * Prefixes that are internal orchestrator-pipeline signals, NOT user
 * intent. Each entry includes a trailing `:` because prefixes all use
 * the `PREFIX:<payload>` convention.
 */
export const PIPELINE_CONSTRAINT_PREFIXES = [
  'CLARIFIED:',
  'CLARIFICATION_BATCH:',
  'CONTEXT:',
  'COMPREHENSION_CHECK:',
  'COMPREHENSION_SUMMARY:',
  'MEMORY_CONTEXT:',
  'MIN_ROUTING_LEVEL:',
  'RESEARCH_CONTEXT:',
  'SESSION_CONTEXT:',
  'TOOLS:',
  // Note: 'THINKING:enabled' is a bare token, not a prefix — handled
  // below by exact match.
] as const;

/** Exact-match pipeline tokens (not prefixed payloads). */
export const PIPELINE_CONSTRAINT_TOKENS = new Set<string>([
  'THINKING:enabled',
  'TOOLS:enabled',
]);

export interface PartitionedConstraints {
  /** Raw user intent — safe to render into LLM prompts verbatim. */
  readonly user: readonly string[];
  /** Pipeline metadata — consumed by specific parsers (not LLM prompts). */
  readonly pipeline: readonly string[];
}

/**
 * Partition a `TaskInput.constraints` array into user-facing entries
 * vs orchestrator-internal metadata.
 *
 * This is a pure function; callers should treat both halves as read-only.
 * Ordering within each half preserves input order (constraints are
 * order-sensitive for some consumers).
 */
export function partitionConstraints(
  constraints: readonly string[] | null | undefined,
): PartitionedConstraints {
  if (!constraints || constraints.length === 0) {
    return { user: [], pipeline: [] };
  }
  const user: string[] = [];
  const pipeline: string[] = [];
  for (const c of constraints) {
    if (isPipelineConstraint(c)) {
      pipeline.push(c);
    } else {
      user.push(c);
    }
  }
  return { user, pipeline };
}

/** Predicate form — useful for ad-hoc filters. */
export function isPipelineConstraint(constraint: string): boolean {
  if (PIPELINE_CONSTRAINT_TOKENS.has(constraint)) return true;
  for (const prefix of PIPELINE_CONSTRAINT_PREFIXES) {
    if (constraint.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Convenience: just the user entries, as a new array. Call-site sugar
 * for the common case `partitionConstraints(x).user`.
 */
export function userConstraintsOnly(
  constraints: readonly string[] | null | undefined,
): string[] {
  return [...partitionConstraints(constraints).user];
}
