import { describe, expect, test } from 'bun:test';
import {
  deriveCapabilityTraceAudit,
  deriveGovernanceTraceAudit,
} from '../../../src/orchestrator/phases/phase-learn.ts';
import type { IntentResolution, RoutingDecision } from '../../../src/orchestrator/types.ts';

function makeIntentResolution(overrides: Partial<IntentResolution> = {}): IntentResolution {
  return {
    strategy: 'agentic-workflow',
    refinedGoal: 'review auth flow',
    confidence: 0.8,
    reasoning: 'test fixture',
    ...overrides,
  };
}

describe('deriveCapabilityTraceAudit', () => {
  test('records selected profile provenance, fit score, and unmet capabilities', () => {
    const audit = deriveCapabilityTraceAudit(
      makeIntentResolution({
        agentId: 'ts-coder',
        agentSelectionReason: 'capability-router override (score 0.86)',
        capabilityAnalysis: {
          taskId: 'task-1',
          required: [{ id: 'code.audit.jwt', weight: 1, source: 'llm-extract' }],
          candidates: [
            {
              agentId: 'writer',
              profileId: 'writer',
              profileSource: 'registry',
              trustTier: 'deterministic',
              fitScore: 0.1,
              matched: [],
              gap: [{ id: 'code.audit.jwt', weight: 1 }],
            },
            {
              agentId: 'ts-coder',
              profileId: 'ts-coder',
              profileSource: 'registry',
              trustTier: 'deterministic',
              fitScore: 0.86,
              matched: [{ id: 'code.audit.ts', weight: 0.5, confidence: 0.9 }],
              gap: [{ id: 'code.audit.jwt', weight: 0.5 }],
            },
          ],
          gapNormalized: 0.5,
          recommendedAction: 'proceed',
        },
      }),
    );

    expect(audit.agentSelectionReason).toBe('capability-router override (score 0.86)');
    expect(audit.selectedCapabilityProfileId).toBe('ts-coder');
    expect(audit.selectedCapabilityProfileSource).toBe('registry');
    expect(audit.selectedCapabilityProfileTrustTier).toBe('deterministic');
    expect(audit.capabilityFitScore).toBe(0.86);
    expect(audit.unmetCapabilityIds).toEqual(['code.audit.jwt']);
  });

  test('marks synthesized task-scoped agents as probabilistic synthetic profiles', () => {
    const audit = deriveCapabilityTraceAudit(
      makeIntentResolution({
        agentId: 'synthetic-task-1',
        syntheticAgentId: 'synthetic-task-1',
        agentSelectionReason: 'synthesized task-scoped agent',
        capabilityAnalysis: {
          taskId: 'task-1',
          required: [{ id: 'code.audit.jwt', weight: 1, source: 'llm-extract' }],
          candidates: [
            {
              agentId: 'ts-coder',
              profileId: 'ts-coder',
              profileSource: 'registry',
              trustTier: 'deterministic',
              fitScore: 0.2,
              matched: [],
              gap: [{ id: 'code.audit.jwt', weight: 1 }],
            },
          ],
          gapNormalized: 1,
          recommendedAction: 'synthesize',
        },
      }),
    );

    expect(audit.selectedCapabilityProfileId).toBe('synthetic-task-1');
    expect(audit.selectedCapabilityProfileSource).toBe('synthetic');
    expect(audit.selectedCapabilityProfileTrustTier).toBe('probabilistic');
    expect(audit.capabilityFitScore).toBe(0.2);
    expect(audit.unmetCapabilityIds).toEqual(['code.audit.jwt']);
  });
});

describe('deriveGovernanceTraceAudit', () => {
  test('copies routing governance provenance onto the trace audit payload', () => {
    const routing: RoutingDecision = {
      level: 2,
      model: 'claude-sonnet',
      budgetTokens: 50_000,
      latencyBudgetMs: 90_000,
      governanceProvenance: {
        decisionId: 'risk-router:t-1:L2',
        policyVersion: 'risk-router:v1',
        attributedTo: 'riskRouter',
        wasGeneratedBy: 'RiskRouterImpl.assessInitialLevel',
        wasDerivedFrom: [{ kind: 'routing-factor', source: 'risk-score', summary: 'riskScore=0.420' }],
        decidedAt: 1_777_400_001_000,
      },
    };

    expect(deriveGovernanceTraceAudit(routing)).toEqual({ governanceProvenance: routing.governanceProvenance });
  });

  test('returns an empty audit payload when routing has no provenance', () => {
    const routing: RoutingDecision = {
      level: 1,
      model: 'claude-haiku',
      budgetTokens: 10_000,
      latencyBudgetMs: 15_000,
    };

    expect(deriveGovernanceTraceAudit(routing)).toEqual({});
  });
});
