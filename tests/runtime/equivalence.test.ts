/**
 * Equivalence test — W3 P3 MVP proof that enabling `useBackendAbstraction`
 * for L0 leaves the WorkerPoolImpl.dispatch() return shape bit-equivalent to
 * the legacy path. This is the critical test: if this ever regresses, the
 * flag is no longer a safe opt-in.
 *
 * Also exercises LocalInprocBackend on a non-trivial ReasoningEngine path
 * to prove the adapter layer produces the RE response verbatim.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createMockProvider,
  createMockReasoningEngine,
} from '../../src/orchestrator/llm/mock-provider.ts';
import { LLMProviderRegistry } from '../../src/orchestrator/llm/provider-registry.ts';
import type {
  PerceptualHierarchy,
  RoutingDecision,
  TaskInput,
  WorkingMemoryState,
} from '../../src/orchestrator/types.ts';
import { WorkerPoolImpl } from '../../src/orchestrator/worker/worker-pool.ts';
import { BackendSelector } from '../../src/runtime/backend-selector.ts';
import { LocalInprocBackend } from '../../src/runtime/backends/local-inproc.ts';

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'vinyan-equiv-'));
  mkdirSync(join(tempDir, 'src'), { recursive: true });
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeInput(): TaskInput {
  return {
    id: 'equiv-1',
    source: 'cli',
    goal: 'no-op L0 task',
    taskType: 'code',
    targetFiles: ['src/foo.ts'],
    budget: { maxTokens: 0, maxDurationMs: 1000, maxRetries: 0 },
  };
}

function makePerception(): PerceptualHierarchy {
  return {
    taskTarget: { file: 'src/foo.ts', description: 'x' },
    dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
    diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
    verifiedFacts: [],
    runtime: { nodeVersion: 'v18', os: 'darwin', availableTools: ['file_read'] },
  };
}

function makeMemory(): WorkingMemoryState {
  return { failedApproaches: [], activeHypotheses: [], unresolvedUncertainties: [], scopedFacts: [] };
}

function makeRouting(level: 0 | 1 | 2 | 3 = 0): RoutingDecision {
  return {
    level,
    model: level === 0 ? null : 'mock-model',
    budgetTokens: level === 0 ? 0 : 10_000,
    latencyBudgetMs: 5_000,
  };
}

function makeRegistry(): LLMProviderRegistry {
  const registry = new LLMProviderRegistry();
  registry.register(createMockProvider({ id: 'mock/fast', tier: 'fast' }));
  registry.register(createMockProvider({ id: 'mock/balanced', tier: 'balanced' }));
  registry.register(createMockProvider({ id: 'mock/powerful', tier: 'powerful' }));
  return registry;
}

describe('WorkerBackend equivalence (MVP L0 opt-in)', () => {
  test('L0 dispatch with flag OFF produces the legacy empty-output shape', async () => {
    const pool = new WorkerPoolImpl({
      registry: makeRegistry(),
      workspace: tempDir,
      useSubprocess: false,
    });
    const out = await pool.dispatch(makeInput(), makePerception(), makeMemory(), undefined, makeRouting(0));
    expect(out.mutations).toEqual([]);
    expect(out.proposedToolCalls).toEqual([]);
    expect(out.tokensConsumed).toBe(0);
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('L0 dispatch with flag ON produces the same shape via LocalInprocBackend', async () => {
    const engine = createMockReasoningEngine({ id: 'mock-engine' });
    const selector = new BackendSelector({
      backends: [new LocalInprocBackend({ reasoningEngine: engine })],
    });
    const pool = new WorkerPoolImpl({
      registry: makeRegistry(),
      workspace: tempDir,
      useSubprocess: false,
      useBackendAbstraction: true,
      backendSelector: selector,
    });
    const out = await pool.dispatch(makeInput(), makePerception(), makeMemory(), undefined, makeRouting(0));
    expect(out.mutations).toEqual([]);
    expect(out.proposedToolCalls).toEqual([]);
    expect(out.tokensConsumed).toBe(0);
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('flag-ON and flag-OFF return byte-equivalent fields (modulo durationMs)', async () => {
    const legacyPool = new WorkerPoolImpl({
      registry: makeRegistry(),
      workspace: tempDir,
      useSubprocess: false,
    });
    const engine = createMockReasoningEngine({ id: 'mock-engine' });
    const selector = new BackendSelector({
      backends: [new LocalInprocBackend({ reasoningEngine: engine })],
    });
    const newPool = new WorkerPoolImpl({
      registry: makeRegistry(),
      workspace: tempDir,
      useSubprocess: false,
      useBackendAbstraction: true,
      backendSelector: selector,
    });

    const legacy = await legacyPool.dispatch(
      makeInput(),
      makePerception(),
      makeMemory(),
      undefined,
      makeRouting(0),
    );
    const next = await newPool.dispatch(
      makeInput(),
      makePerception(),
      makeMemory(),
      undefined,
      makeRouting(0),
    );

    // durationMs will differ because the backend path exercises spawn /
    // teardown. All other fields must match byte-for-byte.
    const { durationMs: _a, ...legacyFields } = legacy;
    const { durationMs: _b, ...nextFields } = next;
    expect(nextFields).toEqual(legacyFields);
  });

  test('LocalInprocBackend.execute returns engine content + toolCalls verbatim', async () => {
    const engine = createMockReasoningEngine({
      id: 'mock-engine',
      responseContent: 'verbatim',
    });
    const backend = new LocalInprocBackend({ reasoningEngine: engine });
    const handle = await backend.spawn({
      taskId: 'eq-engine-1',
      routingLevel: 0,
      workspace: { host: tempDir, readonly: true },
      networkPolicy: 'deny-all',
      resourceLimits: { cpuMs: 0, memMB: 0, fdMax: 0 },
      log: () => {},
    });
    const out = await backend.execute(handle, {
      taskId: 'eq-engine-1',
      prompt: 'do a thing',
      budget: { tokens: 100, timeMs: 1000 },
    });
    expect(out.ok).toBe(true);
    const output = out.output as { content: string; engineId: string };
    expect(output.content).toBe('verbatim');
    expect(output.engineId).toBe('mock-engine');
    expect(out.tokensUsed).toBe(150); // mock provider: input=100, output=50
  });

  test('Selector failure under opt-in degrades gracefully to legacy shape', async () => {
    // Empty selector — .select(0) throws because local-inproc isn't registered.
    // The pool must swallow and return the legacy empty-output shape.
    const selector = new BackendSelector({ backends: [] });
    const pool = new WorkerPoolImpl({
      registry: makeRegistry(),
      workspace: tempDir,
      useSubprocess: false,
      useBackendAbstraction: true,
      backendSelector: selector,
    });
    const out = await pool.dispatch(makeInput(), makePerception(), makeMemory(), undefined, makeRouting(0));
    expect(out.mutations).toEqual([]);
    expect(out.proposedToolCalls).toEqual([]);
    expect(out.tokensConsumed).toBe(0);
  });
});
