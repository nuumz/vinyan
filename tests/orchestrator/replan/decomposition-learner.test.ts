import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { PATTERN_SCHEMA_SQL } from '../../../src/db/pattern-schema.ts';
import { PatternStore } from '../../../src/db/pattern-store.ts';
import { DecompositionLearner, computeDagShapeHash } from '../../../src/orchestrator/replan/decomposition-learner.ts';
import type { TaskDAG } from '../../../src/orchestrator/types.ts';

function createLearner() {
  const db = new Database(':memory:');
  db.exec(PATTERN_SCHEMA_SQL);
  const patternStore = new PatternStore(db);
  return { learner: new DecompositionLearner({ patternStore }), patternStore };
}

function makeDag(nodeCount = 2): TaskDAG {
  return {
    nodes: Array.from({ length: nodeCount }, (_, i) => ({
      id: `n${i + 1}`,
      description: `step ${i + 1}`,
      targetFiles: [`src/file${i + 1}.ts`],
      dependencies: i > 0 ? [`n${i}`] : [],
      assignedOracles: ['type'],
    })),
  };
}

describe('DecompositionLearner', () => {
  test('recordWinningDecomposition → pattern stored with type=decomposition-pattern', () => {
    const { learner, patternStore } = createLearner();
    const dag = makeDag(2);
    learner.recordWinningDecomposition('refactor::auth', dag, 'trace-1');

    const patterns = patternStore.findByTaskSignature('refactor::auth');
    expect(patterns.length).toBe(1);
    expect(patterns[0]!.type).toBe('decomposition-pattern');
    expect(patterns[0]!.frequency).toBe(1);
    expect(patterns[0]!.confidence).toBe(0.5);
    expect(patterns[0]!.sourceTraceIds).toContain('trace-1');
  });

  test('recordWinningDecomposition twice → frequency incremented', () => {
    const { learner, patternStore } = createLearner();
    const dag = makeDag(2);
    learner.recordWinningDecomposition('refactor::auth', dag, 'trace-1');
    learner.recordWinningDecomposition('refactor::auth', dag, 'trace-2');

    const patterns = patternStore.findByTaskSignature('refactor::auth');
    expect(patterns.length).toBe(1);
    expect(patterns[0]!.frequency).toBe(2);
    expect(patterns[0]!.confidence).toBe(0.6); // 0.5 + 1*0.1
    expect(patterns[0]!.sourceTraceIds).toContain('trace-1');
    expect(patterns[0]!.sourceTraceIds).toContain('trace-2');
  });

  test('retrieveSeedShape for same signature → returns stored shape', () => {
    const { learner } = createLearner();
    const dag = makeDag(3);
    learner.recordWinningDecomposition('refactor::auth', dag, 'trace-1');

    const seed = learner.retrieveSeedShape('refactor::auth');
    expect(seed).toBeDefined();
    expect(seed!.nodes.length).toBe(3);
    expect(seed!.nodes[0]!.id).toBe('n1');
    expect(seed!.nodes[1]!.id).toBe('n2');
    expect(seed!.nodes[2]!.id).toBe('n3');
    // Seed has empty targetFiles (caller fills in)
    expect(seed!.nodes[0]!.targetFiles).toEqual([]);
  });

  test('retrieveSeedShape for unknown signature → undefined', () => {
    const { learner } = createLearner();
    learner.recordWinningDecomposition('refactor::auth', makeDag(), 'trace-1');

    const seed = learner.retrieveSeedShape('unknown::signature');
    expect(seed).toBeUndefined();
  });

  test('decayed pattern (decayWeight < 0.1) → not retrieved', () => {
    const { learner, patternStore } = createLearner();
    const dag = makeDag(2);
    learner.recordWinningDecomposition('refactor::auth', dag, 'trace-1');

    // Decay the pattern
    const patterns = patternStore.findByTaskSignature('refactor::auth');
    patternStore.updateDecayWeight(patterns[0]!.id, 0.05);

    const seed = learner.retrieveSeedShape('refactor::auth');
    expect(seed).toBeUndefined();
  });

  test('round-trip: record then retrieve → structural DAG shape preserved', () => {
    const { learner } = createLearner();
    const dag: TaskDAG = {
      nodes: [
        { id: 'setup', description: 'setup env', targetFiles: ['env.ts'], dependencies: [], assignedOracles: ['type'] },
        { id: 'impl', description: 'implement', targetFiles: ['main.ts'], dependencies: ['setup'], assignedOracles: ['type', 'test'] },
        { id: 'verify', description: 'verify', targetFiles: ['test.ts'], dependencies: ['impl'], assignedOracles: ['test'] },
      ],
    };
    learner.recordWinningDecomposition('feat::new-feature', dag, 'trace-1');

    const seed = learner.retrieveSeedShape('feat::new-feature');
    expect(seed).toBeDefined();
    expect(seed!.nodes.length).toBe(3);
    expect(seed!.nodes[0]!.description).toBe('setup env');
    expect(seed!.nodes[1]!.dependencies).toEqual(['setup']);
    expect(seed!.nodes[2]!.assignedOracles).toEqual(['test']);
  });

  test('empty DAG is not recorded', () => {
    const { learner, patternStore } = createLearner();
    learner.recordWinningDecomposition('refactor::auth', { nodes: [] }, 'trace-1');

    const patterns = patternStore.findByTaskSignature('refactor::auth');
    expect(patterns.length).toBe(0);
  });

  test('computeDagShapeHash is deterministic and ignores file names', () => {
    const dag1: TaskDAG = { nodes: [{ id: 'n1', description: 'a', targetFiles: ['foo.ts'], dependencies: [], assignedOracles: ['type'] }] };
    const dag2: TaskDAG = { nodes: [{ id: 'n1', description: 'a', targetFiles: ['bar.ts'], dependencies: [], assignedOracles: ['type'] }] };
    // Same structure, different files → same hash
    expect(computeDagShapeHash(dag1)).toBe(computeDagShapeHash(dag2));
  });

  test('different DAG structures produce different hashes', () => {
    const dag1 = makeDag(2);
    const dag2 = makeDag(3);
    expect(computeDagShapeHash(dag1)).not.toBe(computeDagShapeHash(dag2));
  });
});
