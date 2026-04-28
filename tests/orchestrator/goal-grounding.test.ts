import { describe, expect, test } from 'bun:test';
import type { Fact } from '../../src/core/types.ts';
import {
  applyGoalGroundingConfidenceDowngrade,
  buildGoalGroundingClarificationQuestions,
  buildGoalGroundingProvenance,
  evaluateGoalGrounding,
  GOAL_GROUNDING_POLICY_VERSION,
  shouldRunGoalGrounding,
} from '../../src/orchestrator/goal-grounding.ts';
import type { ExecutionTrace, RoutingDecision, SemanticTaskUnderstanding, TaskInput } from '../../src/orchestrator/types.ts';

function makeInput(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 'task-1',
    source: 'api',
    goal: 'Fix auth token refresh',
    taskType: 'code',
    targetFiles: ['src/auth.ts'],
    budget: { maxTokens: 10_000, maxDurationMs: 60_000, maxRetries: 1 },
    ...overrides,
  };
}

function makeRouting(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    level: 2,
    model: 'mock-provider',
    budgetTokens: 10_000,
    latencyBudgetMs: 30_000,
    riskScore: 0.7,
    ...overrides,
  };
}

function makeUnderstanding(overrides: Partial<SemanticTaskUnderstanding> = {}): SemanticTaskUnderstanding {
  return {
    rawGoal: 'Fix auth token refresh',
    actionVerb: 'fix',
    actionCategory: 'mutation',
    frameworkContext: [],
    constraints: [],
    acceptanceCriteria: [],
    expectsMutation: true,
    taskDomain: 'code-mutation',
    taskIntent: 'execute',
    toolRequirement: 'tool-needed',
    resolvedEntities: [],
    understandingDepth: 1,
    verifiedClaims: [],
    understandingFingerprint: 'fingerprint-1',
    ...overrides,
  };
}

function makeFact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: 'fact-1',
    target: 'src/auth.ts',
    pattern: 'understanding-verified',
    evidence: [{ file: 'src/auth.ts', line: 1, snippet: 'token refresh' }],
    oracleName: 'understanding-verifier',
    fileHash: 'sha256:abc',
    sourceFile: 'src/auth.ts',
    verifiedAt: 100,
    confidence: 0.9,
    validUntil: 1_000,
    decayModel: 'linear',
    ...overrides,
  };
}

describe('goal grounding', () => {
  test('runs only for high-risk, high-level, or long-running tasks', () => {
    const lowRiskRouting = makeRouting({ level: 1, riskScore: 0.2 });
    const highRiskRouting = makeRouting({ level: 1, riskScore: 0.8 });
    const shortTask = makeInput({ budget: { maxTokens: 10_000, maxDurationMs: 30_000, maxRetries: 1 } });
    const longTask = makeInput({ budget: { maxTokens: 10_000, maxDurationMs: 180_000, maxRetries: 1 } });

    expect(shouldRunGoalGrounding({ input: shortTask, routing: lowRiskRouting, startedAt: Date.now() })).toBe(false);
    expect(shouldRunGoalGrounding({ input: shortTask, routing: highRiskRouting, startedAt: Date.now() })).toBe(true);
    expect(shouldRunGoalGrounding({ input: longTask, routing: lowRiskRouting, startedAt: Date.now() })).toBe(true);
    expect(shouldRunGoalGrounding({ input: shortTask, routing: lowRiskRouting, startedAt: 1_000, now: 31_001 })).toBe(
      true,
    );
  });

  test('uses supplied clock when evaluating elapsed-time grounding policy', () => {
    const check = evaluateGoalGrounding({
      input: makeInput({ budget: { maxTokens: 10_000, maxDurationMs: 30_000, maxRetries: 1 } }),
      understanding: makeUnderstanding(),
      routing: makeRouting({ level: 1, riskScore: 0.2 }),
      phase: 'generate',
      startedAt: 1_000,
      now: 31_001,
    });

    expect(check).toMatchObject({
      action: 'continue',
      phase: 'generate',
      goalDrift: false,
      freshnessDowngraded: false,
    });
  });

  test('detects root-goal drift without rewriting the current goal', () => {
    const check = evaluateGoalGrounding({
      input: makeInput({ goal: 'Refactor billing report renderer' }),
      understanding: makeUnderstanding({ rawGoal: 'Fix auth token refresh' }),
      routing: makeRouting(),
      phase: 'plan',
      startedAt: Date.now(),
      now: 500,
    });

    expect(check).toMatchObject({
      action: 'request-clarification',
      goalDrift: true,
      freshnessDowngraded: false,
      policyVersion: GOAL_GROUNDING_POLICY_VERSION,
    });
    expect(check?.rootGoalHash).not.toBe(check?.currentGoalHash);
    expect(buildGoalGroundingClarificationQuestions(check!)[0]).toContain('re-ground to the original intent');
  });

  test('rootGoal override preserves the current execution goal for drift detection', () => {
    const check = evaluateGoalGrounding({
      input: makeInput({ goal: 'Run the rewritten agentic workflow prompt' }),
      understanding: makeUnderstanding({ rawGoal: 'Run the rewritten agentic workflow prompt' }),
      routing: makeRouting(),
      phase: 'plan',
      startedAt: Date.now(),
      rootGoal: 'Fix auth token refresh',
      now: 500,
    });

    expect(check).toMatchObject({
      action: 'request-clarification',
      goalDrift: true,
      freshnessDowngraded: false,
    });
    expect(check?.rootGoalHash).not.toBe(check?.currentGoalHash);
  });

  test('builds A10-specific governance provenance for clarification traces', () => {
    const input = makeInput();
    const check = evaluateGoalGrounding({
      input: makeInput({ goal: 'Refactor billing report renderer' }),
      understanding: makeUnderstanding({ rawGoal: 'Fix auth token refresh' }),
      routing: makeRouting(),
      phase: 'plan',
      startedAt: Date.now(),
      now: 500,
    });

    const provenance = buildGoalGroundingProvenance(input, check!);

    expect(provenance).toMatchObject({
      attributedTo: 'goalGroundingPolicy',
      wasGeneratedBy: 'evaluateGoalGrounding',
      reason: 'Current execution goal diverged from the root intent',
    });
    expect(provenance.decisionId).toContain('goal-grounding-request-clarification');
    expect(provenance.wasDerivedFrom).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: input.id, kind: 'task-input' }),
        expect.objectContaining({ source: 'goal-grounding-check', kind: 'other' }),
      ]),
    );
  });

  test('downgrades confidence when temporal facts are stale or low confidence', () => {
    const worldGraph = {
      queryFacts: () => [makeFact({ id: 'fact-low', confidence: 0.2, validUntil: 2_000 })],
    };

    const check = evaluateGoalGrounding({
      input: makeInput(),
      understanding: makeUnderstanding({
        resolvedEntities: [
          {
            reference: 'auth module',
            resolvedPaths: ['src/auth.ts'],
            resolution: 'exact',
            confidence: 0.9,
            confidenceSource: 'evidence-derived',
          },
        ],
      }),
      routing: makeRouting(),
      phase: 'verify',
      startedAt: Date.now(),
      worldGraph,
      now: 500,
    });

    expect(check).toMatchObject({
      action: 'downgrade-confidence',
      goalDrift: false,
      freshnessDowngraded: true,
      factCount: 1,
      staleFactCount: 1,
      minFactConfidence: 0.2,
    });
    expect(check?.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'fact-low' })]));
  });

  test('applies temporal downgrade to trace confidence metadata', () => {
    const trace: ExecutionTrace = {
      id: 'trace-1',
      taskId: 'task-1',
      workerId: 'worker-1',
      timestamp: 1,
      routingLevel: 2,
      approach: 'test',
      oracleVerdicts: {},
      modelUsed: 'mock-provider',
      tokensConsumed: 0,
      durationMs: 10,
      outcome: 'success',
      affectedFiles: ['src/auth.ts'],
      pipelineConfidence: {
        composite: 0.82,
        formula: 'composite=weighted',
      },
      confidenceDecision: { action: 'allow', confidence: 0.82, reason: 'verified' },
    };
    const check = evaluateGoalGrounding({
      input: makeInput(),
      understanding: makeUnderstanding({
        resolvedEntities: [
          {
            reference: 'auth module',
            resolvedPaths: ['src/auth.ts'],
            resolution: 'exact',
            confidence: 0.9,
            confidenceSource: 'evidence-derived',
          },
        ],
      }),
      routing: makeRouting(),
      phase: 'verify',
      startedAt: Date.now(),
      worldGraph: { queryFacts: () => [makeFact({ id: 'fact-low', confidence: 0.2 })] },
      now: 500,
    });

    applyGoalGroundingConfidenceDowngrade(trace, [check!]);

    expect(trace.confidenceDecision).toMatchObject({
      action: 're-verify',
      confidence: 0.2,
    });
    expect(trace.confidenceDecision?.reason).toContain('A10 grounding downgrade');
    expect(trace.pipelineConfidence?.composite).toBe(0.2);
    expect(trace.pipelineConfidence?.formula).toContain('A10=min');
  });

  // A10 broader grounding (2026-04-28): token-Jaccard drift detection
  // replaces the earlier substring-only check. These tests pin behavior
  // for cases the substring-only check was too coarse to handle.
  describe('token-Jaccard drift detection', () => {
    test('does NOT flag drift when goals share most content tokens (rephrasing)', () => {
      // "fix login auth bug" vs "fix login auth issue" — 3/4 token overlap.
      // Old substring-only check: would flag drift (neither contains the other).
      // New Jaccard check: 0.6 overlap > 0.3 threshold → no drift.
      const check = evaluateGoalGrounding({
        input: makeInput({ goal: 'Fix login auth bug' }),
        understanding: makeUnderstanding({ rawGoal: 'Fix login auth issue' }),
        routing: makeRouting(),
        phase: 'plan',
        startedAt: Date.now(),
        now: 500,
      });

      expect(check?.goalDrift).toBe(false);
      expect(check?.action).not.toBe('request-clarification');
    });

    test('flags drift when content vocabulary diverges below threshold', () => {
      // "refactor billing renderer module" vs "implement payment gateway integration"
      // — 0/6 content-token overlap. Both Jaccard and substring agree → drift.
      const check = evaluateGoalGrounding({
        input: makeInput({ goal: 'Refactor billing renderer module' }),
        understanding: makeUnderstanding({ rawGoal: 'Implement payment gateway integration' }),
        routing: makeRouting(),
        phase: 'plan',
        startedAt: Date.now(),
        now: 500,
      });

      expect(check?.goalDrift).toBe(true);
      expect(check?.action).toBe('request-clarification');
    });

    test('substring containment still wins (current is a refinement of root)', () => {
      // "implement user login" ⊂ "implement user login flow with redirect"
      // → containment fast-path applies, no drift.
      const check = evaluateGoalGrounding({
        input: makeInput({ goal: 'implement user login flow with redirect' }),
        understanding: makeUnderstanding({ rawGoal: 'implement user login' }),
        routing: makeRouting(),
        phase: 'plan',
        startedAt: Date.now(),
        now: 500,
      });

      expect(check?.goalDrift).toBe(false);
    });

    test('stopwords are not counted in token overlap', () => {
      // "the auth bug" vs "an auth issue" — content tokens ["auth","bug"] vs
      // ["auth","issue"] → 1/3 = 0.33 overlap > 0.3 threshold → no drift.
      // Without stopword filtering, "the/a/an" would noisily inflate overlap.
      const check = evaluateGoalGrounding({
        input: makeInput({ goal: 'the auth bug' }),
        understanding: makeUnderstanding({ rawGoal: 'an auth issue' }),
        routing: makeRouting(),
        phase: 'plan',
        startedAt: Date.now(),
        now: 500,
      });

      expect(check?.goalDrift).toBe(false);
    });

    test('empty / whitespace-only goal does not crash and does not flag drift', () => {
      const check = evaluateGoalGrounding({
        input: makeInput({ goal: '   ' }),
        understanding: makeUnderstanding({ rawGoal: 'fix auth' }),
        routing: makeRouting(),
        phase: 'plan',
        startedAt: Date.now(),
        now: 500,
      });

      expect(check?.goalDrift).toBe(false);
    });
  });
});