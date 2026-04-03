import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createMockProvider } from '../../../src/orchestrator/llm/mock-provider.ts';
import { LLMProviderRegistry } from '../../../src/orchestrator/llm/provider-registry.ts';
import type {
  PerceptualHierarchy,
  PerceptionRole,
  RoutingDecision,
  TaskInput,
  WorkingMemoryState,
} from '../../../src/orchestrator/types.ts';
import { createUnifiedDiff, pruneForRole, WorkerPoolImpl } from '../../../src/orchestrator/worker/worker-pool.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'vinyan-worker-test-'));
  mkdirSync(join(tempDir, 'src'), { recursive: true });
  writeFileSync(join(tempDir, 'src', 'foo.ts'), 'export const x = 1;\n');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeInput(overrides?: Partial<TaskInput>): TaskInput {
  return {
    id: 't-1',
    source: 'cli',
    goal: 'Fix bug',
    taskType: 'code',
    targetFiles: ['src/foo.ts'],
    budget: { maxTokens: 50_000, maxDurationMs: 60_000, maxRetries: 3 },
    ...overrides,
  };
}

function makePerception(): PerceptualHierarchy {
  return {
    taskTarget: { file: 'src/foo.ts', description: 'Fix bug' },
    dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
    diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
    verifiedFacts: [],
    runtime: { nodeVersion: 'v18', os: 'darwin', availableTools: ['file_read'] },
  };
}

function makeMemory(): WorkingMemoryState {
  return { failedApproaches: [], activeHypotheses: [], unresolvedUncertainties: [], scopedFacts: [] };
}

function makeRouting(level: 0 | 1 | 2 | 3): RoutingDecision {
  return {
    level,
    model: level === 0 ? null : 'mock-model',
    budgetTokens: level === 0 ? 0 : 10_000,
    latencyBudgetMs: 5_000,
  };
}

function makeRegistry(options?: { shouldFail?: boolean; latencyMs?: number; responseContent?: string }) {
  const registry = new LLMProviderRegistry();
  registry.register(
    createMockProvider({
      id: 'mock/fast',
      tier: 'fast',
      ...options,
    }),
  );
  registry.register(
    createMockProvider({
      id: 'mock/balanced',
      tier: 'balanced',
      ...options,
    }),
  );
  registry.register(
    createMockProvider({
      id: 'mock/powerful',
      tier: 'powerful',
      ...options,
    }),
  );
  return registry;
}

describe('WorkerPoolImpl', () => {
  test('L0 dispatch returns empty result — no LLM call', async () => {
    const pool = new WorkerPoolImpl({ registry: makeRegistry(), workspace: tempDir, useSubprocess: false });
    const result = await pool.dispatch(makeInput(), makePerception(), makeMemory(), undefined, makeRouting(0));
    expect(result.mutations).toHaveLength(0);
    expect(result.tokensConsumed).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('L1 dispatch with mock provider returns structured result', async () => {
    const content = JSON.stringify({
      proposedMutations: [{ file: 'src/foo.ts', content: 'export const x = 2;\n', explanation: 'fix value' }],
      proposedToolCalls: [],
      uncertainties: [],
    });
    const pool = new WorkerPoolImpl({
      registry: makeRegistry({ responseContent: content }),
      workspace: tempDir,
      useSubprocess: false,
    });
    const result = await pool.dispatch(makeInput(), makePerception(), makeMemory(), undefined, makeRouting(1));
    expect(result.mutations).toHaveLength(1);
    expect(result.mutations[0]!.file).toBe('src/foo.ts');
    expect(result.mutations[0]!.content).toBe('export const x = 2;\n');
    expect(result.mutations[0]!.explanation).toBe('fix value');
    expect(result.tokensConsumed).toBe(150); // 100 input + 50 output from mock
  });

  test('L1 dispatch computes diff for existing file', async () => {
    const content = JSON.stringify({
      proposedMutations: [{ file: 'src/foo.ts', content: 'export const x = 2;\n', explanation: 'change value' }],
      proposedToolCalls: [],
      uncertainties: [],
    });
    const pool = new WorkerPoolImpl({
      registry: makeRegistry({ responseContent: content }),
      workspace: tempDir,
      useSubprocess: false,
    });
    const result = await pool.dispatch(makeInput(), makePerception(), makeMemory(), undefined, makeRouting(1));
    expect(result.mutations[0]!.diff).toContain('--- a/src/foo.ts');
    expect(result.mutations[0]!.diff).toContain('+++ b/src/foo.ts');
    expect(result.mutations[0]!.diff).toContain('-export const x = 1;');
    expect(result.mutations[0]!.diff).toContain('+export const x = 2;');
  });

  test('L1 dispatch computes diff for new file', async () => {
    const content = JSON.stringify({
      proposedMutations: [{ file: 'src/new.ts', content: 'export const y = 1;\n', explanation: 'new file' }],
      proposedToolCalls: [],
      uncertainties: [],
    });
    const pool = new WorkerPoolImpl({
      registry: makeRegistry({ responseContent: content }),
      workspace: tempDir,
      useSubprocess: false,
    });
    const result = await pool.dispatch(makeInput(), makePerception(), makeMemory(), undefined, makeRouting(1));
    expect(result.mutations[0]!.diff).toContain('@@ -0,0 +1,');
    expect(result.mutations[0]!.diff).toContain('+export const y = 1;');
  });

  test('timeout returns empty result', async () => {
    const pool = new WorkerPoolImpl({
      registry: makeRegistry({ latencyMs: 5000 }),
      workspace: tempDir,
      useSubprocess: false,
    });
    const routing = makeRouting(1);
    routing.latencyBudgetMs = 50; // Very short timeout
    const result = await pool.dispatch(makeInput(), makePerception(), makeMemory(), undefined, routing);
    expect(result.mutations).toHaveLength(0);
  });

  test('provider failure returns empty result gracefully', async () => {
    const pool = new WorkerPoolImpl({
      registry: makeRegistry({ shouldFail: true }),
      workspace: tempDir,
      useSubprocess: false,
    });
    const result = await pool.dispatch(makeInput(), makePerception(), makeMemory(), undefined, makeRouting(1));
    expect(result.mutations).toHaveLength(0);
    expect(result.tokensConsumed).toBe(0);
  });

  test('non-JSON LLM response returns empty mutations', async () => {
    const pool = new WorkerPoolImpl({
      registry: makeRegistry({ responseContent: 'I cannot help with that.' }),
      workspace: tempDir,
      useSubprocess: false,
    });
    const result = await pool.dispatch(makeInput(), makePerception(), makeMemory(), undefined, makeRouting(1));
    expect(result.mutations).toHaveLength(0);
    expect(result.tokensConsumed).toBe(150); // tokens still counted
  });

  test('no provider for routing level returns empty result', async () => {
    const registry = new LLMProviderRegistry(); // empty registry
    const pool = new WorkerPoolImpl({ registry, workspace: tempDir, useSubprocess: false });
    const result = await pool.dispatch(makeInput(), makePerception(), makeMemory(), undefined, makeRouting(1));
    expect(result.mutations).toHaveLength(0);
    expect(result.tokensConsumed).toBe(0);
  });
});

describe('createUnifiedDiff', () => {
  test('identical content returns empty string', () => {
    expect(createUnifiedDiff('f.ts', 'hello', 'hello')).toBe('');
  });

  test('new file diff has +0,0 header', () => {
    const diff = createUnifiedDiff('f.ts', '', 'line1\nline2\n');
    expect(diff).toContain('@@ -0,0 +1,');
    expect(diff).toContain('+line1');
  });

  test('delete file diff has -1,N header', () => {
    const diff = createUnifiedDiff('f.ts', 'line1\n', '');
    expect(diff).toContain('@@ -1,');
    expect(diff).toContain('-line1');
  });
});

// ── EO #2: Epistemic Information Barriers ─────────────────────────────

describe('pruneForRole — EO #2 Information Barriers', () => {
  function fullPerception(): PerceptualHierarchy {
    return {
      taskTarget: { file: 'src/foo.ts', description: 'Fix bug' },
      dependencyCone: {
        directImporters: ['src/bar.ts'],
        directImportees: ['src/baz.ts'],
        transitiveBlastRadius: 5,
        transitiveImporters: ['src/deep.ts'],
        affectedTestFiles: ['tests/foo.test.ts'],
      },
      diagnostics: {
        lintWarnings: [{ file: 'src/foo.ts', line: 1, message: 'no-unused-vars' }],
        typeErrors: [{ file: 'src/foo.ts', line: 2, message: 'Type error' }],
        failingTests: ['tests/foo.test.ts'],
      },
      verifiedFacts: [],
      runtime: { nodeVersion: 'v18', os: 'darwin', availableTools: ['file_read'] },
      causalEdges: [{ source: 'src/a.ts', target: 'src/b.ts', type: 'import', weight: 1.0 }] as any,
    };
  }

  function fullMemory(): WorkingMemoryState {
    return {
      failedApproaches: [
        {
          approach: 'add null check',
          oracleVerdict: 'test oracle: 3 tests failed — TypeError at line 42, expected string got undefined',
          timestamp: Date.now(),
          verdictConfidence: 0.92,
          failureOracle: 'test',
        },
        {
          approach: 'wrap in try-catch',
          oracleVerdict: 'type oracle: TS2345 — Argument of type number is not assignable to string',
          timestamp: Date.now(),
        },
      ],
      activeHypotheses: [{ hypothesis: 'missing null check', confidence: 0.8, source: 'generator' }],
      unresolvedUncertainties: [],
      scopedFacts: [],
      priorAttempts: [{ taskId: 't-0', outcome: 'failed', summary: 'first attempt' }] as any,
    };
  }

  test('generator role strips detailed oracle verdict text', () => {
    const { memory } = pruneForRole(fullPerception(), fullMemory(), 'generator', 2);
    expect(memory.failedApproaches[0]!.oracleVerdict).toBe('Failed: test oracle');
    expect(memory.failedApproaches[1]!.oracleVerdict).toBe('Failed: verification');
  });

  test('generator role preserves verdictConfidence and failureOracle', () => {
    const { memory } = pruneForRole(fullPerception(), fullMemory(), 'generator', 2);
    expect(memory.failedApproaches[0]!.verdictConfidence).toBe(0.92);
    expect(memory.failedApproaches[0]!.failureOracle).toBe('test');
  });

  test('generator L0/L1 strips transitive deps, causal edges, lint warnings', () => {
    const { perception } = pruneForRole(fullPerception(), fullMemory(), 'generator', 1);
    expect(perception.dependencyCone.transitiveImporters).toBeUndefined();
    expect(perception.dependencyCone.affectedTestFiles).toBeUndefined();
    expect(perception.diagnostics.lintWarnings).toHaveLength(0);
    expect(perception.diagnostics.failingTests).toHaveLength(0);
    expect(perception.causalEdges).toBeUndefined();
    // Direct deps preserved
    expect(perception.dependencyCone.directImporters).toEqual(['src/bar.ts']);
    // Type errors preserved
    expect(perception.diagnostics.typeErrors).toHaveLength(1);
  });

  test('generator L2+ preserves full perception', () => {
    const original = fullPerception();
    const { perception } = pruneForRole(original, fullMemory(), 'generator', 2);
    expect(perception.dependencyCone.transitiveImporters).toEqual(['src/deep.ts']);
    expect(perception.dependencyCone.affectedTestFiles).toEqual(['tests/foo.test.ts']);
    expect(perception.diagnostics.lintWarnings).toHaveLength(1);
    expect(perception.causalEdges).toBeDefined();
  });

  test('critic role strips priorAttempts', () => {
    const { memory, perception } = pruneForRole(fullPerception(), fullMemory(), 'critic', 2);
    expect(memory.priorAttempts).toBeUndefined();
    // Critic keeps full perception
    expect(perception.diagnostics.lintWarnings).toHaveLength(1);
    // Critic keeps full failedApproaches (unmodified verdict text)
    expect(memory.failedApproaches[0]!.oracleVerdict).toContain('test oracle: 3 tests failed');
  });

  test('testgen role returns full context unchanged', () => {
    const p = fullPerception();
    const m = fullMemory();
    const { perception, memory } = pruneForRole(p, m, 'testgen', 2);
    expect(perception).toBe(p); // same reference — no copy
    expect(memory).toBe(m);
  });

  test('backwards compatible: works with old failedApproaches without verdictConfidence', () => {
    const mem = fullMemory();
    // Simulate old format — no verdictConfidence or failureOracle
    mem.failedApproaches = [
      { approach: 'old approach', oracleVerdict: 'some old verdict', timestamp: Date.now() },
    ];
    const { memory } = pruneForRole(fullPerception(), mem, 'generator', 2);
    expect(memory.failedApproaches[0]!.oracleVerdict).toBe('Failed: verification');
    expect(memory.failedApproaches[0]!.verdictConfidence).toBeUndefined();
    expect(memory.failedApproaches[0]!.failureOracle).toBeUndefined();
  });
});
