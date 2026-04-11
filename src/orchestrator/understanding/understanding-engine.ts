/**
 * Understanding Engine — Layer 2 semantic intent extraction via LLM.
 *
 * Budget-gated, circuit-breaker-protected. Post-routing only (cannot influence governance).
 * All confidence metadata hardcoded post-parse (A3 enforcement).
 *
 * Source of truth: docs/design/semantic-task-understanding-system-design.md §5.3
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OracleCircuitBreaker } from '../../oracle/circuit-breaker.ts';
import type {
  LLMProvider,
  PrimaryAction,
  REEngineType,
  RERequest,
  REResponse,
  ReasoningEngine,
  SemanticIntent,
  SemanticTaskUnderstanding,
  VerifiedClaim,
} from '../types.ts';
import { PRIMARY_ACTION_VOCAB } from '../types.ts';

// ── Constants ───────────────────────────────────────────────────────────

export const LAYER2_MIN_BUDGET_TOKENS = 2000;
export const LAYER2_TIMEOUT_MS = 2000;

const CIRCUIT_BREAKER_KEY = 'understanding-engine';
const MAX_CONTEXT_TOKENS = 4_000;
const MAX_OUTPUT_TOKENS = 500;

// ── Levenshtein distance (inline, no external dep) ──────────────────────

/** Standard DP Levenshtein — edit distance between two strings. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= b.length; j++) {
    matrix[0]![j] = j;
  }
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1,       // deletion
        matrix[i]![j - 1]! + 1,       // insertion
        matrix[i - 1]![j - 1]! + cost, // substitution
      );
    }
  }
  return matrix[a.length]![b.length]!;
}

// ── Canonicalization ────────────────────────────────────────────────────

/**
 * Normalize LLM free-text to a PRIMARY_ACTION_VOCAB entry.
 * Prevents signature fragmentation: "performance optimization", "perf-optimization",
 * "optimize-performance" all map to "performance-optimization".
 */
export function canonicalizePrimaryAction(raw: string): PrimaryAction {
  const normalized = raw.toLowerCase().replace(/[\s_]+/g, '-');
  if (PRIMARY_ACTION_VOCAB.includes(normalized as PrimaryAction)) return normalized as PrimaryAction;

  // Fuzzy fallback: Levenshtein ≤ 3 to closest vocab entry
  let bestVocab: PrimaryAction = 'other';
  let bestDist = 4; // Only accept distance ≤ 3
  for (const v of PRIMARY_ACTION_VOCAB) {
    const d = levenshtein(normalized, v);
    if (d < bestDist) {
      bestDist = d;
      bestVocab = v;
    }
  }
  return bestVocab;
}

// ── Parse ───────────────────────────────────────────────────────────────

/**
 * Parse LLM output into SemanticIntent. Returns null on any failure.
 * Hardcodes confidenceSource and tierReliability post-parse (A3/A5).
 */
export function parseSemanticIntent(raw: string): SemanticIntent | null {
  try {
    // Strip markdown fences if present
    const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```\s*$/m, '').trim();
    const parsed = JSON.parse(cleaned);

    // Validate required fields
    if (typeof parsed.primaryAction !== 'string' || typeof parsed.scope !== 'string') {
      return null;
    }

    // Normalize implicitConstraints to polarity format
    const implicitConstraints: SemanticIntent['implicitConstraints'] = Array.isArray(parsed.implicitConstraints)
      ? parsed.implicitConstraints
          .filter((c: unknown) => c && typeof c === 'object' && 'text' in c)
          .map((c: { text: string; polarity?: string }) => ({
            text: String(c.text),
            polarity: c.polarity === 'must-not' ? ('must-not' as const) : ('must' as const),
          }))
      : [];

    // Normalize ambiguities
    const ambiguities: SemanticIntent['ambiguities'] = Array.isArray(parsed.ambiguities)
      ? parsed.ambiguities
          .filter((a: unknown) => a && typeof a === 'object' && 'aspect' in a)
          .map((a: { aspect: string; interpretations?: string[]; selectedInterpretation?: string; confidence?: number }) => ({
            aspect: String(a.aspect),
            interpretations: Array.isArray(a.interpretations) ? a.interpretations.map(String) : [],
            selectedInterpretation: a.selectedInterpretation ? String(a.selectedInterpretation) : undefined,
            confidence: typeof a.confidence === 'number' ? a.confidence : 0.5,
          }))
      : [];

    // Parse new optional fields — graceful degradation: undefined if missing/invalid
    const goalSummary = typeof parsed.goalSummary === 'string' ? parsed.goalSummary : undefined;
    const steps = Array.isArray(parsed.steps)
      ? parsed.steps.filter((s: unknown) => typeof s === 'string').map(String)
      : undefined;
    const successCriteria = Array.isArray(parsed.successCriteria)
      ? parsed.successCriteria.filter((s: unknown) => typeof s === 'string').map(String)
      : undefined;
    const affectedComponents = Array.isArray(parsed.affectedComponents)
      ? parsed.affectedComponents.filter((s: unknown) => typeof s === 'string').map(String)
      : undefined;
    const rootCause = typeof parsed.rootCause === 'string' ? parsed.rootCause : undefined;

    return {
      primaryAction: canonicalizePrimaryAction(parsed.primaryAction),
      secondaryActions: Array.isArray(parsed.secondaryActions) ? parsed.secondaryActions.map(String) : [],
      scope: String(parsed.scope),
      implicitConstraints,
      ambiguities,
      ...(goalSummary ? { goalSummary } : {}),
      ...(steps?.length ? { steps } : {}),
      ...(successCriteria?.length ? { successCriteria } : {}),
      ...(affectedComponents?.length ? { affectedComponents } : {}),
      ...(rootCause ? { rootCause } : {}),
      // A3 enforcement: hardcoded, never from LLM output
      confidenceSource: 'llm-self-report',
      tierReliability: 0.4,
    };
  } catch {
    return null;
  }
}

// ── Implicit constraint verification ────────────────────────────────────

interface VerifiedConstraintResult {
  verified: SemanticIntent['implicitConstraints'];
  claims: VerifiedClaim[];
}

/**
 * Cross-check implicit constraints against package.json dependencies.
 * Strips unverifiable "use X" constraints where X is not a project dependency.
 */
export function verifyImplicitConstraints(
  constraints: SemanticIntent['implicitConstraints'],
  workspace: string,
): VerifiedConstraintResult {
  const claims: VerifiedConstraintResult['claims'] = [];

  let packageJson: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null = null;
  try {
    packageJson = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf-8'));
  } catch {
    // No package.json — skip verification, keep all constraints
    return { verified: constraints, claims };
  }

  const verified = constraints.filter((c) => {
    const useMatch = c.text.match(/\buse\s+(\w+)/i);
    if (!useMatch) return true; // Not a "use X" constraint — keep

    const dep = useMatch[1]!.toLowerCase();
    const inDeps = packageJson!.dependencies?.[dep] || packageJson!.devDependencies?.[dep];
    if (!inDeps) {
      claims.push({
        claim: c.text,
        type: 'contradictory',
        confidence: 0.95,
        verifiedBy: 'package.json',
        confidenceSource: 'evidence-derived',
        tierReliability: 1.0,
        falsifiableBy: ['dependency-added'],
        evidence: [{ file: 'package.json', snippet: `missing dependency: ${dep}` }],
      });
      return false; // Strip unverifiable dependency constraint
    }
    return true;
  });

  return { verified, claims };
}

// ── Prompt building ─────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a task understanding engine for an autonomous code orchestrator.
Given a task goal and codebase context, extract structured understanding.
Output ONLY valid JSON — no explanation, no markdown fences.

Your extraction must be:
- Actionable: steps should be concrete enough to guide implementation
- Grounded: only reference files/modules mentioned in the context or clearly implied
- Conservative: when uncertain about scope, prefer the narrower interpretation
- Falsifiable: success criteria should be observable and testable

Schema:
{
  "primaryAction": "one of: ${PRIMARY_ACTION_VOCAB.join(' | ')}",
  "secondaryActions": ["string — implied follow-up actions"],
  "scope": "string — natural-language scope description",
  "implicitConstraints": [{"text": "string — constraint", "polarity": "must | must-not"}],
  "ambiguities": [{"aspect": "string", "interpretations": ["string"], "confidence": 0.0-1.0}],
  "goalSummary": "string — concise 1-2 sentence restatement of the actual goal (required)",
  "steps": ["string — concrete action steps to achieve the goal (required, 2-6 steps)"],
  "successCriteria": ["string — observable criteria for verifying completion (required, 1-3 criteria)"],
  "affectedComponents": ["string — modules/files/services likely affected"],
  "rootCause": "string — hypothesized root cause (for bug-fix/investigation, omit otherwise)"
}`;

// Static few-shot examples (~200 tokens each)
const FEW_SHOT_EXAMPLES = [
  {
    goal: 'Fix the authentication timeout bug in the login service',
    response: JSON.stringify({
      primaryAction: 'bug-fix',
      secondaryActions: ['add-timeout-handling'],
      scope: 'Authentication/login service timeout logic',
      goalSummary: 'Fix the timeout bug in the login service that causes authentication failures.',
      steps: ['Identify the timeout handling code in the login service', 'Fix the timeout logic to handle slow responses gracefully'],
      successCriteria: ['Authentication succeeds even with slow network responses', 'Existing auth tests pass'],
      affectedComponents: ['src/services/auth', 'src/routes/login'],
      rootCause: 'Login service does not handle slow network responses, causing premature timeout.',
      implicitConstraints: [
        { text: 'preserve existing auth flow', polarity: 'must' },
        { text: 'break session management', polarity: 'must-not' },
      ],
      ambiguities: [],
    }),
  },
  {
    goal: 'Refactor the payment module to use the new Stripe API v3',
    response: JSON.stringify({
      primaryAction: 'api-migration',
      secondaryActions: ['update-types', 'update-tests'],
      scope: 'Payment module Stripe integration',
      goalSummary: 'Migrate the payment module from Stripe API v2 to v3.',
      steps: ['Update Stripe SDK dependency to v3', 'Refactor payment module API calls', 'Update TypeScript types for new response shapes', 'Update integration tests'],
      successCriteria: ['All payment flows work with Stripe API v3', 'No v2 API calls remain'],
      affectedComponents: ['src/payment', 'src/types/stripe'],
      implicitConstraints: [{ text: 'use stripe', polarity: 'must' }],
      ambiguities: [
        {
          aspect: 'Migration strategy',
          interpretations: ['incremental (dual-write)', 'big-bang replacement'],
          confidence: 0.6,
        },
      ],
    }),
  },
  {
    goal: 'The user registration flow fails intermittently with a 500 error. The error seems related to the database connection pool exhaustion during peak load. We need to fix the connection leak, add proper connection pooling configuration, update the health check endpoint to monitor pool status, and add integration tests for concurrent registration.',
    response: JSON.stringify({
      primaryAction: 'bug-fix',
      secondaryActions: ['configuration', 'add-feature', 'test-improvement'],
      scope: 'User registration database connection management',
      goalSummary: 'Fix intermittent 500 errors in user registration caused by database connection pool exhaustion during peak load.',
      steps: [
        'Identify and fix the connection leak in the registration handler',
        'Configure proper connection pooling limits',
        'Add pool status monitoring to health check endpoint',
        'Write integration tests for concurrent registration scenarios',
      ],
      successCriteria: [
        'No 500 errors under simulated peak load',
        'Health check endpoint reports pool status',
        'Integration tests pass for concurrent registration',
      ],
      affectedComponents: ['src/routes/registration', 'src/db/pool', 'src/health'],
      rootCause: 'Database connections not returned to pool after registration handler errors, causing pool exhaustion under load.',
      implicitConstraints: [
        { text: 'preserve existing registration API contract', polarity: 'must' },
        { text: 'introduce breaking changes to health check response format', polarity: 'must-not' },
      ],
      ambiguities: [],
    }),
  },
];

/**
 * Build the structured prompt for Layer 2 understanding.
 * Drops few-shot examples if they would exceed context budget.
 */
export function buildUnderstandingPrompt(understanding: SemanticTaskUnderstanding): {
  systemPrompt: string;
  userPrompt: string;
} {
  const entities = understanding.resolvedEntities
    .map((e) => `${e.reference} → ${e.resolvedPaths.join(', ')} (${e.resolution})`)
    .join('\n  ');

  const profile = understanding.historicalProfile;
  const profileStr = profile
    ? `observations=${profile.observationCount}, failRate=${(profile.failRate * 100).toFixed(0)}%, recurring=${profile.isRecurring}`
    : 'none';

  const failures = profile?.commonFailureOracles?.join(', ') || 'none';

  const contextLines = [
    `Goal: "${understanding.rawGoal}"`,
    `Target files: ${understanding.resolvedEntities.filter((e) => e.resolution === 'exact').flatMap((e) => e.resolvedPaths).join(', ') || 'none'}`,
    `Frameworks: ${understanding.frameworkContext.join(', ') || 'none'}`,
    `Action verb (rule-based): ${understanding.actionVerb}`,
    `Category (rule-based): ${understanding.actionCategory}`,
    `Resolved entities:\n  ${entities || 'none'}`,
    `Historical profile: ${profileStr}`,
    `Recent failures: ${failures}`,
  ];

  const userContext = contextLines.join('\n');

  // Budget check: estimate tokens (~4 chars per token)
  const systemTokenEst = Math.ceil(SYSTEM_PROMPT.length / 4);
  const contextTokenEst = Math.ceil(userContext.length / 4);
  const remainingForExamples = MAX_CONTEXT_TOKENS - MAX_OUTPUT_TOKENS - systemTokenEst - contextTokenEst;

  let userPrompt = userContext;

  // Add few-shot examples if budget allows
  if (remainingForExamples > 200) {
    const exampleLines: string[] = ['\nExamples:'];
    for (const ex of FEW_SHOT_EXAMPLES) {
      const exStr = `\nGoal: "${ex.goal}"\nOutput: ${ex.response}`;
      const exTokens = Math.ceil(exStr.length / 4);
      if (exTokens <= remainingForExamples) {
        exampleLines.push(exStr);
      }
    }
    if (exampleLines.length > 1) {
      userPrompt = exampleLines.join('') + '\n\n' + userContext;
    }
  }

  return { systemPrompt: SYSTEM_PROMPT, userPrompt };
}

// ── UnderstandingEngine class ───────────────────────────────────────────

/**
 * Layer 2 Understanding Engine — wraps LLMProvider with circuit breaker + caching.
 * Implements ReasoningEngine for registry compatibility.
 */
export class UnderstandingEngine implements ReasoningEngine {
  id = 'vinyan-understanding-engine';
  engineType: REEngineType = 'llm';
  capabilities = ['task-understanding', 'intent-extraction'];
  tier: 'fast' = 'fast';
  maxContextTokens = MAX_CONTEXT_TOKENS;

  private circuitBreaker = new OracleCircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 60_000 });
  private cache = new Map<string, SemanticIntent>();

  constructor(private provider: LLMProvider) {}

  async execute(request: RERequest): Promise<REResponse> {
    const res = await this.provider.generate({
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
      maxTokens: request.maxTokens,
      temperature: 0.1,
    });
    return {
      content: res.content,
      toolCalls: res.toolCalls,
      tokensUsed: res.tokensUsed,
      engineId: this.id,
      terminationReason: res.stopReason === 'tool_use' ? 'tool_use'
        : res.stopReason === 'max_tokens' ? 'limit_reached' : 'completed',
      thinking: res.thinking,
    };
  }

  /** Check if circuit is open (should skip L2). */
  shouldSkip(): boolean {
    return this.circuitBreaker.shouldSkip(CIRCUIT_BREAKER_KEY);
  }

  /** Record success/failure for circuit breaker state. */
  recordResult(success: boolean): void {
    if (success) this.circuitBreaker.recordSuccess(CIRCUIT_BREAKER_KEY);
    else this.circuitBreaker.recordFailure(CIRCUIT_BREAKER_KEY);
  }

  /** Get cached intent by fingerprint. */
  getCached(fingerprint: string): SemanticIntent | undefined {
    return this.cache.get(fingerprint);
  }

  /** Store intent in per-task cache. */
  setCached(fingerprint: string, intent: SemanticIntent): void {
    this.cache.set(fingerprint, intent);
  }
}
