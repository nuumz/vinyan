import { describe, expect, test } from 'bun:test';
import { createMockProvider } from '../../src/orchestrator/llm/mock-provider.ts';
import { LLMProviderRegistry } from '../../src/orchestrator/llm/provider-registry.ts';
import { TaskDecomposerImpl } from '../../src/orchestrator/task-decomposer.ts';
import type { PerceptualHierarchy, TaskInput, WorkingMemoryState } from '../../src/orchestrator/types.ts';

function makeInput(): TaskInput {
  return {
    id: 'task-fallback',
    source: 'cli',
    goal: 'fix the bug',
    taskType: 'code',
    targetFiles: ['src/foo.ts'],
    budget: { maxTokens: 10000, maxRetries: 3, maxDurationMs: 60000 },
  };
}

function makePerception(): PerceptualHierarchy {
  return {
    taskTarget: { file: 'src/foo.ts', description: 'fix' },
    dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
    diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
    verifiedFacts: [],
    runtime: { nodeVersion: '18.0.0', os: 'darwin', availableTools: [] },
  };
}

function makeMemory(): WorkingMemoryState {
  return {
    failedApproaches: [],
    activeHypotheses: [],
    unresolvedUncertainties: [],
    scopedFacts: [],
  };
}

const VALID_DAG_JSON = JSON.stringify({
  nodes: [
    { id: 'n1', description: 'fix foo', targetFiles: ['src/foo.ts'], dependencies: [], assignedOracles: ['type'] },
  ],
});

describe('TaskDecomposerImpl — isFallback (WU12)', () => {
  test('empty registry → fallback DAG with isFallback: true', async () => {
    const registry = new LLMProviderRegistry();
    const decomposer = new TaskDecomposerImpl({ registry });

    const dag = await decomposer.decompose(makeInput(), makePerception(), makeMemory());

    expect(dag.isFallback).toBe(true);
    expect(dag.nodes).toHaveLength(1);
    expect(dag.nodes[0]!.description).toBe('fix the bug');
  });

  test('successful LLM parse → isFallback is not true', async () => {
    const registry = new LLMProviderRegistry();
    registry.register(createMockProvider({ tier: 'balanced', responseContent: VALID_DAG_JSON }));

    const decomposer = new TaskDecomposerImpl({ registry });
    const dag = await decomposer.decompose(makeInput(), makePerception(), makeMemory());

    expect(dag.isFallback).not.toBe(true);
    expect(dag.nodes).toHaveLength(1);
  });
});
