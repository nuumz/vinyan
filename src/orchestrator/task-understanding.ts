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
import { createHash } from 'node:crypto';
import type { TraceStore } from '../db/trace-store.ts';
import type { WorldGraph } from '../world-graph/world-graph.ts';
import { EntityResolver } from './entity-resolver.ts';
import { profileHistory } from './historical-profiler.ts';
import { computeTaskSignature } from './self-model.ts';
import { extractActionVerb } from './task-fingerprint.ts';
import type { ActionCategory, SemanticTaskUnderstanding, TaskInput, TaskUnderstanding } from './types.ts';
import type { UnderstandingEngine } from './understanding-engine.ts';

/** Verbs that indicate file mutations (code generation). */
const MUTATION_VERBS = new Set([
  'fix',
  'add',
  'remove',
  'update',
  'refactor',
  'rename',
  'move',
  'extract',
  'inline',
  'optimize',
  'migrate',
  'convert',
  'implement',
  'delete',
  'create',
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

  // Short goals without code-related keywords are likely conversational/analysis
  if (lower.length < 30 && !/\b(file|code|src|function|class|module|import|test)\b/i.test(lower)) {
    return 'analysis';
  }

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
  let actionCategory = classifyActionCategory(actionVerb, input.goal);

  // Reasoning tasks with no target files override mutation default → analysis
  // Prevents non-English greetings/questions from being classified as code mutations
  if (actionCategory === 'mutation' && input.taskType === 'reasoning' && !input.targetFiles?.length) {
    actionCategory = 'analysis';
  }

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
export function enrichWithPerception(understanding: TaskUnderstanding, frameworkMarkers: string[]): TaskUnderstanding {
  return {
    ...understanding,
    frameworkContext: frameworkMarkers,
  };
}

/** Dependencies for Layer 0+1 understanding enrichment. */
export interface EnrichUnderstandingDeps {
  workspace: string;
  worldGraph?: WorldGraph;
  traceStore?: TraceStore;
}

/**
 * Layer 0+1: deterministic, pre-routing. Always runs. Cost: 0 tokens.
 *
 * Composes Layer 0 (rule-based extraction) + Layer 1 (entity resolution + historical profiling)
 * into a SemanticTaskUnderstanding. This is the single entry point for the core loop.
 */
export function enrichUnderstanding(
  input: TaskInput,
  deps: EnrichUnderstandingDeps,
  opts?: { forceRefresh?: boolean },
): SemanticTaskUnderstanding {
  // Layer 0: existing rule-based extraction
  const base = buildTaskUnderstanding(input);

  // Layer 1: entity resolution (NL → code paths)
  const resolver = new EntityResolver(deps.workspace, deps.worldGraph);
  const resolvedEntities = resolver.resolve(input, base, opts);

  // Layer 1: historical profiling (recurring detection, failure oracles)
  const historicalProfile = deps.traceStore ? profileHistory(input, deps.traceStore) : undefined;

  // P8: content-addressed fingerprint for Layer 0+1
  const resolvedPaths = resolvedEntities.flatMap((e) => e.resolvedPaths).sort();
  const signature = computeTaskSignature(input);
  const understandingFingerprint = createHash('sha256')
    .update(input.goal + JSON.stringify(resolvedPaths) + signature)
    .digest('hex');

  return {
    ...base,
    resolvedEntities,
    historicalProfile,
    understandingDepth: 1,
    verifiedClaims: [],
    understandingFingerprint,
  };
}

// ── Layer 2: Semantic Understanding (LLM, budget-gated) ─────────────────

/** Dependencies for Layer 2 understanding enrichment. */
export interface EnrichUnderstandingL2Deps {
  understandingEngine: UnderstandingEngine;
  workspace: string;
}

/**
 * Layer 2: LLM-based semantic intent extraction. Post-routing, budget-gated.
 * Gracefully degrades to Layer 0+1 on any failure (parse, timeout, circuit open).
 */
export async function enrichUnderstandingL2(
  understanding: SemanticTaskUnderstanding,
  deps: EnrichUnderstandingL2Deps,
  budget: { remainingTokens: number; timeoutMs?: number },
): Promise<SemanticTaskUnderstanding> {
  const {
    LAYER2_MIN_BUDGET_TOKENS,
    LAYER2_TIMEOUT_MS,
    buildUnderstandingPrompt,
    parseSemanticIntent,
    verifyImplicitConstraints,
  } = await import('./understanding-engine.ts');

  // Budget gate
  if (budget.remainingTokens < LAYER2_MIN_BUDGET_TOKENS) return understanding;
  if (understanding.understandingDepth >= 2) return understanding;

  // Circuit breaker check
  if (deps.understandingEngine.shouldSkip()) return understanding;

  // Cache check
  const cached = deps.understandingEngine.getCached(understanding.understandingFingerprint);
  if (cached) return { ...understanding, semanticIntent: cached, understandingDepth: 2 };

  // Execute L2 with timeout
  const { systemPrompt, userPrompt } = buildUnderstandingPrompt(understanding);
  try {
    const response = await Promise.race([
      deps.understandingEngine.execute({ systemPrompt, userPrompt, maxTokens: 500 }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('L2 timeout')), budget.timeoutMs ?? LAYER2_TIMEOUT_MS),
      ),
    ]);

    const parsed = parseSemanticIntent(response.content);
    if (!parsed) {
      deps.understandingEngine.recordResult(false);
      return understanding;
    }

    // Verify implicit constraints against codebase evidence
    const { verified, claims } = verifyImplicitConstraints(parsed.implicitConstraints, deps.workspace);
    parsed.implicitConstraints = verified;

    deps.understandingEngine.recordResult(true);
    deps.understandingEngine.setCached(understanding.understandingFingerprint, parsed);

    return {
      ...understanding,
      semanticIntent: parsed,
      understandingDepth: 2,
      verifiedClaims: [...understanding.verifiedClaims, ...claims],
    };
  } catch {
    deps.understandingEngine.recordResult(false);
    return understanding; // Graceful degradation
  }
}
