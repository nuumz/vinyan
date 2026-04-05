/**
 * Task Understanding — unified intermediate representation for task semantics.
 *
 * Computed once at ingestion (rule-based, A3-safe), enriched after perception.
 * Replaces fragmented goal parsing across self-model, task-fingerprint, and prompt assembly.
 *
 * Gap 9A: single source of truth for task semantics.
 * Gap 5B: unified extractActionVerb (from task-fingerprint.ts).
 * Gap 1C: consistent verb extraction across all components.
 * Gap 3A: symbol extraction from goal.
 * Gap 2B: goal-based action category (mutation vs analysis vs investigation).
 */
import { extractActionVerb } from './task-fingerprint.ts';
import type { ActionCategory, TaskInput, TaskUnderstanding } from './types.ts';

/** Verbs that indicate file mutations (code generation). */
const MUTATION_VERBS = new Set([
  'fix', 'add', 'remove', 'update', 'refactor', 'rename', 'move',
  'extract', 'inline', 'optimize', 'migrate', 'convert', 'implement',
  'delete', 'create',
]);

/** Verbs that indicate read-only analysis. */
const ANALYSIS_VERBS = new Set(['analyze', 'explain', 'describe', 'review', 'audit', 'inspect', 'summarize']);

/** Verbs that indicate investigation/debugging. */
const INVESTIGATION_VERBS = new Set(['investigate', 'debug', 'trace', 'find', 'diagnose', 'why']);

/** Verbs that indicate design/planning. */
const DESIGN_VERBS = new Set(['design', 'plan', 'architect', 'propose', 'suggest']);

/** Classify action verb into semantic category. */
function classifyActionCategory(verb: string, goal: string): ActionCategory {
  if (MUTATION_VERBS.has(verb)) return 'mutation';
  if (ANALYSIS_VERBS.has(verb)) return 'analysis';
  if (INVESTIGATION_VERBS.has(verb)) return 'investigation';
  if (DESIGN_VERBS.has(verb)) return 'design';

  // Fallback: check if the goal contains mutation-indicating words
  const lower = goal.toLowerCase();
  if (verb === 'test' || verb === 'write') {
    // "test X" could be "write tests for X" (mutation) or "test if X works" (analysis)
    // If goal mentions "write" or "add" near "test", it's mutation
    if (/write\s+tests?\b|add\s+tests?\b|create\s+tests?\b/.test(lower)) return 'mutation';
    return 'qa';
  }

  // Unknown verb — check for mutation signals in goal
  if (/\b(change|modify|edit|rewrite|replace|patch)\b/.test(lower)) return 'mutation';
  if (/\b(what|how|why|explain|describe|show)\b/.test(lower)) return 'analysis';

  return 'mutation'; // Default: assume mutation (safer — triggers full verification)
}

/**
 * Extract symbol references from goal text.
 * Matches backtick-wrapped identifiers and PascalCase.DotNotation patterns.
 */
function extractTargetSymbol(goal: string): string | undefined {
  // Backtick-wrapped: `AuthService.validate` or `validateToken`
  const backtickMatch = goal.match(/`([A-Za-z_$][\w$]*(?:\.\w+)*)`/);
  if (backtickMatch) return backtickMatch[1];

  // PascalCase.method pattern (not inside quotes): AuthService.validate
  const dotNotation = goal.match(/\b([A-Z][\w]*\.[\w]+(?:\.[\w]+)*)\b/);
  if (dotNotation) return dotNotation[1];

  return undefined;
}

/**
 * Build TaskUnderstanding from a TaskInput.
 * Rule-based (A3-safe) — no LLM in the path.
 * Call once at task ingestion; enrich with frameworkContext after perception.
 */
export function buildTaskUnderstanding(input: TaskInput): TaskUnderstanding {
  const actionVerb = extractActionVerb(input.goal);
  const actionCategory = classifyActionCategory(actionVerb, input.goal);
  const targetSymbol = extractTargetSymbol(input.goal);
  const expectsMutation = actionCategory === 'mutation' || actionCategory === 'qa';

  return {
    rawGoal: input.goal,
    actionVerb,
    actionCategory,
    targetSymbol,
    frameworkContext: [], // Populated after perception (detectFrameworkMarkers)
    constraints: input.constraints ?? [],
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    expectsMutation,
  };
}

/**
 * Enrich TaskUnderstanding with perception-derived data.
 * Called after perception assembly to add framework markers and fingerprint.
 */
export function enrichWithPerception(
  understanding: TaskUnderstanding,
  frameworkMarkers: string[],
): TaskUnderstanding {
  return {
    ...understanding,
    frameworkContext: frameworkMarkers,
  };
}
