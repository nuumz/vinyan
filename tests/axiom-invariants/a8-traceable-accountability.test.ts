/**
 * A8 — Traceable Accountability invariant (proposed).
 *
 * Every governance decision carries: decisionId, attributedTo,
 * wasGeneratedBy, decidedAt, evidenceObservedAt, reason, and structured
 * `wasDerivedFrom` evidence. Replayable from the trace alone.
 */
import { describe, expect, test } from 'bun:test';
import { buildShortCircuitProvenance } from '../../src/orchestrator/governance-provenance.ts';
import type { TaskInput } from '../../src/orchestrator/types.ts';

const taskInput: TaskInput = {
  id: 'task-a8',
  source: 'cli',
  goal: 'test',
  taskType: 'reasoning',
  budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 0 },
};

describe('A8 — Traceable Accountability', () => {
  test('buildShortCircuitProvenance populates required fields', () => {
    const prov = buildShortCircuitProvenance({
      input: taskInput,
      decisionId: 'demo-decision',
      attributedTo: 'intentResolver',
      wasGeneratedBy: 'test',
      reason: 'unit-test',
      evidence: [
        { kind: 'routing-factor', source: 'intent-strategy', summary: 'demo' },
      ],
    });
    expect(prov.decisionId).toContain('demo-decision');
    expect(prov.attributedTo).toBe('intentResolver');
    expect(prov.wasGeneratedBy).toBe('test');
    expect(prov.decidedAt).toBeGreaterThan(0);
    expect(prov.evidenceObservedAt).toBeGreaterThan(0);
    expect(prov.reason).toBe('unit-test');
    expect(prov.policyVersion).toBeDefined();
  });

  test('decisionId namespaces by attributedTo + task id', () => {
    const prov = buildShortCircuitProvenance({
      input: taskInput,
      decisionId: 'short-circuit-A',
      attributedTo: 'orchestrator',
      wasGeneratedBy: 'test',
      reason: 'r',
    });
    expect(prov.decisionId).toContain('orchestrator');
    expect(prov.decisionId).toContain('task-a8');
    expect(prov.decisionId).toContain('short-circuit-A');
  });

  test('wasDerivedFrom always includes the task-input reference', () => {
    const prov = buildShortCircuitProvenance({
      input: taskInput,
      decisionId: 'd',
      attributedTo: 'a',
      wasGeneratedBy: 'g',
      reason: 'r',
    });
    expect(prov.wasDerivedFrom.length).toBeGreaterThan(0);
    expect(prov.wasDerivedFrom[0]?.kind).toBe('task-input');
  });
});
