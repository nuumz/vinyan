import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WorldGraph } from '../../src/world-graph/world-graph.ts';

describe('WorldGraph dependency edges', () => {
  let wg: WorldGraph;

  beforeEach(() => {
    wg = new WorldGraph(); // in-memory DB
  });

  afterEach(() => {
    wg.close();
  });

  test('storeEdge + queryDependents single hop', () => {
    // B imports A  →  edge: B -> A
    wg.storeEdge('src/b.ts', 'src/a.ts');

    const dependents = wg.queryDependents('src/a.ts');
    expect(dependents).toEqual(['src/b.ts']);
  });

  test('queryDependents multi-hop with depth cap', () => {
    // Chain: A <- B <- C <- D  (D imports C, C imports B, B imports A)
    wg.storeEdge('src/b.ts', 'src/a.ts');
    wg.storeEdge('src/c.ts', 'src/b.ts');
    wg.storeEdge('src/d.ts', 'src/c.ts');

    // maxDepth=2: should find B (hop 1), C (hop 2) but NOT D (hop 3)
    const dependents = wg.queryDependents('src/a.ts', 2);
    expect(dependents).toContain('src/b.ts');
    expect(dependents).toContain('src/c.ts');
    expect(dependents).not.toContain('src/d.ts');
    expect(dependents).toHaveLength(2);
  });

  test('queryDependents with maxDepth=3 includes all reachable nodes', () => {
    wg.storeEdge('src/b.ts', 'src/a.ts');
    wg.storeEdge('src/c.ts', 'src/b.ts');
    wg.storeEdge('src/d.ts', 'src/c.ts');

    const dependents = wg.queryDependents('src/a.ts', 3);
    expect(dependents).toContain('src/b.ts');
    expect(dependents).toContain('src/c.ts');
    expect(dependents).toContain('src/d.ts');
    expect(dependents).toHaveLength(3);
  });

  test('queryDependents returns empty for file with no dependents', () => {
    wg.storeEdge('src/b.ts', 'src/a.ts');
    const dependents = wg.queryDependents('src/b.ts');
    expect(dependents).toHaveLength(0);
  });

  test('queryDependents does not include the queried file itself', () => {
    // Self-import edge (shouldn't appear in results)
    wg.storeEdge('src/a.ts', 'src/a.ts');
    wg.storeEdge('src/b.ts', 'src/a.ts');

    const dependents = wg.queryDependents('src/a.ts');
    expect(dependents).not.toContain('src/a.ts');
    expect(dependents).toEqual(['src/b.ts']);
  });

  test('clearEdgesForFile removes edges originating from file', () => {
    wg.storeEdge('src/b.ts', 'src/a.ts');
    wg.storeEdge('src/b.ts', 'src/c.ts');
    wg.storeEdge('src/d.ts', 'src/a.ts');

    wg.clearEdgesForFile('src/b.ts');

    // B's edges are gone, so A's dependents should only be D
    const dependentsA = wg.queryDependents('src/a.ts');
    expect(dependentsA).toEqual(['src/d.ts']);

    // C should have no dependents
    const dependentsC = wg.queryDependents('src/c.ts');
    expect(dependentsC).toHaveLength(0);
  });

  test('storeEdges batch insert', () => {
    wg.storeEdges([
      { from: 'src/b.ts', to: 'src/a.ts' },
      { from: 'src/c.ts', to: 'src/a.ts' },
      { from: 'src/c.ts', to: 'src/b.ts', type: 're-exports' },
    ]);

    const dependentsA = wg.queryDependents('src/a.ts');
    expect(dependentsA).toContain('src/b.ts');
    expect(dependentsA).toContain('src/c.ts');
    expect(dependentsA).toHaveLength(2);

    const dependentsB = wg.queryDependents('src/b.ts');
    expect(dependentsB).toContain('src/c.ts');
  });

  test('storeEdges with empty array does not error', () => {
    expect(() => wg.storeEdges([])).not.toThrow();
  });

  test('queryDependencies forward traversal single hop', () => {
    // A imports B and C  →  edges: A -> B, A -> C
    wg.storeEdge('src/a.ts', 'src/b.ts');
    wg.storeEdge('src/a.ts', 'src/c.ts');

    const deps = wg.queryDependencies('src/a.ts');
    expect(deps).toContain('src/b.ts');
    expect(deps).toContain('src/c.ts');
    expect(deps).toHaveLength(2);
  });

  test('queryDependencies multi-hop with depth cap', () => {
    // A -> B -> C -> D
    wg.storeEdge('src/a.ts', 'src/b.ts');
    wg.storeEdge('src/b.ts', 'src/c.ts');
    wg.storeEdge('src/c.ts', 'src/d.ts');

    // maxDepth=2: B (hop 1), C (hop 2) but not D (hop 3)
    const deps = wg.queryDependencies('src/a.ts', 2);
    expect(deps).toContain('src/b.ts');
    expect(deps).toContain('src/c.ts');
    expect(deps).not.toContain('src/d.ts');
    expect(deps).toHaveLength(2);
  });

  test('queryDependencies returns empty for file with no imports', () => {
    wg.storeEdge('src/b.ts', 'src/a.ts');
    const deps = wg.queryDependencies('src/a.ts');
    expect(deps).toHaveLength(0);
  });

  test('queryDependencies does not include the queried file itself', () => {
    wg.storeEdge('src/a.ts', 'src/a.ts');
    wg.storeEdge('src/a.ts', 'src/b.ts');

    const deps = wg.queryDependencies('src/a.ts');
    expect(deps).not.toContain('src/a.ts');
    expect(deps).toEqual(['src/b.ts']);
  });

  test('storeEdge upserts on duplicate (same from/to/type)', () => {
    wg.storeEdge('src/a.ts', 'src/b.ts');
    // Should not throw on duplicate
    expect(() => wg.storeEdge('src/a.ts', 'src/b.ts')).not.toThrow();

    const deps = wg.queryDependencies('src/a.ts');
    expect(deps).toEqual(['src/b.ts']);
  });

  test('BFS handles diamond dependency pattern', () => {
    //   A
    //  / \
    // B   C
    //  \ /
    //   D
    wg.storeEdge('src/a.ts', 'src/b.ts');
    wg.storeEdge('src/a.ts', 'src/c.ts');
    wg.storeEdge('src/b.ts', 'src/d.ts');
    wg.storeEdge('src/c.ts', 'src/d.ts');

    const deps = wg.queryDependencies('src/a.ts', 3);
    expect(deps).toContain('src/b.ts');
    expect(deps).toContain('src/c.ts');
    expect(deps).toContain('src/d.ts');
    expect(deps).toHaveLength(3);

    // Reverse: who depends on D?
    const dependents = wg.queryDependents('src/d.ts', 3);
    expect(dependents).toContain('src/b.ts');
    expect(dependents).toContain('src/c.ts');
    expect(dependents).toContain('src/a.ts');
    expect(dependents).toHaveLength(3);
  });

  test('workspaceRoot normalizes absolute dependency edges for relative queries', () => {
    wg.close();
    const workspace = mkdtempSync(join(tmpdir(), 'vinyan-wg-edges-'));
    try {
      wg = new WorldGraph(':memory:', { workspaceRoot: workspace });
      wg.storeEdge(join(workspace, 'src', 'bar.ts'), join(workspace, 'src', 'foo.ts'));

      expect(wg.queryDependents('src/foo.ts')).toEqual(['src/bar.ts']);
      expect(wg.queryDependencies('src/bar.ts')).toEqual(['src/foo.ts']);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
