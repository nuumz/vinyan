import { describe, expect, test } from 'bun:test';
import type { Fact } from '../../src/core/types.ts';
import {
  applyGoalGroundingConfidenceDowngrade,
  buildGoalGroundingClarificationQuestions,
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
});