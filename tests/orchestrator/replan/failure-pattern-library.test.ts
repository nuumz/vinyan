import { describe, expect, test } from 'bun:test';
import { buildFailurePatternLibrary } from '../../../src/orchestrator/replan/failure-pattern-library.ts';
import type { ClassifiedFailure } from '../../../src/orchestrator/failure-classifier.ts';
import type { TaskDAG } from '../../../src/orchestrator/types.ts';

const library = buildFailurePatternLibrary();

function singleNodeDag(overrides?: Partial<TaskDAG['nodes'][number]>): TaskDAG {
  return {
    nodes: [
      {
        id: 'n1',
        description: 'edit source files',
        targetFiles: ['src/foo.ts', 'src/bar.ts'],
        dependencies: [],
        assignedOracles: ['type', 'lint'],
        ...overrides,
      },
    ],
  };
}

function twoNodeDag(): TaskDAG {
  return {
    nodes: [
      {
        id: 'n1',
        description: 'update imports',
        targetFiles: ['src/foo.ts'],
        dependencies: [],
        assignedOracles: ['type'],
      },
      {
        id: 'n2',
        description: 'edit logic',
        targetFiles: ['src/bar.ts'],
        dependencies: ['n1'],
        assignedOracles: ['type', 'test'],
      },
    ],
  };
}

function failure(overrides: Partial<ClassifiedFailure> & { category: ClassifiedFailure['category'] }): ClassifiedFailure {
  return {
    message: 'test error',
    severity: 'error',
    ...overrides,
  };
}

describe('FailurePatternLibrary', () => {
  describe('type_error → isolate file node', () => {
    test('single-node DAG with 2 files produces 2-node DAG', () => {
      const strategy = library.get('type_error')!;
      const dag = singleNodeDag();
      const result = strategy.dagTransform(dag, [
        failure({ category: 'type_error', file: 'src/foo.ts', line: 42 }),
      ]);

      expect(result).not.toBeNull();
      expect(result!.nodes.length).toBe(2);

      const isoNode = result!.nodes.find((n) => n.id === 'n1-type-iso');
      expect(isoNode).toBeDefined();
      expect(isoNode!.targetFiles).toEqual(['src/foo.ts']);
      expect(isoNode!.assignedOracles).toEqual(['type']);

      const remainingNode = result!.nodes.find((n) => n.id === 'n1');
      expect(remainingNode).toBeDefined();
      expect(remainingNode!.targetFiles).toEqual(['src/bar.ts']);
      expect(remainingNode!.dependencies).toContain('n1-type-iso');
    });

    test('returns null when failure has no file', () => {
      const strategy = library.get('type_error')!;
      const dag = singleNodeDag();
      const result = strategy.dagTransform(dag, [
        failure({ category: 'type_error' }),
      ]);
      expect(result).toBeNull();
    });

    test('returns null when no node targets the failing file', () => {
      const strategy = library.get('type_error')!;
      const dag = singleNodeDag();
      const result = strategy.dagTransform(dag, [
        failure({ category: 'type_error', file: 'src/unrelated.ts' }),
      ]);
      expect(result).toBeNull();
    });
  });

  describe('test_failure → test-expectations-first', () => {
    test('prepends test-expectations node, all existing nodes depend on it', () => {
      const strategy = library.get('test_failure')!;
      const dag = twoNodeDag();
      const result = strategy.dagTransform(dag, [
        failure({ category: 'test_failure', file: 'tests/foo.test.ts' }),
      ]);

      expect(result).not.toBeNull();
      expect(result!.nodes.length).toBe(3);

      const expectNode = result!.nodes[0]!;
      expect(expectNode.id).toBe('n0-test-expectations');
      expect(expectNode.targetFiles).toEqual(['tests/foo.test.ts']);
      expect(expectNode.assignedOracles).toContain('test');

      // All original nodes depend on the expectations node
      const n1 = result!.nodes.find((n) => n.id === 'n1')!;
      const n2 = result!.nodes.find((n) => n.id === 'n2')!;
      expect(n1.dependencies).toContain('n0-test-expectations');
      expect(n2.dependencies).toContain('n0-test-expectations');
    });

    test('returns null if test-expectations node already exists', () => {
      const strategy = library.get('test_failure')!;
      const dag: TaskDAG = {
        nodes: [
          { id: 'n0-test-expectations', description: 'existing', targetFiles: [], dependencies: [], assignedOracles: [] },
          { id: 'n1', description: 'edit', targetFiles: ['src/foo.ts'], dependencies: ['n0-test-expectations'], assignedOracles: [] },
        ],
      };
      const result = strategy.dagTransform(dag, [
        failure({ category: 'test_failure' }),
      ]);
      expect(result).toBeNull();
    });
  });

  describe('hallucination_file → perception reassembly', () => {
    test('replaces nodes referencing hallucinated files with perception-recheck', () => {
      const strategy = library.get('hallucination_file')!;
      const dag = twoNodeDag();
      const result = strategy.dagTransform(dag, [
        failure({ category: 'hallucination_file', file: 'src/foo.ts' }),
      ]);

      expect(result).not.toBeNull();
      // n1 targeted src/foo.ts → removed, replaced by perception-recheck
      // n2 survives (targets src/bar.ts), but dependency on n1 is removed
      const recheckNode = result!.nodes.find((n) => n.id === 'perception-recheck');
      expect(recheckNode).toBeDefined();
      expect(recheckNode!.targetFiles).toEqual(['src/foo.ts']);
      expect(recheckNode!.assignedOracles).toEqual(['ast']);

      const n2 = result!.nodes.find((n) => n.id === 'n2');
      expect(n2).toBeDefined();
      expect(n2!.dependencies).not.toContain('n1'); // dangling dep removed
    });

    test('returns null when no file in failures', () => {
      const strategy = library.get('hallucination_file')!;
      const result = strategy.dagTransform(twoNodeDag(), [
        failure({ category: 'hallucination_file' }),
      ]);
      expect(result).toBeNull();
    });
  });

  describe('goal_misalignment → atomic commits', () => {
    test('splits multi-file node into per-file atomic nodes', () => {
      const strategy = library.get('goal_misalignment')!;
      const dag = singleNodeDag(); // n1 has 2 target files
      const result = strategy.dagTransform(dag, [
        failure({ category: 'goal_misalignment' }),
      ]);

      expect(result).not.toBeNull();
      expect(result!.nodes.length).toBe(2);
      expect(result!.nodes[0]!.id).toBe('n1-atomic-0');
      expect(result!.nodes[0]!.targetFiles).toEqual(['src/foo.ts']);
      expect(result!.nodes[1]!.id).toBe('n1-atomic-1');
      expect(result!.nodes[1]!.targetFiles).toEqual(['src/bar.ts']);
    });

    test('returns null when all nodes already have single file', () => {
      const strategy = library.get('goal_misalignment')!;
      const dag: TaskDAG = {
        nodes: [
          { id: 'n1', description: 'edit', targetFiles: ['src/foo.ts'], dependencies: [], assignedOracles: [] },
        ],
      };
      const result = strategy.dagTransform(dag, [
        failure({ category: 'goal_misalignment' }),
      ]);
      expect(result).toBeNull();
    });

    test('fixes up dependencies when splitting', () => {
      const strategy = library.get('goal_misalignment')!;
      const dag: TaskDAG = {
        nodes: [
          { id: 'n1', description: 'base', targetFiles: ['a.ts', 'b.ts'], dependencies: [], assignedOracles: [] },
          { id: 'n2', description: 'dep', targetFiles: ['c.ts'], dependencies: ['n1'], assignedOracles: [] },
        ],
      };
      const result = strategy.dagTransform(dag, [failure({ category: 'goal_misalignment' })]);
      expect(result).not.toBeNull();

      const n2 = result!.nodes.find((n) => n.id === 'n2')!;
      // n2 originally depended on n1, which split into n1-atomic-0 and n1-atomic-1
      expect(n2.dependencies).toContain('n1-atomic-0');
      expect(n2.dependencies).toContain('n1-atomic-1');
      expect(n2.dependencies).not.toContain('n1');
    });
  });

  describe('lint_violation → post-edit lint-fix', () => {
    test('appends lint-fix node after each leaf', () => {
      const strategy = library.get('lint_violation')!;
      const dag = twoNodeDag(); // n2 is a leaf (nothing depends on it)
      const result = strategy.dagTransform(dag, [
        failure({ category: 'lint_violation' }),
      ]);

      expect(result).not.toBeNull();
      expect(result!.nodes.length).toBe(3); // n1, n2, n2-lint-fix

      const lintNode = result!.nodes.find((n) => n.id === 'n2-lint-fix');
      expect(lintNode).toBeDefined();
      expect(lintNode!.dependencies).toEqual(['n2']);
      expect(lintNode!.assignedOracles).toEqual(['lint']);
      expect(lintNode!.targetFiles).toEqual(['src/bar.ts']);
    });

    test('returns null when lint-fix nodes already exist', () => {
      const strategy = library.get('lint_violation')!;
      const dag: TaskDAG = {
        nodes: [
          { id: 'n1', description: 'edit', targetFiles: ['src/foo.ts'], dependencies: [], assignedOracles: [] },
          { id: 'n1-lint-fix', description: 'lint', targetFiles: ['src/foo.ts'], dependencies: ['n1'], assignedOracles: ['lint'] },
        ],
      };
      const result = strategy.dagTransform(dag, [failure({ category: 'lint_violation' })]);
      expect(result).toBeNull();
    });
  });

  describe('unknown category', () => {
    test('library has no entry for unknown', () => {
      expect(library.get('unknown')).toBeUndefined();
    });

    test('library has no entry for overconfidence', () => {
      expect(library.get('overconfidence')).toBeUndefined();
    });
  });

  describe('transforms never mutate input', () => {
    test('original DAG is unchanged after transform', () => {
      const dag = singleNodeDag();
      const originalJson = JSON.stringify(dag);
      library.get('type_error')!.dagTransform(dag, [
        failure({ category: 'type_error', file: 'src/foo.ts' }),
      ]);
      expect(JSON.stringify(dag)).toBe(originalJson);
    });
  });
});
