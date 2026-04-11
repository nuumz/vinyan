import { describe, test, expect, beforeEach } from 'bun:test';
import { DepConeIndex } from '../../src/world-graph/dep-cone-index.ts';
import type { DependencyEdge } from '../../src/world-graph/dep-cone-index.ts';

function makeEdge(from: string, to: string): DependencyEdge {
  return { fromFile: from, toFile: to };
}

describe('DepConeIndex', () => {
  let index: DepConeIndex;

  beforeEach(() => {
    index = new DepConeIndex();
  });

  describe('loadAll', () => {
    test('populates both adjacency maps', () => {
      // A imports B, B imports C
      index.loadAll([makeEdge('A', 'B'), makeEdge('B', 'C')]);

      expect(index.fileCount).toBe(3);
      expect(index.edgeCount).toBe(2);
      expect(index.getDependencies('A')).toEqual(['B']);
      expect(index.getDependents('B')).toContain('A');
      expect(index.getDependencies('B')).toEqual(['C']);
      expect(index.getDependents('C')).toEqual(['B']);
    });

    test('clears existing data', () => {
      index.loadAll([makeEdge('A', 'B')]);
      expect(index.edgeCount).toBe(1);

      index.loadAll([makeEdge('X', 'Y')]);
      expect(index.edgeCount).toBe(1);
      expect(index.getDependencies('A')).toEqual([]);
      expect(index.getDependencies('X')).toEqual(['Y']);
    });
  });

  describe('getDependents', () => {
    test('returns 1-hop reverse dependents', () => {
      // A→B, C→B: B has dependents [A, C]
      index.loadAll([makeEdge('A', 'B'), makeEdge('C', 'B')]);
      const result = index.getDependents('B');
      expect(result).toHaveLength(2);
      expect(result).toContain('A');
      expect(result).toContain('C');
    });

    test('returns empty for unknown file', () => {
      index.loadAll([makeEdge('A', 'B')]);
      expect(index.getDependents('Z')).toEqual([]);
    });
  });

  describe('getDependencies', () => {
    test('returns 1-hop forward dependencies', () => {
      // A→B, A→C
      index.loadAll([makeEdge('A', 'B'), makeEdge('A', 'C')]);
      const result = index.getDependencies('A');
      expect(result).toHaveLength(2);
      expect(result).toContain('B');
      expect(result).toContain('C');
    });
  });

  describe('queryDependents', () => {
    test('BFS: A→B→C chain at depth 3', () => {
      // C imports B, B imports A → dependents of A: B (depth 1), C (depth 2)
      index.loadAll([makeEdge('B', 'A'), makeEdge('C', 'B')]);
      const result = index.queryDependents('A', 3);
      expect(result).toHaveLength(2);
      expect(result).toContain('B');
      expect(result).toContain('C');
    });

    test('respects maxDepth', () => {
      // Chain: D→C→B→A. Dependents of A at depth 1 = [B], depth 2 = [B, C], depth 3 = [B, C, D]
      index.loadAll([makeEdge('B', 'A'), makeEdge('C', 'B'), makeEdge('D', 'C')]);

      expect(index.queryDependents('A', 1)).toHaveLength(1);
      expect(index.queryDependents('A', 1)).toContain('B');

      expect(index.queryDependents('A', 2)).toHaveLength(2);
      expect(index.queryDependents('A', 2)).toContain('C');

      expect(index.queryDependents('A', 3)).toHaveLength(3);
      expect(index.queryDependents('A', 3)).toContain('D');
    });

    test('caches BFS result', () => {
      index.loadAll([makeEdge('B', 'A'), makeEdge('C', 'B')]);

      const first = index.queryDependents('A', 3);
      const second = index.queryDependents('A', 3);
      // Same reference from cache
      expect(first).toBe(second);
    });

    test('recomputes after dirty', () => {
      index.loadAll([makeEdge('B', 'A')]);
      const first = index.queryDependents('A', 3);
      expect(first).toHaveLength(1);

      // Add C→A edge → A becomes dirty
      index.updateEdges('C', ['A']);
      const second = index.queryDependents('A', 3);
      expect(second).toHaveLength(2);
      expect(second).toContain('B');
      expect(second).toContain('C');
      // Not the same reference (recomputed)
      expect(first).not.toBe(second);
    });

    test('handles cycles without infinite loop', () => {
      // A→B→A (circular)
      index.loadAll([makeEdge('A', 'B'), makeEdge('B', 'A')]);
      const result = index.queryDependents('A', 3);
      // B depends on A, A depends on B — BFS skips self
      expect(result).toContain('B');
      // Should not infinite loop — terminates via visited Set
    });

    test('handles diamond dependency', () => {
      // D→B, D→C, B→A, C→A
      index.loadAll([
        makeEdge('D', 'B'),
        makeEdge('D', 'C'),
        makeEdge('B', 'A'),
        makeEdge('C', 'A'),
      ]);
      const result = index.queryDependents('A', 3);
      expect(result).toHaveLength(3); // B, C, D
      expect(result).toContain('B');
      expect(result).toContain('C');
      expect(result).toContain('D');
    });
  });

  describe('updateEdges', () => {
    test('adds new edges incrementally', () => {
      index.loadAll([]);
      index.updateEdges('A', ['B', 'C']);

      expect(index.edgeCount).toBe(2);
      expect(index.getDependencies('A')).toContain('B');
      expect(index.getDependencies('A')).toContain('C');
      expect(index.getDependents('B')).toEqual(['A']);
    });

    test('replaces old edges from same file', () => {
      index.loadAll([makeEdge('A', 'B'), makeEdge('A', 'C')]);
      expect(index.edgeCount).toBe(2);

      // Replace A's edges: B,C → D,E
      index.updateEdges('A', ['D', 'E']);
      expect(index.edgeCount).toBe(2);
      expect(index.getDependencies('A')).toContain('D');
      expect(index.getDependencies('A')).toContain('E');
      expect(index.getDependents('B')).toEqual([]);
      expect(index.getDependents('C')).toEqual([]);
    });

    test('invalidates BFS cache for affected files', () => {
      index.loadAll([makeEdge('B', 'A')]);
      // Warm the cache
      const before = index.queryDependents('A', 3);
      expect(before).toHaveLength(1);

      // Update: C now also imports A
      index.updateEdges('C', ['A']);

      // Should recompute — not return stale cache
      const after = index.queryDependents('A', 3);
      expect(after).toHaveLength(2);
    });

    test('clears transitive BFS cache (regression: stale cache for unaffected root)', () => {
      // A→B→C chain
      index.loadAll([makeEdge('A', 'B'), makeEdge('B', 'C')]);

      // BFS: who transitively depends on C? → B and A
      const before = index.queryDependents('C', 3);
      expect(before).toContain('B');
      expect(before).toContain('A');
      expect(before).toHaveLength(2);

      // Remove A→B edge: A no longer depends on B
      index.updateEdges('A', []);

      // Now only B depends on C (A is disconnected)
      const after = index.queryDependents('C', 3);
      expect(after).toEqual(['B']);
    });
  });

  describe('removeEdgesForFile', () => {
    test('clears all edges from file', () => {
      index.loadAll([makeEdge('A', 'B'), makeEdge('A', 'C'), makeEdge('D', 'B')]);
      expect(index.edgeCount).toBe(3);

      index.removeEdgesForFile('A');
      expect(index.edgeCount).toBe(1);
      expect(index.getDependencies('A')).toEqual([]);
      // B still has D as dependent
      expect(index.getDependents('B')).toEqual(['D']);
      // C has no more dependents
      expect(index.getDependents('C')).toEqual([]);
    });
  });

  describe('edgeCount and fileCount', () => {
    test('track correctly', () => {
      index.loadAll([]);
      expect(index.edgeCount).toBe(0);
      expect(index.fileCount).toBe(0);

      index.updateEdges('A', ['B', 'C']);
      expect(index.edgeCount).toBe(2);
      expect(index.fileCount).toBe(3); // A, B, C

      index.updateEdges('D', ['B']);
      expect(index.edgeCount).toBe(3);
      expect(index.fileCount).toBe(4); // A, B, C, D

      index.removeEdgesForFile('A');
      expect(index.edgeCount).toBe(1); // only D→B
      expect(index.fileCount).toBe(2); // D, B
    });
  });

  describe('performance', () => {
    test('µs latency: getDependents on 500-file graph in <50µs', () => {
      // Build a 500-file graph: file_0 → file_1, file_1 → file_2, ... + cross-links
      const edges: DependencyEdge[] = [];
      for (let i = 0; i < 500; i++) {
        edges.push(makeEdge(`file_${i}`, `file_${(i + 1) % 500}`));
        // Add some cross-links for realism
        if (i % 10 === 0) {
          edges.push(makeEdge(`file_${i}`, `file_${(i + 50) % 500}`));
        }
      }
      index.loadAll(edges);

      // Warm up
      index.getDependents('file_250');

      // Measure
      const iterations = 1000;
      const start = Bun.nanoseconds();
      for (let i = 0; i < iterations; i++) {
        index.getDependents(`file_${i % 500}`);
      }
      const elapsed = Bun.nanoseconds() - start;
      const avgNs = elapsed / iterations;
      const avgUs = avgNs / 1000;

      // getDependents is a single Map.get + Array.from — should be well under 50µs
      expect(avgUs).toBeLessThan(50);
    });
  });
});
