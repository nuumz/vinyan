import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { WorldGraph } from '../../src/world-graph/world-graph.ts';

describe('WorldGraph causal edges', () => {
  let wg: WorldGraph;

  beforeEach(() => {
    wg = new WorldGraph(); // in-memory DB
  });

  afterEach(() => {
    wg.close();
  });

  test('recordCausalEdge inserts new edge', () => {
    wg.recordCausalEdge('src/a.ts', 'src/b.ts', 'type', 0.9);

    const edges = wg.getCausalEdges('src/a.ts');
    expect(edges).toHaveLength(1);
    expect(edges[0]!.sourceFile).toBe('src/a.ts');
    expect(edges[0]!.targetFile).toBe('src/b.ts');
    expect(edges[0]!.oracleName).toBe('type');
    expect(edges[0]!.confidence).toBe(0.9);
    expect(edges[0]!.observationCount).toBe(1);
  });

  test('recordCausalEdge upserts — increments observation_count', () => {
    wg.recordCausalEdge('src/a.ts', 'src/b.ts', 'type', 0.8);
    wg.recordCausalEdge('src/a.ts', 'src/b.ts', 'type', 0.95);

    const edges = wg.getCausalEdges('src/a.ts');
    expect(edges).toHaveLength(1);
    expect(edges[0]!.observationCount).toBe(2);
    expect(edges[0]!.confidence).toBe(0.95); // updated to latest
  });

  test('different oracles create separate edges', () => {
    wg.recordCausalEdge('src/a.ts', 'src/b.ts', 'type', 0.9);
    wg.recordCausalEdge('src/a.ts', 'src/b.ts', 'test', 0.7);

    const edges = wg.getCausalEdges('src/a.ts');
    expect(edges).toHaveLength(2);
  });

  test('getCausalEdges returns edges for both source and target', () => {
    wg.recordCausalEdge('src/a.ts', 'src/b.ts', 'type', 0.9);
    wg.recordCausalEdge('src/c.ts', 'src/b.ts', 'dep', 0.8);

    // Query by target file — should find both edges
    const edges = wg.getCausalEdges('src/b.ts');
    expect(edges).toHaveLength(2);
  });

  test('queryCausalDependents — single hop', () => {
    wg.recordCausalEdge('src/a.ts', 'src/b.ts', 'type', 0.9);

    const deps = wg.queryCausalDependents('src/a.ts');
    expect(deps).toEqual(['src/b.ts']);
  });

  test('queryCausalDependents — BFS chain A→B→C', () => {
    wg.recordCausalEdge('src/a.ts', 'src/b.ts', 'type', 0.9);
    wg.recordCausalEdge('src/b.ts', 'src/c.ts', 'dep', 0.8);

    const deps = wg.queryCausalDependents('src/a.ts');
    expect(deps).toContain('src/b.ts');
    expect(deps).toContain('src/c.ts');
    expect(deps).toHaveLength(2);
  });

  test('queryCausalDependents — respects maxDepth', () => {
    wg.recordCausalEdge('src/a.ts', 'src/b.ts', 'type', 0.9);
    wg.recordCausalEdge('src/b.ts', 'src/c.ts', 'dep', 0.8);
    wg.recordCausalEdge('src/c.ts', 'src/d.ts', 'test', 0.7);

    const deps = wg.queryCausalDependents('src/a.ts', 2);
    expect(deps).toContain('src/b.ts');
    expect(deps).toContain('src/c.ts');
    expect(deps).not.toContain('src/d.ts');
  });

  test('queryCausalDependents — handles circular dependencies', () => {
    wg.recordCausalEdge('src/a.ts', 'src/b.ts', 'type', 0.9);
    wg.recordCausalEdge('src/b.ts', 'src/c.ts', 'dep', 0.8);
    wg.recordCausalEdge('src/c.ts', 'src/a.ts', 'test', 0.7); // cycle back

    // Should not infinite loop — visited set prevents revisiting
    const deps = wg.queryCausalDependents('src/a.ts');
    expect(deps).toContain('src/b.ts');
    expect(deps).toContain('src/c.ts');
    // src/a.ts itself is excluded (it's the root)
    expect(deps).not.toContain('src/a.ts');
  });

  test('queryCausalDependents — returns empty for unknown file', () => {
    const deps = wg.queryCausalDependents('src/unknown.ts');
    expect(deps).toEqual([]);
  });

  test('pruneStaleCausalEdges removes old edges', () => {
    // Record an edge, then manually update last_observed_at to 100 days ago
    wg.recordCausalEdge('src/a.ts', 'src/b.ts', 'type', 0.9);
    wg.recordCausalEdge('src/c.ts', 'src/d.ts', 'dep', 0.8);

    // Artificially age the first edge
    const oldTimestamp = Date.now() - 100 * 24 * 60 * 60 * 1000;
    (wg as any).db.run(
      'UPDATE causal_edges SET last_observed_at = ? WHERE source_file = ?',
      [oldTimestamp, 'src/a.ts'],
    );

    const pruned = wg.pruneStaleCausalEdges(90);
    expect(pruned).toBe(1);

    // Recent edge should remain
    const remaining = wg.getCausalEdges('src/c.ts');
    expect(remaining).toHaveLength(1);

    // Old edge should be gone
    const gone = wg.getCausalEdges('src/a.ts');
    expect(gone).toHaveLength(0);
  });

  test('pruneStaleCausalEdges with custom maxAgeDays', () => {
    wg.recordCausalEdge('src/a.ts', 'src/b.ts', 'type', 0.9);

    // Age to 10 days ago
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    (wg as any).db.run(
      'UPDATE causal_edges SET last_observed_at = ? WHERE source_file = ?',
      [tenDaysAgo, 'src/a.ts'],
    );

    // With default 90 days — should NOT prune
    expect(wg.pruneStaleCausalEdges(90)).toBe(0);

    // With 7 days — SHOULD prune
    expect(wg.pruneStaleCausalEdges(7)).toBe(1);
  });
});
