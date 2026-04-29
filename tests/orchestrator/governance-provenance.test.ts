import { describe, expect, test } from 'bun:test';
import {
  applyRoutingGovernance,
  buildShortCircuitProvenance,
  deriveGovernanceTraceAudit,
  ORCHESTRATOR_GOVERNANCE_POLICY_VERSION,
} from '../../src/orchestrator/governance-provenance.ts';
import type { ExecutionTrace, RoutingDecision, TaskInput } from '../../src/orchestrator/types.ts';

function makeInput(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 'task-1',
    source: 'cli',
    goal: 'open calendar',
    taskType: 'reasoning',
    budget: { maxTokens: 10_000, maxDurationMs: 60_000, maxRetries: 1 },
    ...overrides,
  };
}

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: 'trace-1',
    taskId: 'task-1',
    timestamp: 1,
    routingLevel: 1,
    approach: 'fixture',
    oracleVerdicts: {},
    modelUsed: 'claude-haiku',
    tokensConsumed: 0,
    durationMs: 0,
    outcome: 'success',
    affectedFiles: [],
    ...overrides,
  };
}

describe('governance provenance helpers', () => {
  test('applyRoutingGovernance copies routing provenance onto traces that bypass learn phase', () => {
    const governanceProvenance = buildShortCircuitProvenance({
      input: makeInput(),
      decisionId: 'fixture-route',
      attributedTo: 'riskRouter',
      wasGeneratedBy: 'RiskRouterImpl.assessInitialLevel',
      reason: 'riskScore=0.300 -> L1',
    });
    const routing: RoutingDecision = {
      level: 1,
      model: 'claude-haiku',
      budgetTokens: 10_000,
      latencyBudgetMs: 15_000,
      governanceProvenance,
    };

    const trace = applyRoutingGovernance(makeTrace(), routing);

    expect(trace.governanceProvenance).toBe(governanceProvenance);
    expect(deriveGovernanceTraceAudit(routing)).toEqual({ governanceProvenance });
  });

  test('applyRoutingGovernance preserves legacy traces when routing has no provenance', () => {
    const trace = makeTrace();
    const routing: RoutingDecision = {
      level: 0,
      model: null,
      budgetTokens: 0,
      latencyBudgetMs: 100,
    };

    expect(applyRoutingGovernance(trace, routing)).toBe(trace);
    expect(deriveGovernanceTraceAudit(routing)).toEqual({});
  });

  test('buildShortCircuitProvenance creates replayable intent-level provenance', () => {
    const input = makeInput({ taskType: 'reasoning', source: 'api' });
    const provenance = buildShortCircuitProvenance({
      input,
      decisionId: 'direct-tool-shortcircuit',
      attributedTo: 'intentResolver',
      wasGeneratedBy: 'executeDirectToolCall',
      reason: 'Intent resolver selected direct tool execution',
      evidence: [
        {
          kind: 'tool-result',
          source: 'shell_exec',
          summary: 'status=success',
        },
      ],
    });

    expect(provenance.decisionId).toBe('intentResolver:task-1:direct-tool-shortcircuit');
    expect(provenance.policyVersion).toBe(ORCHESTRATOR_GOVERNANCE_POLICY_VERSION);
    expect(provenance.attributedTo).toBe('intentResolver');
    expect(provenance.wasGeneratedBy).toBe('executeDirectToolCall');
    expect(provenance.reason).toBe('Intent resolver selected direct tool execution');
    expect(provenance.wasDerivedFrom).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'task-input', source: 'task-1' }),
        expect.objectContaining({ kind: 'tool-result', source: 'shell_exec', summary: 'status=success' }),
      ]),
    );
  });
});
