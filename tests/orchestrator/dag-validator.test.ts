import { describe, expect, test } from 'bun:test';
import { allCriteriaMet, formatFailures, validateDAG } from '../../src/orchestrator/dag-validator.ts';
import type { TaskDAG } from '../../src/orchestrator/types.ts';

describe('validateDAG', () => {
  // ── Single-node DAG (always valid) ──────────────────────────────────

  test('single-node DAG passes all criteria', () => {
    const dag: TaskDAG = {
      nodes: [
        { id: 'n1', description: 'do stuff', targetFiles: ['a.ts'], dependencies: [], assignedOracles: ['type'] },
      ],
    };
    const result = validateDAG(dag, ['a.ts']);
    expect(allCriteriaMet(result)).toBe(true);
  });

  // ── C1: no_orphans ──────────────────────────────────────────────────

  test('C1 pass: connected DAG', () => {
    const dag: TaskDAG = {
      nodes: [
        { id: 'n1', description: 'a', targetFiles: ['a.ts'], dependencies: [], assignedOracles: ['type'] },
        { id: 'n2', description: 'b', targetFiles: ['b.ts'], dependencies: ['n1'], assignedOracles: ['type'] },
      ],
    };
    expect(validateDAG(dag, []).no_orphans).toBe(true);
  });

  test('C1 fail: disconnected nodes', () => {
    const dag: TaskDAG = {
      nodes: [
        { id: 'n1', description: 'a', targetFiles: ['a.ts'], dependencies: [], assignedOracles: ['type'] },
        { id: 'n2', description: 'b', targetFiles: ['b.ts'], dependencies: [], assignedOracles: ['type'] },
      ],
    };
    expect(validateDAG(dag, []).no_orphans).toBe(false);
  });

  test('C1/C4: dependency references unknown node → caught by C4', () => {
    const dag: TaskDAG = {
      nodes: [{ id: 'n1', description: 'a', targetFiles: ['a.ts'], dependencies: ['n99'], assignedOracles: ['type'] }],
    };
    // Single-node DAG passes C1 (no orphan check needed for 1 node)
    // but fails C4 (unknown dependency ID)
    const result = validateDAG(dag, []);
    expect(result.no_orphans).toBe(true);
    expect(result.valid_dependency_order).toBe(false);
  });

  // ── C2: no_scope_overlap ────────────────────────────────────────────

  test('C2 pass: no file overlap', () => {
    const dag: TaskDAG = {
      nodes: [
        { id: 'n1', description: 'a', targetFiles: ['a.ts'], dependencies: [], assignedOracles: ['type'] },
        { id: 'n2', description: 'b', targetFiles: ['b.ts'], dependencies: ['n1'], assignedOracles: ['type'] },
      ],
    };
    expect(validateDAG(dag, []).no_scope_overlap).toBe(true);
  });

  test('C2 fail: overlapping target files', () => {
    const dag: TaskDAG = {
      nodes: [
        { id: 'n1', description: 'a', targetFiles: ['shared.ts'], dependencies: [], assignedOracles: ['type'] },
        { id: 'n2', description: 'b', targetFiles: ['shared.ts'], dependencies: ['n1'], assignedOracles: ['type'] },
      ],
    };
    expect(validateDAG(dag, []).no_scope_overlap).toBe(false);
  });

  // ── C3: coverage ────────────────────────────────────────────────────

  test('C3 pass: all blast radius files covered', () => {
    const dag: TaskDAG = {
      nodes: [
        { id: 'n1', description: 'a', targetFiles: ['a.ts', 'b.ts'], dependencies: [], assignedOracles: ['type'] },
      ],
    };
    expect(validateDAG(dag, ['a.ts', 'b.ts']).coverage).toBe(true);
  });

  test('C3 pass: empty blast radius', () => {
    const dag: TaskDAG = {
      nodes: [{ id: 'n1', description: 'a', targetFiles: [], dependencies: [], assignedOracles: ['type'] }],
    };
    expect(validateDAG(dag, []).coverage).toBe(true);
  });

  test('C3 fail: missing blast radius file', () => {
    const dag: TaskDAG = {
      nodes: [{ id: 'n1', description: 'a', targetFiles: ['a.ts'], dependencies: [], assignedOracles: ['type'] }],
    };
    expect(validateDAG(dag, ['a.ts', 'c.ts']).coverage).toBe(false);
  });

  // ── C4: valid_dependency_order ──────────────────────────────────────

  test('C4 pass: acyclic DAG', () => {
    const dag: TaskDAG = {
      nodes: [
        { id: 'n1', description: 'a', targetFiles: ['a.ts'], dependencies: [], assignedOracles: ['type'] },
        { id: 'n2', description: 'b', targetFiles: ['b.ts'], dependencies: ['n1'], assignedOracles: ['type'] },
        { id: 'n3', description: 'c', targetFiles: ['c.ts'], dependencies: ['n1', 'n2'], assignedOracles: ['type'] },
      ],
    };
    expect(validateDAG(dag, []).valid_dependency_order).toBe(true);
  });

  test('C4 fail: cycle (A→B→A)', () => {
    const dag: TaskDAG = {
      nodes: [
        { id: 'n1', description: 'a', targetFiles: ['a.ts'], dependencies: ['n2'], assignedOracles: ['type'] },
        { id: 'n2', description: 'b', targetFiles: ['b.ts'], dependencies: ['n1'], assignedOracles: ['type'] },
      ],
    };
    expect(validateDAG(dag, []).valid_dependency_order).toBe(false);
  });

  test('C4 fail: self-cycle', () => {
    const dag: TaskDAG = {
      nodes: [{ id: 'n1', description: 'a', targetFiles: ['a.ts'], dependencies: ['n1'], assignedOracles: ['type'] }],
    };
    expect(validateDAG(dag, []).valid_dependency_order).toBe(false);
  });

  test('C4 fail: unknown dependency ID', () => {
    const dag: TaskDAG = {
      nodes: [{ id: 'n1', description: 'a', targetFiles: ['a.ts'], dependencies: ['n999'], assignedOracles: ['type'] }],
    };
    expect(validateDAG(dag, []).valid_dependency_order).toBe(false);
  });

  // ── C5: verification_specified ──────────────────────────────────────

  test('C5 pass: leaf has oracles', () => {
    const dag: TaskDAG = {
      nodes: [
        { id: 'n1', description: 'a', targetFiles: ['a.ts'], dependencies: [], assignedOracles: [] },
        { id: 'n2', description: 'b', targetFiles: ['b.ts'], dependencies: ['n1'], assignedOracles: ['type', 'dep'] },
      ],
    };
    // n2 is the leaf (nobody depends on it) and has oracles
    expect(validateDAG(dag, []).verification_specified).toBe(true);
  });

  test('C5 fail: leaf has empty oracles', () => {
    const dag: TaskDAG = {
      nodes: [
        { id: 'n1', description: 'a', targetFiles: ['a.ts'], dependencies: [], assignedOracles: ['type'] },
        { id: 'n2', description: 'b', targetFiles: ['b.ts'], dependencies: ['n1'], assignedOracles: [] },
      ],
    };
    expect(validateDAG(dag, []).verification_specified).toBe(false);
  });

  // ── allCriteriaMet / formatFailures ─────────────────────────────────

  test('allCriteriaMet true when all pass', () => {
    const criteria = {
      no_orphans: true,
      no_scope_overlap: true,
      coverage: true,
      valid_dependency_order: true,
      verification_specified: true,
    };
    expect(allCriteriaMet(criteria)).toBe(true);
  });

  test('allCriteriaMet false when any fail', () => {
    const criteria = {
      no_orphans: true,
      no_scope_overlap: false,
      coverage: true,
      valid_dependency_order: true,
      verification_specified: true,
    };
    expect(allCriteriaMet(criteria)).toBe(false);
  });

  test('formatFailures returns messages for failed criteria only', () => {
    const criteria = {
      no_orphans: true,
      no_scope_overlap: false,
      coverage: false,
      valid_dependency_order: true,
      verification_specified: true,
    };
    const failures = formatFailures(criteria);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain('overlap');
    expect(failures[1]).toContain('Coverage');
  });

  test('formatFailures empty when all pass', () => {
    const criteria = {
      no_orphans: true,
      no_scope_overlap: true,
      coverage: true,
      valid_dependency_order: true,
      verification_specified: true,
    };
    expect(formatFailures(criteria)).toHaveLength(0);
  });
});
