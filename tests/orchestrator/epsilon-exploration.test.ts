import { describe, expect, test } from 'bun:test';
import { computeQualityImpact } from '../../src/evolution/backtester.ts';
import type { EvolutionaryRule, ExecutionTrace } from '../../src/orchestrator/types.ts';

function makeTrace(overrides?: Partial<ExecutionTrace>): ExecutionTrace {
  return {
    id: `t-${Math.random().toString(36).slice(2)}`,
    taskId: 'task-1',
    timestamp: Date.now(),
    routingLevel: 1,
    approach: 'default',
    oracleVerdicts: { type: true },
    modelUsed: 'gpt-4o',
    tokensConsumed: 100,
    durationMs: 500,
    outcome: 'success',
    affectedFiles: ['auth.ts'],
    ...overrides,
  };
}

function makeRule(overrides?: Partial<EvolutionaryRule>): EvolutionaryRule {
  return {
    id: 'rule-1',
    source: 'sleep-cycle',
    condition: { filePattern: 'auth.ts' },
    action: 'escalate',
    parameters: { toLevel: 2 },
    status: 'probation',
    createdAt: Date.now(),
    effectiveness: 0,
    specificity: 1,
    ...overrides,
  };
}

describe('PH3.6: Epsilon Exploration & Quality Impact', () => {
  describe('exploration flag on ExecutionTrace', () => {
    test('exploration field is optional and defaults to undefined', () => {
      const trace = makeTrace();
      expect(trace.exploration).toBeUndefined();
    });

    test('exploration field can be set to true', () => {
      const trace = makeTrace({ exploration: true });
      expect(trace.exploration).toBe(true);
    });
  });

  describe('computeQualityImpact', () => {
    test('positive impact when rule targets tasks that improve at higher level', () => {
      const rule = makeRule({ parameters: { toLevel: 2 } });

      const traces = [
        // Matching traces at L1 with low quality
        makeTrace({
          routingLevel: 1,
          qualityScore: {
            composite: 0.4,
            architecturalCompliance: 0.4,
            efficiency: 0.4,
            dimensionsAvailable: 2,
            phase: 'basic',
          },
        }),
        makeTrace({
          routingLevel: 1,
          qualityScore: {
            composite: 0.5,
            architecturalCompliance: 0.5,
            efficiency: 0.5,
            dimensionsAvailable: 2,
            phase: 'basic',
          },
        }),
        // Non-matching traces at L2 with high quality (proxy for "after")
        makeTrace({
          routingLevel: 2,
          affectedFiles: ['other.ts'],
          qualityScore: {
            composite: 0.9,
            architecturalCompliance: 0.9,
            efficiency: 0.9,
            dimensionsAvailable: 2,
            phase: 'basic',
          },
        }),
        makeTrace({
          routingLevel: 2,
          affectedFiles: ['other.ts'],
          qualityScore: {
            composite: 0.85,
            architecturalCompliance: 0.85,
            efficiency: 0.85,
            dimensionsAvailable: 2,
            phase: 'basic',
          },
        }),
      ];

      const result = computeQualityImpact(rule, traces);
      expect(result.avgQualityBefore).toBeCloseTo(0.45, 2);
      expect(result.estimatedQualityAfter).toBeCloseTo(0.875, 2);
      expect(result.impact).toBeGreaterThan(0);
    });

    test('returns zero impact when no matching traces', () => {
      const rule = makeRule({ condition: { filePattern: 'nonexistent.ts' } });
      const traces = [makeTrace()];

      const result = computeQualityImpact(rule, traces);
      expect(result.impact).toBe(0);
    });

    test('uses matching avg as fallback when no target level data', () => {
      const rule = makeRule({ parameters: { toLevel: 3 } });
      const traces = [
        makeTrace({
          qualityScore: {
            composite: 0.6,
            architecturalCompliance: 0.6,
            efficiency: 0.6,
            dimensionsAvailable: 2,
            phase: 'basic',
          },
        }),
      ];

      const result = computeQualityImpact(rule, traces);
      // No L3 traces → estimatedAfter = avgBefore
      expect(result.estimatedQualityAfter).toBeCloseTo(0.6, 2);
      expect(result.impact).toBeCloseTo(0, 2);
    });

    test('handles traces without quality scores', () => {
      const rule = makeRule();
      const traces = [makeTrace({ qualityScore: undefined }), makeTrace({ qualityScore: undefined })];

      const result = computeQualityImpact(rule, traces);
      expect(result.impact).toBe(0);
    });
  });
});
