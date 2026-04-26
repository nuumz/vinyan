/**
 * Routing Explainer tests — behavior-level assertions against the pure
 * explainer. Uses fake OracleVerdicts + RiskFactors rather than mocking
 * risk-router internals (A3: the explainer is deterministic over inputs).
 */

import { describe, expect, test } from 'bun:test';
import type { OracleVerdict } from '../../src/core/types.ts';
import { explainRouting } from '../../src/gate/routing-explainer.ts';
import type { RiskFactors, RoutingDecision } from '../../src/orchestrator/types.ts';

function makeFactors(overrides: Partial<RiskFactors> = {}): RiskFactors {
  return {
    blastRadius: 10,
    dependencyDepth: 3,
    testCoverage: 0.8,
    fileVolatility: 5,
    irreversibility: 0.0,
    hasSecurityImplication: false,
    environmentType: 'development',
    ...overrides,
  };
}

function makeDecision(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    level: 1,
    model: 'claude-haiku',
    budgetTokens: 10_000,
    latencyBudgetMs: 15_000,
    ...overrides,
  };
}

function makeVerdict(overrides: Partial<OracleVerdict> = {}): OracleVerdict {
  return {
    verified: true,
    type: 'known',
    confidence: 1.0,
    evidence: [],
    fileHashes: {},
    durationMs: 1,
    ...overrides,
  };
}

describe('explainRouting', () => {
  test('L2 with blast-radius factor surfaces cross-module label in the summary', () => {
    const result = explainRouting({
      taskId: 'task-1',
      decision: makeDecision({ level: 2 }),
      factors: makeFactors({ blastRadius: 25, dependencyDepth: 6 }),
    });
    expect(result.level).toBe(2);
    expect(result.summary).toContain('cross-module blast radius');
    expect(result.summary).toContain('L2');
    expect(result.summary).toContain('Oracles planned');
  });

  test('confidenceSource is "unknown" when any verdict is type=unknown (A2)', () => {
    const result = explainRouting({
      taskId: 'task-2',
      decision: makeDecision({ level: 2 }),
      factors: makeFactors(),
      verdicts: [
        makeVerdict({ oracleName: 'ast', type: 'known', confidence: 1.0 }),
        makeVerdict({ oracleName: 'test', type: 'unknown', confidence: 0.0 }),
      ],
    });
    expect(result.confidenceSource).toBe('unknown');
    expect(result.summary).toContain('Confidence: unknown');
  });

  test('confidenceSource picks the weakest tier represented (A5 weakest-link)', () => {
    const result = explainRouting({
      taskId: 'task-3',
      decision: makeDecision({ level: 2 }),
      factors: makeFactors(),
      verdicts: [
        makeVerdict({ oracleName: 'ast', confidence: 1.0 }), // deterministic
        makeVerdict({ oracleName: 'heur', confidence: 0.85 }), // heuristic
        makeVerdict({ oracleName: 'prob', confidence: 0.6 }), // probabilistic
      ],
    });
    expect(result.confidenceSource).toBe('probabilistic');
  });

  test('zero-factor input produces a well-formed summary', () => {
    const result = explainRouting({
      taskId: 'task-4',
      decision: makeDecision({ level: 0 }),
      factors: makeFactors({
        blastRadius: 0,
        dependencyDepth: 0,
        testCoverage: 1.0,
        fileVolatility: 0,
        irreversibility: 0,
      }),
    });
    expect(result.factors.length).toBe(0);
    expect(result.summary).toMatch(/Task routed to L0/);
    expect(result.summary).toContain('no significant risk factors detected');
  });

  test('factors are ranked by weightedContribution descending (top 3 in summary)', () => {
    const result = explainRouting({
      taskId: 'task-5',
      decision: makeDecision({ level: 3 }),
      factors: makeFactors({
        blastRadius: 50,
        dependencyDepth: 10,
        testCoverage: 0.0,
        fileVolatility: 30,
        irreversibility: 1.0,
        hasSecurityImplication: true,
        environmentType: 'production',
      }),
    });
    const contributions = result.factors.map((f) => f.weightedContribution);
    const sorted = [...contributions].sort((a, b) => b - a);
    expect(contributions).toEqual(sorted);
    // Top-weighted factor should be irreversibility (0.2) or blast radius (0.25).
    const top = result.factors[0]?.label ?? '';
    expect(['cross-module blast radius', 'irreversible operation']).toContain(top);
  });

  test('explainRouting is deterministic across repeated calls (A3)', () => {
    const input = {
      taskId: 'task-6',
      decision: makeDecision({ level: 2 }),
      factors: makeFactors({ blastRadius: 25, irreversibility: 0.7 }),
      verdicts: [
        makeVerdict({ oracleName: 'ast', confidence: 0.9 }),
        makeVerdict({ oracleName: 'type', confidence: 0.6 }),
      ],
    };
    const a = explainRouting(input);
    const b = explainRouting(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('oraclesPlanned varies with routing level (L0 empty, L1 structural, L2 adds tests)', () => {
    const l0 = explainRouting({
      taskId: 'tx-l0',
      decision: makeDecision({ level: 0 }),
      factors: makeFactors(),
    });
    const l1 = explainRouting({
      taskId: 'tx-l1',
      decision: makeDecision({ level: 1 }),
      factors: makeFactors(),
    });
    const l2 = explainRouting({
      taskId: 'tx-l2',
      decision: makeDecision({ level: 2 }),
      factors: makeFactors(),
    });
    expect(l0.oraclesPlanned).toEqual([]);
    expect(l1.oraclesPlanned).toContain('AST');
    expect(l1.oraclesPlanned).not.toContain('Test');
    expect(l2.oraclesPlanned).toContain('Test');
  });

  test('mandatoryOracles from decision are merged into oraclesPlanned', () => {
    const result = explainRouting({
      taskId: 'tx',
      decision: makeDecision({ level: 1, mandatoryOracles: ['SecurityScan'] }),
      factors: makeFactors(),
    });
    expect(result.oraclesPlanned).toContain('SecurityScan');
  });

  test('oraclesActual is populated when verdicts supplied', () => {
    const result = explainRouting({
      taskId: 'tx',
      decision: makeDecision({ level: 2 }),
      factors: makeFactors(),
      verdicts: [makeVerdict({ oracleName: 'ast', type: 'known', confidence: 0.9 })],
    });
    expect(result.oraclesActual).toBeDefined();
    expect(result.oraclesActual?.[0]?.name).toBe('ast');
    expect(result.oraclesActual?.[0]?.verdict).toBe('verified');
  });

  test('verdict type=known + verified=false maps to "falsified"', () => {
    const result = explainRouting({
      taskId: 'tx',
      decision: makeDecision({ level: 2 }),
      factors: makeFactors(),
      verdicts: [makeVerdict({ verified: false, type: 'known', confidence: 0.95 })],
    });
    expect(result.oraclesActual?.[0]?.verdict).toBe('falsified');
  });

  test('deescalationReason populated when epistemicDeescalated flag set on decision', () => {
    const result = explainRouting({
      taskId: 'tx',
      decision: makeDecision({ level: 1, epistemicDeescalated: true }),
      factors: makeFactors(),
    });
    expect(result.deescalationReason).toBeDefined();
    expect(result.deescalationReason).toContain('calibrated');
  });

  test('no verdicts → confidenceSource is "unknown" (A2: no silent tier default)', () => {
    const result = explainRouting({
      taskId: 'tx',
      decision: makeDecision({ level: 1 }),
      factors: makeFactors(),
    });
    expect(result.confidenceSource).toBe('unknown');
  });
});
