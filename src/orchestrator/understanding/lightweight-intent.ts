/**
 * Lightweight L0-L1 success criteria generator.
 * Rule-based (zero tokens, A3 compliant) — generates basic SemanticIntent
 * from Layer 0+1 metadata so L0-L1 workers get goal clarity.
 *
 * Without this, L0-L1 workers receive only raw goal text with no structure.
 */

import type { SemanticIntent, SemanticTaskUnderstanding, TaskInput } from '../types.ts';

/** Action verb → default primary action mapping. */
const ACTION_VERB_MAP: Record<string, SemanticIntent['primaryAction']> = {
  fix: 'bug-fix',
  repair: 'bug-fix',
  debug: 'bug-fix',
  add: 'add-feature',
  create: 'add-feature',
  implement: 'add-feature',
  build: 'add-feature',
  refactor: 'refactor',
  clean: 'refactor',
  optimize: 'performance-optimization',
  speed: 'performance-optimization',
  test: 'test-improvement',
  update: 'dependency-update',
  upgrade: 'dependency-update',
  migrate: 'api-migration',
  document: 'documentation',
  explain: 'investigation',
  investigate: 'investigation',
  analyze: 'investigation',
  configure: 'configuration',
  secure: 'security-fix',
};

/**
 * Build lightweight SemanticIntent from L0-L1 understanding metadata.
 * This is deterministic and free — no LLM call required.
 */
export function buildLightweightIntent(
  understanding: SemanticTaskUnderstanding,
  input: TaskInput,
): SemanticIntent {
  const primaryAction = ACTION_VERB_MAP[understanding.actionVerb] ?? 'other';

  // Generate success criteria from available metadata
  const successCriteria: string[] = [];

  // From explicit acceptance criteria (user-provided)
  if (understanding.acceptanceCriteria?.length) {
    successCriteria.push(...understanding.acceptanceCriteria);
  }

  // From task type + action verb (generic but useful)
  if (input.targetFiles?.length) {
    const files = input.targetFiles.slice(0, 3).join(', ');
    successCriteria.push(`Changes applied to: ${files}`);
  }

  // Action-specific criteria
  switch (primaryAction) {
    case 'bug-fix':
      successCriteria.push('The reported issue is resolved');
      successCriteria.push('No regressions introduced');
      break;
    case 'add-feature':
      successCriteria.push('New functionality works as described');
      successCriteria.push('Existing tests still pass');
      break;
    case 'refactor':
      successCriteria.push('Behavior is preserved (no functional changes)');
      successCriteria.push('Code readability improved');
      break;
    case 'test-improvement':
      successCriteria.push('New tests verify meaningful behavior');
      successCriteria.push('Tests pass consistently');
      break;
    case 'investigation':
      successCriteria.push('Root cause identified with evidence');
      break;
  }

  // From constraints
  const implicitConstraints = (understanding.constraints ?? []).map((c) => ({
    text: c,
    polarity: 'must' as const,
  }));

  // Resolved entities → affected components
  const affectedComponents = understanding.resolvedEntities
    ?.flatMap((e) => e.resolvedPaths)
    .slice(0, 5);

  return {
    primaryAction,
    secondaryActions: [],
    scope: input.targetFiles?.join(', ') ?? understanding.targetSymbol ?? 'workspace',
    implicitConstraints,
    ambiguities: [],
    goalSummary: input.goal.slice(0, 200),
    successCriteria: successCriteria.length > 0 ? successCriteria : undefined,
    affectedComponents: affectedComponents?.length ? affectedComponents : undefined,
    confidenceSource: 'llm-self-report', // Required by interface — but this is actually rule-based
    tierReliability: 0.4, // Required by interface — conservative
  };
}
