import { describe, expect, test } from 'bun:test';
import { analyzeCounterfactuals, buildQualityLookup, summarizeByTaskType } from '../../src/evolution/counterfactual.ts';
import type { ExecutionTrace, RoutingLevel } from '../../src/orchestrator/types.ts';

function makeTrace(overrides?: Partial<ExecutionTrace>): ExecutionTrace {
  return {
    id: `t-${Math.random().toString(36).slice(2)}`,
    taskId: 'task-1',
    timestamp: Date.now(),
    routingLevel: 1,
    approach: 'default',
    oracleVerdicts: { type: true },
    model_used: 'gpt-4o',
    tokens_consumed: 100,
    durationMs: 500,
    outcome: 'success',
    affected_files: ['a.ts'],
    task_type_signature: 'refactor::ts',
    qualityScore: {
      composite: 0.7,
      architecturalCompliance: 0.7,
      efficiency: 0.7,
      dimensionsAvailable: 2,
      phase: 'phase0' as const,
    },
    ...overrides,
  };
}

describe('PH3.6: Counterfactual Analysis', () => {
  describe('buildQualityLookup', () => {
    test('groups by task type and routing level', () => {
      const traces = [
        makeTrace({
          task_type_signature: 'refactor::ts',
          routingLevel: 1,
          qualityScore: {
            composite: 0.6,
            architecturalCompliance: 0.6,
            efficiency: 0.6,
            dimensionsAvailable: 2,
            phase: 'phase0',
          },
        }),
        makeTrace({
          task_type_signature: 'refactor::ts',
          routingLevel: 1,
          qualityScore: {
            composite: 0.8,
            architecturalCompliance: 0.8,
            efficiency: 0.8,
            dimensionsAvailable: 2,
            phase: 'phase0',
          },
        }),
        makeTrace({
          task_type_signature: 'refactor::ts',
          routingLevel: 2,
          qualityScore: {
            composite: 0.9,
            architecturalCompliance: 0.9,
            efficiency: 0.9,
            dimensionsAvailable: 2,
            phase: 'phase0',
          },
        }),
      ];

      const lookup = buildQualityLookup(traces);
      const refactorLevels = lookup.get('refactor::ts');
      expect(refactorLevels).toBeDefined();
      expect(refactorLevels!.get(1)!.avgQuality).toBeCloseTo(0.7, 2);
      expect(refactorLevels!.get(1)!.count).toBe(2);
      expect(refactorLevels!.get(2)!.avgQuality).toBeCloseTo(0.9, 2);
    });

    test('skips traces without quality scores', () => {
      const traces = [
        makeTrace({ qualityScore: undefined }),
        makeTrace({
          qualityScore: {
            composite: 0.8,
            architecturalCompliance: 0.8,
            efficiency: 0.8,
            dimensionsAvailable: 2,
            phase: 'phase0',
          },
        }),
      ];

      const lookup = buildQualityLookup(traces);
      const levels = lookup.get('refactor::ts');
      expect(levels!.get(1)!.count).toBe(1);
    });
  });

  describe('analyzeCounterfactuals', () => {
    test('identifies traces that would benefit from routing up', () => {
      const traces: ExecutionTrace[] = [];
      // 5 traces at L1 with quality 0.5
      for (let i = 0; i < 5; i++) {
        traces.push(
          makeTrace({
            id: `l1-${i}`,
            routingLevel: 1,
            qualityScore: {
              composite: 0.5,
              architecturalCompliance: 0.5,
              efficiency: 0.5,
              dimensionsAvailable: 2,
              phase: 'phase0',
            },
          }),
        );
      }
      // 5 traces at L2 with quality 0.9
      for (let i = 0; i < 5; i++) {
        traces.push(
          makeTrace({
            id: `l2-${i}`,
            routingLevel: 2,
            qualityScore: {
              composite: 0.9,
              architecturalCompliance: 0.9,
              efficiency: 0.9,
              dimensionsAvailable: 2,
              phase: 'phase0',
            },
          }),
        );
      }

      const lookup = buildQualityLookup(traces);
      const results = analyzeCounterfactuals(traces, lookup, 3);

      // Only L1 traces should have counterfactuals (L2 is max we check against)
      expect(results.length).toBe(5);
      for (const r of results) {
        expect(r.actualLevel).toBe(1);
        expect(r.counterfactualLevel).toBe(2);
        expect(r.delta).toBeCloseTo(0.4, 2); // 0.9 - 0.5
      }
    });

    test('skips L3 traces (already max level)', () => {
      const traces = [makeTrace({ routingLevel: 3 as RoutingLevel })];
      const lookup = buildQualityLookup(traces);
      const results = analyzeCounterfactuals(traces, lookup);
      expect(results).toHaveLength(0);
    });

    test('skips when insufficient data at counterfactual level', () => {
      const traces = [
        makeTrace({ routingLevel: 1 }),
        // Only 1 trace at L2 — below minLevelDataPoints=3
        makeTrace({ routingLevel: 2 }),
      ];
      const lookup = buildQualityLookup(traces);
      const results = analyzeCounterfactuals(traces, lookup, 3);
      expect(results).toHaveLength(0);
    });
  });

  describe('summarizeByTaskType', () => {
    test("suggests 'up' rule when routing up consistently helps", () => {
      const results = Array.from({ length: 15 }, (_, i) => ({
        traceId: `t-${i}`,
        taskTypeSignature: 'refactor::ts',
        actualLevel: 1 as RoutingLevel,
        actualQuality: 0.5,
        counterfactualLevel: 2 as RoutingLevel,
        expectedQuality: 0.9,
        delta: 0.4,
      }));

      const summaries = summarizeByTaskType(results, 10, 0.15);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.direction).toBe('up');
      expect(summaries[0]!.suggestedRule).toBeDefined();
      expect(summaries[0]!.suggestedRule!.action).toBe('adjust-threshold');
    });

    test("returns 'none' when insufficient sample", () => {
      const results = Array.from({ length: 5 }, (_, i) => ({
        traceId: `t-${i}`,
        taskTypeSignature: 'refactor::ts',
        actualLevel: 1 as RoutingLevel,
        actualQuality: 0.5,
        counterfactualLevel: 2 as RoutingLevel,
        expectedQuality: 0.9,
        delta: 0.4,
      }));

      const summaries = summarizeByTaskType(results, 10);
      expect(summaries).toHaveLength(0);
    });

    test("returns 'none' when deltas are mixed", () => {
      const results = Array.from({ length: 20 }, (_, i) => ({
        traceId: `t-${i}`,
        taskTypeSignature: 'refactor::ts',
        actualLevel: 1 as RoutingLevel,
        actualQuality: 0.5,
        counterfactualLevel: 2 as RoutingLevel,
        expectedQuality: i % 2 === 0 ? 0.9 : 0.3, // alternating good/bad
        delta: i % 2 === 0 ? 0.4 : -0.2,
      }));

      const summaries = summarizeByTaskType(results, 10, 0.4);
      expect(summaries).toHaveLength(1);
      // Wilson LB of 10/20 positive deltas with threshold 0.4 — may or may not pass
      // but direction should not be "up" with such mixed results
      expect(summaries[0]!.direction).not.toBe('up');
    });
  });
});
