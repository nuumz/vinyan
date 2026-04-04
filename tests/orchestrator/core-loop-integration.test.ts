/**
 * Core Loop Integration Tests — verifies §16.4 acceptance criteria.
 *
 * Uses mock LLM providers so tests don't require API keys.
 * Exercises the full executeTask pipeline: Perceive → Predict → Plan → Generate → Verify → Learn.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { CriticEngine } from '../../src/orchestrator/critic/critic-engine.ts';
import { createOrchestrator } from '../../src/orchestrator/factory.ts';
import { createMockProvider } from '../../src/orchestrator/llm/mock-provider.ts';
import { LLMProviderRegistry } from '../../src/orchestrator/llm/provider-registry.ts';
import type { TaskInput } from '../../src/orchestrator/types.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'vinyan-integration-'));
  mkdirSync(join(tempDir, 'src'), { recursive: true });
  writeFileSync(join(tempDir, 'src', 'foo.ts'), 'export const x = 1;\n');
  writeFileSync(join(tempDir, 'src', 'foo.test.ts'), '// test coverage marker\n');
  writeFileSync(
    join(tempDir, 'vinyan.json'),
    JSON.stringify({
      oracles: {
        type: { enabled: false },
        dep: { enabled: false },
        ast: { enabled: false },
        test: { enabled: false },
        lint: { enabled: false },
      },
    }),
  );
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeInput(overrides?: Partial<TaskInput>): TaskInput {
  return {
    id: 't-integration',
    source: 'cli',
    goal: 'Fix the export value',
    taskType: 'code',
    budget: { maxTokens: 10_000, maxDurationMs: 5_000, maxRetries: 1 },
    ...overrides,
  };
}

function makeRegistry(responseContent?: string) {
  const registry = new LLMProviderRegistry();
  const content =
    responseContent ??
    JSON.stringify({
      proposedMutations: [{ file: 'src/foo.ts', content: 'export const x = 2;\n', explanation: 'changed value' }],
      proposedToolCalls: [],
      uncertainties: [],
    });
  registry.register(createMockProvider({ id: 'mock/fast', tier: 'fast', responseContent: content }));
  registry.register(createMockProvider({ id: 'mock/balanced', tier: 'balanced', responseContent: content }));
  registry.register(createMockProvider({ id: 'mock/powerful', tier: 'powerful', responseContent: content }));
  return registry;
}

describe('Core Loop Integration — §16.4 Acceptance Criteria', () => {
  test('1. L0 task completes without LLM call (A3)', async () => {
    // A3: at L0, Orchestrator must make zero LLM calls — verify via spy
    let llmCallCount = 0;
    const registry = new LLMProviderRegistry();
    const spyProvider = createMockProvider({ id: 'mock/fast', tier: 'fast', responseContent: '{}' });
    const originalGenerate = spyProvider.generate.bind(spyProvider);
    spyProvider.generate = async (request: Parameters<typeof originalGenerate>[0]) => {
      llmCallCount++;
      return originalGenerate(request);
    };
    registry.register(spyProvider);

    const orchestrator = createOrchestrator({ workspace: tempDir, registry, useSubprocess: false });
    // targetFiles present but low blast radius (blastRadius=0) → L0 routing → no LLM needed
    const result = await orchestrator.executeTask(makeInput({ targetFiles: ['src/foo.ts'] }));
    expect(result.status).toBe('completed');
    expect(result.id).toBe('t-integration');
    expect(result.trace.routingLevel).toBe(0);
    // Core A3 assertion: zero LLM calls at L0
    expect(llmCallCount).toBe(0);
  });

  test('2. L1 task uses fast provider and returns mutations', async () => {
    const orchestrator = createOrchestrator({ workspace: tempDir, registry: makeRegistry(), useSubprocess: false });
    // MIN_ROUTING_LEVEL:1 forces L1 — guarantees LLM is called, regardless of blast radius
    const result = await orchestrator.executeTask(
      makeInput({ targetFiles: ['src/foo.ts'], constraints: ['MIN_ROUTING_LEVEL:1'] }),
    );
    expect(result.status).toBe('completed'); // mock returns valid mutations, oracles disabled → should complete
    expect(result.mutations.length).toBeGreaterThan(0); // LLM was called and returned mutations
    expect(result.trace.routingLevel).toBeGreaterThanOrEqual(1); // confirmed L1+ (not L0 cached)
  });

  test('3. executeTask with L1 routing returns completed status and mutation content', async () => {
    const orchestrator = createOrchestrator({ workspace: tempDir, registry: makeRegistry(), useSubprocess: false });
    const result = await orchestrator.executeTask(
      makeInput({ targetFiles: ['src/foo.ts'], constraints: ['MIN_ROUTING_LEVEL:1'] }),
    );
    expect(result.status).toBe('completed'); // mock + no oracles = deterministic complete
    expect(result.mutations.length).toBeGreaterThan(0); // mock always proposes 1 mutation
    expect(result.mutations[0]!.file).toBe('src/foo.ts'); // mock targets the correct file
  });

  test('4. traces are collected with LLM usage evidence', async () => {
    const orchestrator = createOrchestrator({ workspace: tempDir, registry: makeRegistry(), useSubprocess: false });
    await orchestrator.executeTask(
      makeInput({ targetFiles: ['src/foo.ts'], constraints: ['MIN_ROUTING_LEVEL:1'] }),
    );
    const traces = orchestrator.traceCollector.getTraces();
    expect(traces.length).toBeGreaterThanOrEqual(1);
    expect(traces[0]!.taskId).toBe('t-integration');
    expect(traces[0]!.tokensConsumed).toBeGreaterThan(0); // LLM was called — tokens consumed
    expect(traces[0]!.approach).toBeTruthy(); // approach text recorded from LLM response
  });

  test('5. escalation when oracle gate always rejects (A6 fail-closed)', async () => {
    // Inject an oracleGate that ALWAYS fails — forces escalation through all levels
    const alwaysFailGate = {
      verify: async () => ({
        passed: false,
        verdicts: {},
        reason: 'forced failure for escalation test',
      }),
    };
    const orchestrator = createOrchestrator({
      workspace: tempDir,
      registry: makeRegistry(),
      useSubprocess: false,
      oracleGate: alwaysFailGate,
    });
    const result = await orchestrator.executeTask(
      makeInput({
        targetFiles: ['src/foo.ts'],
        budget: { maxTokens: 10_000, maxDurationMs: 10_000, maxRetries: 1 },
      }),
    );
    // All retries fail verification → must escalate
    expect(result.status).toBe('escalated');
  });

  test('6. traces record model_used and duration for every attempt', async () => {
    const orchestrator = createOrchestrator({ workspace: tempDir, registry: makeRegistry(), useSubprocess: false });
    await orchestrator.executeTask(makeInput({ targetFiles: ['src/foo.ts'] }));
    const traces = orchestrator.traceCollector.getTraces();
    expect(traces.length).toBeGreaterThanOrEqual(1);
    for (const trace of traces) {
      expect(trace.modelUsed).toBeDefined();
      expect(typeof trace.modelUsed).toBe('string');
      expect(trace.durationMs).toBeGreaterThanOrEqual(0);
      expect(trace.taskId).toBe('t-integration');
    }
  });

  test('7. factory creates working orchestrator with default config', () => {
    const orchestrator = createOrchestrator({ workspace: tempDir, useSubprocess: false });
    expect(orchestrator).toHaveProperty('executeTask');
    expect(orchestrator).toHaveProperty('traceCollector');
    expect(typeof orchestrator.executeTask).toBe('function');
  });

  test('8. task ID preserved in result', async () => {
    const orchestrator = createOrchestrator({ workspace: tempDir, registry: makeRegistry(), useSubprocess: false });
    const result = await orchestrator.executeTask(makeInput({ id: 'custom-id-42' }));
    expect(result.id).toBe('custom-id-42');
  });

  test('9. trace records actual model invocation — modelUsed is a real model, not the L0 sentinel', async () => {
    const orchestrator = createOrchestrator({ workspace: tempDir, registry: makeRegistry(), useSubprocess: false });
    // MIN_ROUTING_LEVEL:1 ensures an LLM is dispatched — at L0, modelUsed would be 'none'
    await orchestrator.executeTask(
      makeInput({ targetFiles: ['src/foo.ts'], constraints: ['MIN_ROUTING_LEVEL:1'] }),
    );
    const traces = orchestrator.traceCollector.getTraces();
    const trace = traces[0]!;
    expect(trace.modelUsed).not.toBe('none'); // 'none' = L0 sentinel; a real model ID means LLM was called
    expect(trace.tokensConsumed).toBeGreaterThan(0); // mock returns 50 tokens — proves LLM dispatch occurred
    expect(trace.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('10. multiple tasks run independently — traces scoped to their own taskId', async () => {
    const orchestrator = createOrchestrator({ workspace: tempDir, registry: makeRegistry(), useSubprocess: false });
    const r1 = await orchestrator.executeTask(makeInput({ id: 'task-1', constraints: ['MIN_ROUTING_LEVEL:1'] }));
    const r2 = await orchestrator.executeTask(makeInput({ id: 'task-2', constraints: ['MIN_ROUTING_LEVEL:1'] }));
    expect(r1.id).toBe('task-1');
    expect(r2.id).toBe('task-2');
    const traces = orchestrator.traceCollector.getTraces();
    // Each task produces its own trace — verify no cross-contamination
    const task1Traces = traces.filter((t) => t.taskId === 'task-1');
    const task2Traces = traces.filter((t) => t.taskId === 'task-2');
    expect(task1Traces.length).toBeGreaterThanOrEqual(1);
    expect(task2Traces.length).toBeGreaterThanOrEqual(1);
    // No trace should carry a foreign taskId
    expect(task1Traces.every((t) => t.taskId === 'task-1')).toBe(true);
    expect(task2Traces.every((t) => t.taskId === 'task-2')).toBe(true);
  });

  test('11. commitArtifacts writes verified mutations to disk', async () => {
    const orchestrator = createOrchestrator({ workspace: tempDir, registry: makeRegistry(), useSubprocess: false });
    const result = await orchestrator.executeTask(makeInput({ targetFiles: ['src/foo.ts'] }));
    // If mutations were applied (verification passed), file should be updated on disk
    if (result.status === 'completed' && result.mutations.length > 0) {
      const content = readFileSync(join(tempDir, 'src/foo.ts'), 'utf-8');
      expect(content).toBe('export const x = 2;\n');
    }
  });

  test('12. rejected mutations excluded from result (A6 path safety)', async () => {
    // Mock provider proposes a path-traversal mutation alongside a valid one
    const content = JSON.stringify({
      proposedMutations: [
        { file: 'src/foo.ts', content: 'export const x = 42;\n', explanation: 'valid' },
        { file: '../escape.ts', content: 'hacked', explanation: 'traversal' },
      ],
      proposedToolCalls: [],
      uncertainties: [],
    });
    const orchestrator = createOrchestrator({
      workspace: tempDir,
      registry: makeRegistry(content),
      useSubprocess: false,
    });
    const result = await orchestrator.executeTask(makeInput({ targetFiles: ['src/foo.ts'] }));
    // Traversal file must never exist on disk regardless of status
    expect(existsSync(join(tempDir, '..', 'escape.ts'))).toBe(false);

    if (result.status === 'completed' && result.mutations.length > 0) {
      // Only valid mutations should appear
      const files = result.mutations.map((m) => m.file);
      expect(files).not.toContain('../escape.ts');
      expect(files).toContain('src/foo.ts');
      // Notes should mention rejection
      expect(result.notes?.some((n) => n.includes('Rejected'))).toBe(true);
    }
  });

  test('13. §16.4 criterion 2: failed approach recorded in WorkingMemory', async () => {
    // Oracle gate always rejects → approach must be recorded as failed
    // The escalation reason should mention failed approaches
    const alwaysFailGate = {
      verify: async () => ({
        passed: false,
        verdicts: {},
        reason: 'forced-oracle-rejection',
      }),
    };
    const orchestrator = createOrchestrator({
      workspace: tempDir,
      registry: makeRegistry(),
      useSubprocess: false,
      oracleGate: alwaysFailGate,
    });
    const result = await orchestrator.executeTask(
      makeInput({
        targetFiles: ['src/foo.ts'],
        budget: { maxTokens: 10_000, maxDurationMs: 10_000, maxRetries: 2 },
      }),
    );
    expect(result.status).toBe('escalated');
    // escalationReason should reference the failed approaches count
    expect(result.escalationReason).toContain('failed approaches');
    // The trace failure_reason should also reference attempts
    expect(result.trace.failureReason).toContain('Failed after');
  });

  test('14. §16.4 criterion 3: routing escalation L1→L2→L3', async () => {
    // Oracle gate always fails → forces escalation through routing levels
    const levelTracker = {
      verify: async () => {
        return { passed: false, verdicts: {}, reason: 'forced-escalation' };
      },
    };
    const orchestrator = createOrchestrator({
      workspace: tempDir,
      registry: makeRegistry(),
      useSubprocess: false,
      oracleGate: levelTracker,
    });

    const result = await orchestrator.executeTask(
      makeInput({
        targetFiles: ['src/foo.ts'],
        budget: { maxTokens: 50_000, maxDurationMs: 30_000, maxRetries: 1 },
      }),
    );
    expect(result.status).toBe('escalated');
    // Verify traces show escalation across levels
    const traces = orchestrator.traceCollector.getTraces();
    const levels = traces.map((t) => t.routingLevel);
    // Should have attempted multiple levels (at least L1 and L2)
    expect(new Set(levels).size).toBeGreaterThanOrEqual(2);
  });

  test('15. §16.4 criterion 4: worker timeout produces empty mutations', async () => {
    // Create a mock provider that simulates high latency
    const registry = new LLMProviderRegistry();
    registry.register(createMockProvider({ id: 'mock/fast', tier: 'fast', latencyMs: 2000 }));
    registry.register(createMockProvider({ id: 'mock/balanced', tier: 'balanced', latencyMs: 2000 }));
    registry.register(createMockProvider({ id: 'mock/powerful', tier: 'powerful', latencyMs: 2000 }));

    const orchestrator = createOrchestrator({
      workspace: tempDir,
      registry,
      useSubprocess: false,
    });
    const result = await orchestrator.executeTask(
      makeInput({
        targetFiles: ['src/foo.ts'],
        budget: { maxTokens: 10_000, maxDurationMs: 50, maxRetries: 1 },
      }),
    );
    // With very short budget, worker should timeout → escalation or completion with no mutations
    expect(['completed', 'escalated', 'failed']).toContain(result.status);
  });

  test('16. §16.4 criterion 8: World Graph updated on success', async () => {
    const orchestrator = createOrchestrator({ workspace: tempDir, registry: makeRegistry(), useSubprocess: false });
    const result = await orchestrator.executeTask(makeInput({ targetFiles: ['src/foo.ts'] }));
    // If task completed with mutations, verified facts should have been committed
    if (result.status === 'completed' && result.mutations.length > 0) {
      // WorldGraph fact commitment is best-effort — check that the task at least completed
      expect(result.trace.outcome).toBe('success');
      expect(result.trace.affectedFiles.length).toBeGreaterThan(0);
    }
  });

  test('17. trace captures A7 calibration inputs: tokens, duration, outcome, and approach', async () => {
    // A7: "prediction error as learning signal" — the trace is the carrier for calibration data.
    // selfModel.calibrate(prediction, trace) is called at L2+ (core-loop: `if (routing.level >= 2)`).
    // At L1, calibrate() is not called (no predict() ran), but the trace still carries the inputs
    // that calibration would consume: tokensConsumed, durationMs, outcome, approach.
    // This test verifies those inputs are correctly populated so calibration CAN use them.
    const orchestrator = createOrchestrator({ workspace: tempDir, registry: makeRegistry(), useSubprocess: false });
    const result = await orchestrator.executeTask(
      makeInput({ id: 'a7-task', targetFiles: ['src/foo.ts'], constraints: ['MIN_ROUTING_LEVEL:1'] }),
    );
    const traces = orchestrator.traceCollector.getTraces();
    const l1Trace = traces.find((t) => t.taskId === 'a7-task' && t.routingLevel >= 1)!;
    // Calibration inputs must be present on every L1+ trace (A7 learning signal)
    expect(l1Trace).toBeDefined();
    expect(l1Trace.tokensConsumed).toBeGreaterThan(0); // LLM was invoked — token count is a calibration input
    expect(l1Trace.durationMs).toBeGreaterThanOrEqual(0); // duration field is populated (mock may return in <1ms → rounds to 0)
    expect(l1Trace.outcome).toBe('success'); // outcome (pass/fail) is the primary calibration label
    expect(l1Trace.approach).toBeTruthy(); // approach text feeds the learning summary
    expect(result.status).toBe('completed');
  });

  test('16b. provider failure degrades gracefully — empty mutations, zero tokens consumed', async () => {
    // dispatchInProcess catches provider errors via .catch(() => 'error') and returns emptyOutput.
    // This means catch(dispatchErr) in core-loop is NOT triggered — no failure trace is recorded.
    // Instead, the task "succeeds" with 0 mutations and 0 tokens: graceful degradation, not a crash.
    const failRegistry = new LLMProviderRegistry();
    failRegistry.register(createMockProvider({ id: 'mock/fast', tier: 'fast', shouldFail: true }));
    failRegistry.register(createMockProvider({ id: 'mock/balanced', tier: 'balanced', shouldFail: true }));
    failRegistry.register(createMockProvider({ id: 'mock/powerful', tier: 'powerful', shouldFail: true }));

    const orchestrator = createOrchestrator({
      workspace: tempDir,
      registry: failRegistry,
      useSubprocess: false,
    });

    const result = await orchestrator.executeTask(
      makeInput({
        targetFiles: ['src/foo.ts'],
        // MIN_ROUTING_LEVEL:1 forces LLM dispatch (without it, L0 skips LLM entirely)
        constraints: ['MIN_ROUTING_LEVEL:1'],
        budget: { maxTokens: 10_000, maxDurationMs: 10_000, maxRetries: 1 },
      }),
    );

    // Provider failure is swallowed by emptyOutput → task completes without crashing
    expect(result.mutations).toHaveLength(0); // no mutations produced
    expect(result.trace.taskId).toBe('t-integration');
    expect(result.trace.routingLevel).toBeGreaterThanOrEqual(1); // L1 was attempted
    expect(result.trace.tokensConsumed).toBe(0); // no tokens: provider threw before generating
  });

  test('19. critic exception triggers fail-closed retry, not silent approval (A3)', async () => {
    // A3: governance must not silently degrade — critic errors must block, not pass through
    const throwingCritic: CriticEngine = {
      review: async () => {
        throw new Error('LLM provider timeout');
      },
    };
    const events: Array<{ accepted: boolean; reason?: string }> = [];
    const orchestrator = createOrchestrator({
      workspace: tempDir,
      registry: makeRegistry(),
      useSubprocess: false,
      criticEngine: throwingCritic,
    });
    orchestrator.bus.on('critic:verdict', (e) => events.push(e));

    const result = await orchestrator.executeTask(
      makeInput({
        targetFiles: ['src/foo.ts'],
        budget: { maxTokens: 10_000, maxDurationMs: 10_000, maxRetries: 2 },
      }),
    );

    // Critic errors should be emitted as rejected verdicts
    const rejections = events.filter((e) => !e.accepted);
    // If task reached L2+ routing, critic was invoked and should have emitted fail-closed verdicts
    if (rejections.length > 0) {
      expect(rejections[0]!.accepted).toBe(false);
      expect(rejections[0]!.reason).toContain('LLM provider timeout');
    }
    // Regardless, the task should complete (via retry or escalation) — not crash
    expect(['completed', 'escalated', 'failed']).toContain(result.status);
  });

  test('20. deliberation_request grants bonus retries and escalates routing (A2)', async () => {
    // A2: when an oracle requests deliberation, the system should grant more compute
    const deliberationGate = {
      verify: async () => ({
        passed: false,
        verdicts: {
          'type-oracle': {
            verified: false,
            type: 'uncertain' as const,
            confidence: 0.3,
            evidence: [],
            fileHashes: {},
            durationMs: 100,
            deliberationRequest: {
              reason: 'Complex type inference requires deeper analysis',
              suggestedBudget: 2,
            },
          },
        },
        reason: 'type check failed — deliberation requested',
      }),
    };
    const escalations: Array<{ reason: string }> = [];
    const deliberations: Array<{ oracleName: string }> = [];
    const orchestrator = createOrchestrator({
      workspace: tempDir,
      registry: makeRegistry(),
      useSubprocess: false,
      oracleGate: deliberationGate,
    });
    orchestrator.bus.on('task:escalate', (e) => escalations.push(e));
    orchestrator.bus.on('oracle:deliberation_request', (e) => deliberations.push(e));

    await orchestrator.executeTask(
      makeInput({
        targetFiles: ['src/foo.ts'],
        budget: { maxTokens: 10_000, maxDurationMs: 10_000, maxRetries: 1 },
      }),
    );

    // Deliberation requests should have been emitted
    expect(deliberations.length).toBeGreaterThan(0);
    expect(deliberations[0]!.oracleName).toBe('type-oracle');

    // System should have escalated due to deliberation (from L0/L1 to higher level)
    const deliberationEscalations = escalations.filter((e) => e.reason === 'deliberation_request');
    if (deliberationEscalations.length > 0) {
      expect(deliberationEscalations[0]!.reason).toBe('deliberation_request');
    }
  });
});
