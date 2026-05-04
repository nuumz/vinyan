/**
 * Behavior tests for the T6 `WorldGraph.invalidateByFileHash` API.
 *
 * Pinned contracts:
 *   - returns facts whose stored fileHash differs from the new hash
 *   - returns empty array when hashes match
 *   - filters out facts whose validUntil has expired
 *   - normalizes the file path so callers can pass absolute or relative
 *   - PURE READ — does NOT mutate the world-graph
 */
import { describe, expect, test } from 'bun:test';
import { WorldGraph } from '../../src/world-graph/world-graph.ts';

function buildGraph(): WorldGraph {
  return new WorldGraph(':memory:');
}

function seedFact(graph: WorldGraph, args: { sourceFile: string; fileHash: string; validUntil?: number }) {
  return graph.storeFact({
    target: 'symbol',
    pattern: 'test-pattern',
    evidence: [{ file: args.sourceFile, line: 1, snippet: 'seed', contentHash: args.fileHash }],
    oracleName: 'test',
    fileHash: args.fileHash,
    sourceFile: args.sourceFile,
    verifiedAt: Date.now(),
    confidence: 1,
    ...(args.validUntil !== undefined ? { validUntil: args.validUntil } : {}),
  });
}

describe('WorldGraph.invalidateByFileHash', () => {
  test('returns facts whose stored fileHash differs', () => {
    const graph = buildGraph();
    // Two distinct facts (different targets → distinct content-addressed ids).
    graph.storeFact({
      target: 'symbol-A',
      pattern: 'p1',
      evidence: [{ file: '/repo/foo.ts', line: 1, snippet: 'A' }],
      oracleName: 'test',
      fileHash: 'old-hash',
      sourceFile: '/repo/foo.ts',
      verifiedAt: Date.now(),
      confidence: 1,
    });
    graph.storeFact({
      target: 'symbol-B',
      pattern: 'p1',
      evidence: [{ file: '/repo/foo.ts', line: 2, snippet: 'B' }],
      oracleName: 'test',
      fileHash: 'old-hash',
      sourceFile: '/repo/foo.ts',
      verifiedAt: Date.now(),
      confidence: 1,
    });
    graph.storeFact({
      target: 'symbol-C',
      pattern: 'p1',
      evidence: [{ file: '/repo/bar.ts', line: 3, snippet: 'C' }],
      oracleName: 'test',
      fileHash: 'unchanged',
      sourceFile: '/repo/bar.ts',
      verifiedAt: Date.now(),
      confidence: 1,
    });

    const stale = graph.invalidateByFileHash('/repo/foo.ts', 'new-hash');
    expect(stale.length).toBe(2);
    expect(stale.every((f) => f.sourceFile.endsWith('foo.ts'))).toBe(true);
  });

  test('returns empty array when stored hash already matches new hash', () => {
    const graph = buildGraph();
    seedFact(graph, { sourceFile: '/repo/foo.ts', fileHash: 'h1' });
    seedFact(graph, { sourceFile: '/repo/foo.ts', fileHash: 'h1' });

    const stale = graph.invalidateByFileHash('/repo/foo.ts', 'h1');
    expect(stale).toEqual([]);
  });

  test('filters out expired facts (validUntil <= now)', () => {
    const graph = buildGraph();
    seedFact(graph, { sourceFile: '/repo/foo.ts', fileHash: 'old', validUntil: 1 });
    seedFact(graph, { sourceFile: '/repo/foo.ts', fileHash: 'old' }); // no validUntil → kept

    const stale = graph.invalidateByFileHash('/repo/foo.ts', 'new');
    expect(stale.length).toBe(1);
  });

  test('does NOT mutate the world-graph (call twice → same result)', () => {
    const graph = buildGraph();
    seedFact(graph, { sourceFile: '/repo/foo.ts', fileHash: 'old' });

    const first = graph.invalidateByFileHash('/repo/foo.ts', 'new');
    const second = graph.invalidateByFileHash('/repo/foo.ts', 'new');
    expect(first.length).toBe(1);
    expect(second.length).toBe(1);
    // Both calls must surface the same fact id — proves the read does not
    // mutate the underlying row.
    expect(first[0]?.id).toBe(second[0]?.id);
  });

  test('only returns facts for the requested sourceFile', () => {
    const graph = buildGraph();
    seedFact(graph, { sourceFile: '/repo/foo.ts', fileHash: 'old-A' });
    seedFact(graph, { sourceFile: '/repo/bar.ts', fileHash: 'old-B' });

    const stale = graph.invalidateByFileHash('/repo/foo.ts', 'new-A');
    expect(stale.length).toBe(1);
    expect(stale[0]?.sourceFile.endsWith('foo.ts')).toBe(true);
  });
});
