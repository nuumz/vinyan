import { describe, expect, test } from 'bun:test';
import { createMockProvider } from '../../src/orchestrator/llm/mock-provider.ts';
import { LLMProviderRegistry } from '../../src/orchestrator/llm/provider-registry.ts';
import { TaskDecomposerImpl } from '../../src/orchestrator/task-decomposer.ts';
import type { PerceptualHierarchy, TaskInput, WorkingMemoryState } from '../../src/orchestrator/types.ts';

function makeInput(): TaskInput {
  return {
    id: 'task-001',
    source: 'cli',
    goal: 'refactor auth module',
    targetFiles: ['src/auth.ts'],
    budget: { maxTokens: 10000, maxRetries: 3, maxDurationMs: 60000 },
  };
}

function makePerception(): PerceptualHierarchy {
  return {
    taskTarget: { file: 'src/auth.ts', description: 'refactor' },
    dependencyCone: {
      directImporters: ['src/app.ts'],
      directImportees: ['src/db.ts'],
      transitiveBlastRadius: 3,
    },
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
    {
      id: 'n1',
      description: 'extract interface',
      targetFiles: ['src/auth.ts'],
      dependencies: [],
      assignedOracles: ['type'],
    },
    {
      id: 'n2',
      description: 'update db layer',
      targetFiles: ['src/db.ts'],
      dependencies: ['n1'],
      assignedOracles: ['type', 'dep'],
    },
  ],
});

describe('TaskDecomposerImpl', () => {
  test('successful decomposition with valid DAG from LLM', async () => {
    const registry = new LLMProviderRegistry();
    registry.register(createMockProvider({ tier: 'balanced', responseContent: VALID_DAG_JSON }));

    const decomposer = new TaskDecomposerImpl({ registry });
    const dag = await decomposer.decompose(makeInput(), makePerception(), makeMemory());

    expect(dag.nodes).toHaveLength(2);
    expect(dag.nodes[0]!.id).toBe('n1');
    expect(dag.nodes[1]!.dependencies).toEqual(['n1']);
  });

  test('LLM returns markdown-wrapped JSON → still parsed', async () => {
    const wrapped = `\`\`\`json\n${VALID_DAG_JSON}\n\`\`\``;
    const registry = new LLMProviderRegistry();
    registry.register(createMockProvider({ tier: 'balanced', responseContent: wrapped }));

    const decomposer = new TaskDecomposerImpl({ registry });
    const dag = await decomposer.decompose(makeInput(), makePerception(), makeMemory());

    expect(dag.nodes).toHaveLength(2);
  });

  test('invalid JSON → retries then fallback to single-node DAG', async () => {
    const registry = new LLMProviderRegistry();
    registry.register(createMockProvider({ tier: 'balanced', responseContent: 'not json at all' }));

    const decomposer = new TaskDecomposerImpl({ registry, maxRetries: 2 });
    const dag = await decomposer.decompose(makeInput(), makePerception(), makeMemory());

    // Fallback: single node wrapping the goal
    expect(dag.nodes).toHaveLength(1);
    expect(dag.nodes[0]!.description).toBe('refactor auth module');
    expect(dag.nodes[0]!.assignedOracles).toEqual(['type', 'dep']);
  });

  test('DAG with cycle → retries then fallback', async () => {
    const cyclicDag = JSON.stringify({
      nodes: [
        { id: 'n1', description: 'a', targetFiles: ['src/auth.ts'], dependencies: ['n2'], assignedOracles: ['type'] },
        { id: 'n2', description: 'b', targetFiles: ['src/db.ts'], dependencies: ['n1'], assignedOracles: ['type'] },
      ],
    });
    const registry = new LLMProviderRegistry();
    registry.register(createMockProvider({ tier: 'balanced', responseContent: cyclicDag }));

    const decomposer = new TaskDecomposerImpl({ registry, maxRetries: 2 });
    const dag = await decomposer.decompose(makeInput(), makePerception(), makeMemory());

    expect(dag.nodes).toHaveLength(1); // fallback
  });

  test('no LLM provider → immediate fallback', async () => {
    const registry = new LLMProviderRegistry();

    const decomposer = new TaskDecomposerImpl({ registry });
    const dag = await decomposer.decompose(makeInput(), makePerception(), makeMemory());

    expect(dag.nodes).toHaveLength(1);
    expect(dag.nodes[0]!.description).toBe('refactor auth module');
  });

  test('LLM provider throws → retries then fallback', async () => {
    const registry = new LLMProviderRegistry();
    registry.register(createMockProvider({ tier: 'balanced', shouldFail: true }));

    const decomposer = new TaskDecomposerImpl({ registry, maxRetries: 2 });
    const dag = await decomposer.decompose(makeInput(), makePerception(), makeMemory());

    expect(dag.nodes).toHaveLength(1); // fallback
  });

  test('failed approaches included in memory feedback', async () => {
    let capturedPrompt = '';
    const registry = new LLMProviderRegistry();
    registry.register({
      id: 'mock/capture',
      tier: 'balanced',
      async generate(req) {
        capturedPrompt = req.userPrompt;
        return {
          content: VALID_DAG_JSON,
          toolCalls: [],
          tokensUsed: { input: 100, output: 50 },
          model: 'mock/capture',
          stopReason: 'end_turn' as const,
        };
      },
    });

    const memory: WorkingMemoryState = {
      failedApproaches: [{ approach: 'direct edit', oracleVerdict: 'type errors', timestamp: Date.now() }],
      activeHypotheses: [],
      unresolvedUncertainties: [],
      scopedFacts: [],
    };

    const decomposer = new TaskDecomposerImpl({ registry });
    await decomposer.decompose(makeInput(), makePerception(), memory);

    expect(capturedPrompt).toContain('direct edit');
    expect(capturedPrompt).toContain('type errors');
  });
});
