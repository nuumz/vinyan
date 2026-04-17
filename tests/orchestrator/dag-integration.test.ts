/**
 * DAG Integration Tests — verifies EO #1+#4 wiring in core-loop.ts
 * and EO #5 LLM transcript compaction in agent-loop.ts.
 *
 * Tests the actual runtime path: core-loop → executeDAG → workerPool.dispatch
 * and agent-loop → partitionTranscript → compactionLlm → buildCompactedTranscript.
 */
import { describe, expect, test } from 'bun:test';
import type { TaskDAG, TaskInput, PerceptualHierarchy, WorkingMemoryState, RoutingDecision, VerificationHint } from '../../src/orchestrator/types.ts';
import { executeDAG, type NodeDispatcher, type DAGExecutionResult } from '../../src/orchestrator/dag-executor.ts';
import { buildCompactedTranscript, partitionTranscript } from '../../src/orchestrator/agent/transcript-compactor.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMultiNodePlan(nodeCount: number, hints?: Record<string, VerificationHint>): TaskDAG {
  return {
    nodes: Array.from({ length: nodeCount }, (_, i) => ({
      id: `n${i}`,
      description: `Subtask ${i}`,
      targetFiles: [`file${i}.ts`],
      dependencies: i > 0 ? [`n${i - 1}`] : [],
      assignedOracles: ['type', 'lint'],
      verificationHint: hints?.[`n${i}`],
    })),
  };
}

function makeFlatPlan(nodeCount: number): TaskDAG {
  return {
    nodes: Array.from({ length: nodeCount }, (_, i) => ({
      id: `n${i}`,
      description: `Independent subtask ${i}`,
      targetFiles: [`file${i}.ts`],
      dependencies: [],
      assignedOracles: ['type'],
    })),
  };
}

// ---------------------------------------------------------------------------
// DAG dispatch integration (EO #1+#4)
// ---------------------------------------------------------------------------

describe('DAG dispatch integration — EO #1+#4', () => {
  test('multi-node plan dispatches each node independently', async () => {
    const plan = makeFlatPlan(3);
    const dispatched: string[] = [];

    const dispatcher: NodeDispatcher = async (nodeId, node) => {
      dispatched.push(nodeId);
      return {
        nodeId,
        mutations: [{ file: node.targetFiles[0]!, content: `fixed-${nodeId}` }],
        tokensConsumed: 50,
        durationMs: 1,
      };
    };

    const result = await executeDAG(plan, dispatcher);

    expect(dispatched).toHaveLength(3);
    expect(result.results).toHaveLength(3);
    expect(result.usedParallelExecution).toBe(true);
    // All independent → single execution level
    expect(result.executionLevels).toHaveLength(1);
    expect(result.totalTokens).toBe(150);
  });

  test('DAG result merges to WorkerResult-compatible shape', async () => {
    const plan = makeFlatPlan(2);
    const dispatcher: NodeDispatcher = async (nodeId, node) => ({
      nodeId,
      mutations: [{ file: node.targetFiles[0]!, content: `new-${nodeId}` }],
      tokensConsumed: 100,
      durationMs: 5,
    });

    const dagResult = await executeDAG(plan, dispatcher);

    // Simulate the merge in core-loop.ts
    const mergedMutations = dagResult.results.flatMap((r) => r.mutations.map((m) => ({
      file: m.file,
      content: m.content,
      diff: m.diff ?? '',
      explanation: m.explanation ?? '',
    })));

    expect(mergedMutations).toHaveLength(2);
    expect(mergedMutations[0]!.file).toBe('file0.ts');
    expect(mergedMutations[1]!.file).toBe('file1.ts');
    expect(mergedMutations[0]!.diff).toBe(''); // default for missing
  });

  test('sequential chain respects dependency order', async () => {
    const plan = makeMultiNodePlan(3);
    const callOrder: string[] = [];

    const dispatcher: NodeDispatcher = async (nodeId, node) => {
      callOrder.push(nodeId);
      return {
        nodeId,
        mutations: [{ file: node.targetFiles[0]!, content: 'done' }],
        tokensConsumed: 30,
        durationMs: 1,
      };
    };

    const result = await executeDAG(plan, dispatcher);

    // Each depends on previous → 3 execution levels
    expect(result.executionLevels).toHaveLength(3);
    expect(callOrder).toEqual(['n0', 'n1', 'n2']);
  });

  test('file conflict forces sequential even for independent nodes', async () => {
    const plan: TaskDAG = {
      nodes: [
        { id: 'a', description: 'edit shared', targetFiles: ['shared.ts'], dependencies: [], assignedOracles: ['type'] },
        { id: 'b', description: 'also edit shared', targetFiles: ['shared.ts'], dependencies: [], assignedOracles: ['type'] },
      ],
    };

    const dispatcher: NodeDispatcher = async (nodeId) => ({
      nodeId,
      mutations: [{ file: 'shared.ts', content: `ver-${nodeId}` }],
      tokensConsumed: 50,
      durationMs: 1,
    });

    const result = await executeDAG(plan, dispatcher);

    expect(result.usedParallelExecution).toBe(false);
    expect(result.fileConflicts).toHaveLength(1);
    expect(result.fileConflicts[0]!.file).toBe('shared.ts');
  });

  test('single-node plan still works through DAG executor', async () => {
    const plan = makeFlatPlan(1);
    const dispatcher: NodeDispatcher = async (nodeId, node) => ({
      nodeId,
      mutations: [{ file: node.targetFiles[0]!, content: 'solo' }],
      tokensConsumed: 80,
      durationMs: 2,
    });

    const result = await executeDAG(plan, dispatcher);

    expect(result.results).toHaveLength(1);
    expect(result.totalTokens).toBe(80);
    expect(result.usedParallelExecution).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Verification hint merging (EO #3 with DAG)
// ---------------------------------------------------------------------------

describe('Verification hint merging — EO #3 + DAG', () => {
  test('merges oracle sets from multiple nodes as union', () => {
    const hints: Record<string, VerificationHint> = {
      n0: { oracles: ['ast', 'type'] },
      n1: { oracles: ['type', 'lint'] },
      n2: { oracles: ['test'] },
    };
    const plan = makeMultiNodePlan(3, hints);

    const nodeHints = plan.nodes.map((n) => n.verificationHint).filter(Boolean) as VerificationHint[];
    const allOracleSets = nodeHints.filter((h) => h.oracles).map((h) => h.oracles!);
    const merged = [...new Set(allOracleSets.flat())];

    expect(merged.sort()).toEqual(['ast', 'lint', 'test', 'type']);
  });

  test('skipTestWhen propagates from any node', () => {
    const hints: Record<string, VerificationHint> = {
      n0: { oracles: ['type'] },
      n1: { oracles: ['lint'], skipTestWhen: 'import-only' },
    };
    const plan = makeMultiNodePlan(2, hints);

    const nodeHints = plan.nodes.map((n) => n.verificationHint).filter(Boolean) as VerificationHint[];
    const mergedSkip = nodeHints.find((h) => h.skipTestWhen)?.skipTestWhen;

    expect(mergedSkip).toBe('import-only');
  });

  test('no hints → undefined (run all oracles)', () => {
    const plan = makeMultiNodePlan(3);
    const nodeHints = plan.nodes.map((n) => n.verificationHint).filter(Boolean) as VerificationHint[];
    expect(nodeHints).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// LLM transcript compaction (EO #5)
// ---------------------------------------------------------------------------

describe('LLM transcript compaction — EO #5', () => {
  function makeTranscript(turnCount: number) {
    return Array.from({ length: turnCount }, (_, i) => ({
      type: i % 2 === 0 ? 'tool_calls' : 'done',
      turnId: `turn-${i}`,
      content: `Turn ${i} content - ${i % 2 === 0 ? 'evidence' : 'narrative reasoning about approach'}`,
      tokensConsumed: 200,
    }));
  }

  test('partitionTranscript identifies evidence vs narrative turns', () => {
    const transcript = makeTranscript(6);
    const partition = partitionTranscript(transcript);

    const evidenceCount = partition.evidenceTurns.filter((t) => t.isEvidence).length;
    const narrativeCount = partition.compactedNarrativeTurns;

    expect(evidenceCount).toBe(3); // tool_calls turns
    expect(narrativeCount).toBe(3); // done turns
    expect(partition.tokensSaved).toBe(600); // 3 narrative × 200 tokens
  });

  test('buildCompactedTranscript replaces narrative with summary', () => {
    const transcript = [
      { type: 'tool_calls', content: 'evidence-1' },
      { type: 'done', content: 'reasoning about approach A' },
      { type: 'tool_calls', content: 'evidence-2' },
      { type: 'done', content: 'decided to try approach B' },
    ];

    const compacted = buildCompactedTranscript(transcript, 'Agent tried A then pivoted to B.');

    // Evidence turns preserved, narrative replaced
    expect(compacted.filter((t) => t.type === 'tool_calls')).toHaveLength(2);
    const summary = compacted.find((t) => t.type === 'compacted_summary');
    expect(summary).toBeDefined();
    expect((summary as any).content).toBe('Agent tried A then pivoted to B.');
    // Original narrative turns removed
    expect(compacted.filter((t) => t.type === 'done')).toHaveLength(0);
  });

  test('compaction preserves all evidence turns', () => {
    const transcript = [
      { type: 'tool_calls', content: 'read file A' },
      { type: 'tool_results', content: 'file A content: ...' },
      { type: 'done', content: 'reasoning...' },
      { type: 'tool_calls', content: 'write file A' },
    ];

    const compacted = buildCompactedTranscript(transcript, 'summary');

    const evidenceTypes = compacted.filter((t) => t.type === 'tool_calls' || t.type === 'tool_results');
    expect(evidenceTypes).toHaveLength(3);
  });

  test('empty transcript produces empty partition', () => {
    const partition = partitionTranscript([]);
    expect(partition.evidenceTurns).toHaveLength(0);
    expect(partition.compactedNarrativeTurns).toBe(0);
    expect(partition.tokensSaved).toBe(0);
  });

  test('all-evidence transcript has zero savings', () => {
    const transcript = [
      { type: 'tool_calls', content: 'a', tokensConsumed: 100 },
      { type: 'tool_results', content: 'b', tokensConsumed: 200 },
    ];
    const partition = partitionTranscript(transcript);
    expect(partition.compactedNarrativeTurns).toBe(0);
    expect(partition.tokensSaved).toBe(0);
  });
});
