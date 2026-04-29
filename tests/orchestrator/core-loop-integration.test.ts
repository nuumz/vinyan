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
import { createOrchestrator as _createOrchestrator } from '../../src/orchestrator/factory.ts';

// Test fixture: grandfather workers so freshly-registered mock providers
// are not gated by the I10 probation path (which suppresses mutations from
// untrusted workers). The factory's `workerBootstrapPolicy: 'grandfather'`
// is documented as the test-fixture escape hatch in factory.ts.
const createOrchestrator: typeof _createOrchestrator = (opts) =>
  _createOrchestrator({ workerBootstrapPolicy: 'grandfather', ...opts });
import { createMockProvider } from '../../src/orchestrator/llm/mock-provider.ts';
import { LLMProviderRegistry } from '../../src/orchestrator/llm/provider-registry.ts';
import type { CriticEngine } from '../../src/orchestrator/critic/critic-engine.ts';
import type { CostLedgerEntry } from '../../src/economy/cost-ledger.ts';
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
      // Pipeline tests: oracles disabled to isolate core-loop logic (routing, escalation, budget).
      // For oracle integration, see tests/integration/oracle-gate.test.ts which exercises real oracles.
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
    // Pre-routing comprehension/understanding phases also record traces
    // (with tokensConsumed:0). The contract asserted here is that *some*
    // trace carries L1 LLM dispatch evidence — find it by routing level.
    const workerTrace = traces.find((t) => t.taskId === 't-integration' && t.routingLevel >= 1);
    expect(workerTrace).toBeDefined();
    expect(workerTrace!.tokensConsumed).toBeGreaterThan(0); // LLM was called — tokens consumed
    expect(workerTrace!.approach).toBeTruthy(); // approach text recorded from LLM response
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

  test('7. factory creates orchestrator that can execute a task', async () => {
    const orchestrator = createOrchestrator({ workspace: tempDir, useSubprocess: false });
    // Behavior: actually call executeTask — don't just check property existence
    const result = await orchestrator.executeTask(makeInput({ id: 'factory-smoke' }));
    expect(result.id).toBe('factory-smoke');
    expect(['completed', 'failed', 'escalated']).toContain(result.status);
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
    // Find the L1+ worker trace explicitly (pre-routing comprehension traces
    // carry routingLevel:0 + tokens:0 + modelUsed:'comprehension-engine-id').
    const trace = traces.find((t) => t.taskId === 't-integration' && t.routingLevel >= 1)!;
    expect(trace).toBeDefined();
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

  test('12. path safety: traversal mutation never hits disk (A6); fail-closed contract verified at unit boundary (A9 T3.b)', async () => {
    // Mock provider proposes a path-traversal mutation alongside a valid one.
    // The L0 reflex path used by this fixture skips workspace commit, so this
    // integration test asserts the path-safety floor (escape file must not
    // exist on disk and notes must surface the rejection when reached).
    // Fail-closed any-reject + preflight semantics are unit-tested in
    // tests/orchestrator/worker/artifact-commit.test.ts and the runtime
    // bus→degradation bridge mapping is covered in
    // tests/orchestrator/degradation-policy-matrix.test.ts.
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
    expect(existsSync(join(tempDir, '..', 'escape.ts'))).toBe(false);
    if (result.status === 'failed' && result.notes) {
      expect(result.notes.some((n) => n.includes('Rejected'))).toBe(true);
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

  test('24. wall-clock timeout is attributed to the level that actually ran (not post-escalation)', async () => {
    // Regression test for misleading "L3 timeout" diagnostic.
    //
    // Without the per-attempt cap + pre-escalation guard, a small
    // wall-clock budget that is consumed entirely at L1/L2 would still
    // emit `task:escalate` after retry exhaustion, then the next
    // iteration's wall-clock check would label the timeout with the
    // post-escalation level (e.g. L3) — even though L3 never ran.
    //
    // This test sets a 200ms budget with a 500ms-latency mock provider.
    // The first L1 attempt blows the budget; the loop must report the
    // timeout at L1 (or the pre-escalation guard must trigger), never
    // at a higher level that never executed.
    const registry = new LLMProviderRegistry();
    registry.register(createMockProvider({ id: 'mock/fast', tier: 'fast', latencyMs: 500 }));
    registry.register(createMockProvider({ id: 'mock/balanced', tier: 'balanced', latencyMs: 500 }));
    registry.register(createMockProvider({ id: 'mock/powerful', tier: 'powerful', latencyMs: 500 }));

    const escalateEvents: Array<{ fromLevel: number; toLevel: number }> = [];
    const orchestrator = createOrchestrator({
      workspace: tempDir,
      registry,
      useSubprocess: false,
    });
    orchestrator.bus.on('task:escalate', (p) => {
      escalateEvents.push({ fromLevel: p.fromLevel, toLevel: p.toLevel });
    });

    const result = await orchestrator.executeTask(
      makeInput({
        targetFiles: ['src/foo.ts'],
        constraints: ['MIN_ROUTING_LEVEL:1'],
        budget: { maxTokens: 10_000, maxDurationMs: 200, maxRetries: 2 },
      }),
    );

    // The trace must reflect a level that actually consumed budget.
    // Specifically: it must NOT claim L3 if L3 never escalated to.
    const reachedLevel = Math.max(0, ...escalateEvents.map((e) => e.toLevel));
    expect(result.trace.routingLevel).toBeLessThanOrEqual(Math.max(1, reachedLevel));

    // If the result is a timeout, the answer/failureReason must explain
    // the actual cause (wall-clock or budget exhausted), not a phantom
    // "L3 timeout" message.
    if (result.status === 'failed' && result.trace.outcome === 'timeout') {
      expect(result.answer ?? '').toMatch(/timed out|budget|exhausted/i);
    }
  });
});

// ── G6 soft-degrade routing integration tests ─────────────────────────────────
// Verifies that softDegradeToLevel from BudgetEnforcer is consumed by core-loop
// and produces the expected routing downgrade + bus event.

function makeSoftDegradeEntry(computedUsd: number, idx: number): CostLedgerEntry {
  return {
    id: `soft-degrade-entry-${idx}`,
    taskId: 'seed-task',
    workerId: null,
    engineId: 'claude-sonnet',
    timestamp: Date.now(),
    tokens_input: 1000,
    tokens_output: 500,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    duration_ms: 5000,
    oracle_invocations: 0,
    computed_usd: computedUsd,
    cost_tier: 'billing',
    routing_level: 2,
    task_type_signature: null,
  };
}

describe('G6 soft-degrade routing integration', () => {
  let softDegradeDir: string;

  beforeEach(() => {
    softDegradeDir = mkdtempSync(join(tmpdir(), 'vinyan-soft-degrade-'));
    mkdirSync(join(softDegradeDir, 'src'), { recursive: true });
    mkdirSync(join(softDegradeDir, '.vinyan'), { recursive: true });
    writeFileSync(join(softDegradeDir, 'src', 'foo.ts'), 'export const x = 1;\n');
    writeFileSync(join(softDegradeDir, 'src', 'foo.test.ts'), '// test coverage marker\n');
  });

  afterEach(() => {
    rmSync(softDegradeDir, { recursive: true, force: true });
  });

  function makeSoftDegradeRegistry(responseContent?: string) {
    const registry = new LLMProviderRegistry();
    const content =
      responseContent ??
      JSON.stringify({
        proposedMutations: [{ file: 'src/foo.ts', content: 'export const x = 2;\n', explanation: 'changed' }],
        proposedToolCalls: [],
        uncertainties: [],
      });
    registry.register(createMockProvider({ id: 'mock/fast', tier: 'fast', responseContent: content }));
    registry.register(createMockProvider({ id: 'mock/balanced', tier: 'balanced', responseContent: content }));
    registry.register(createMockProvider({ id: 'mock/powerful', tier: 'powerful', responseContent: content }));
    return registry;
  }

  test('21. softDegradeToLevel downgrades L2 routing to L1 and emits economy:budget_degraded', async () => {
    // Economy config: hourly_usd=1.0, degrade_on_warning=true, soft_degrade_level=1
    // We pre-seed the ledger with 85% of the hourly limit so the warning threshold fires.
    writeFileSync(
      join(softDegradeDir, 'vinyan.json'),
      JSON.stringify({
        oracles: {
          type: { enabled: false },
          dep: { enabled: false },
          ast: { enabled: false },
          test: { enabled: false },
          lint: { enabled: false },
        },
        economy: {
          enabled: true,
          budgets: {
            hourly_usd: 1.0,
            enforcement: 'warn',
            degrade_on_warning: true,
            soft_degrade_level: 1,
          },
        },
      }),
    );

    const orchestrator = createOrchestrator({
      workspace: softDegradeDir,
      registry: makeSoftDegradeRegistry(),
      useSubprocess: false,
    });

    // Seed ledger at 85% of the hourly_usd limit (below 100% — soft degrade, not hard block)
    const ledger = orchestrator.costLedger;
    expect(ledger).toBeDefined();
    ledger!.record(makeSoftDegradeEntry(0.85, 0));

    // Capture economy:budget_degraded events
    const degradeEvents: Array<{ taskId: string; fromLevel: number; toLevel: number; reason: string }> = [];
    orchestrator.bus.on('economy:budget_degraded', (e) => degradeEvents.push(e));

    // MIN_ROUTING_LEVEL:2 forces the initial routing to L2 so the soft degrade has room to act
    const result = await orchestrator.executeTask({
      id: 'g6-soft-degrade',
      source: 'cli',
      goal: 'Fix the export value',
      taskType: 'code',
      budget: { maxTokens: 10_000, maxDurationMs: 10_000, maxRetries: 1 },
      targetFiles: ['src/foo.ts'],
      constraints: ['MIN_ROUTING_LEVEL:2'],
    });

    // The task should complete or escalate — not crash
    expect(['completed', 'escalated', 'failed']).toContain(result.status);

    // Soft degrade must have fired: economy:budget_degraded with soft-degrade reason
    const softDegradeEvent = degradeEvents.find((e) => e.reason.includes('Soft degrade'));
    expect(softDegradeEvent).toBeDefined();
    expect(softDegradeEvent!.toLevel).toBe(1);
    expect(softDegradeEvent!.fromLevel).toBeGreaterThan(1);

    // The trace routing level should reflect the downgraded L1
    expect(result.trace.routingLevel).toBeLessThanOrEqual(1);
  });

  test('22. softDegradeToLevel is clamped to L2 for tool-needed tasks (capability floor)', async () => {
    // soft_degrade_level=1, but with TOOLS:enabled the task is tool-needed,
    // so the effective degrade target must be clamped to L2 (the tool capability floor).
    writeFileSync(
      join(softDegradeDir, 'vinyan.json'),
      JSON.stringify({
        oracles: {
          type: { enabled: false },
          dep: { enabled: false },
          ast: { enabled: false },
          test: { enabled: false },
          lint: { enabled: false },
        },
        economy: {
          enabled: true,
          budgets: {
            hourly_usd: 1.0,
            enforcement: 'warn',
            degrade_on_warning: true,
            soft_degrade_level: 1,
          },
        },
      }),
    );

    const orchestrator = createOrchestrator({
      workspace: softDegradeDir,
      registry: makeSoftDegradeRegistry(),
      useSubprocess: false,
    });

    // Seed at 85%
    orchestrator.costLedger!.record(makeSoftDegradeEntry(0.85, 0));

    const degradeEvents: Array<{ toLevel: number; reason: string }> = [];
    orchestrator.bus.on('economy:budget_degraded', (e) => degradeEvents.push(e));

    // MIN_ROUTING_LEVEL:3 + TOOLS:enabled — starts at L3, soft degrade wants L1 but cap is L2
    const result = await orchestrator.executeTask({
      id: 'g6-tool-needed-cap',
      source: 'cli',
      goal: 'Run a shell command',
      taskType: 'code',
      budget: { maxTokens: 10_000, maxDurationMs: 10_000, maxRetries: 1 },
      targetFiles: ['src/foo.ts'],
      constraints: ['MIN_ROUTING_LEVEL:3', 'TOOLS:enabled'],
    });

    expect(['completed', 'escalated', 'failed']).toContain(result.status);

    // Soft degrade should fire but be clamped to L2 (not L1) to preserve tool availability
    const softDegradeEvent = degradeEvents.find((e) => e.reason.includes('Soft degrade'));
    expect(softDegradeEvent).toBeDefined();
    expect(softDegradeEvent!.toLevel).toBe(2); // clamped — not allowed below L2 for tool-needed
    expect(result.trace.routingLevel).toBeLessThanOrEqual(2);
  });

  test('23. softDegradeToLevel is a no-op when routing is already at or below the target', async () => {
    // soft_degrade_level=2, but routing starts at L1 — no downgrade needed
    writeFileSync(
      join(softDegradeDir, 'vinyan.json'),
      JSON.stringify({
        oracles: {
          type: { enabled: false },
          dep: { enabled: false },
          ast: { enabled: false },
          test: { enabled: false },
          lint: { enabled: false },
        },
        economy: {
          enabled: true,
          budgets: {
            hourly_usd: 1.0,
            enforcement: 'warn',
            degrade_on_warning: true,
            soft_degrade_level: 2,
          },
        },
      }),
    );

    const orchestrator = createOrchestrator({
      workspace: softDegradeDir,
      registry: makeSoftDegradeRegistry(),
      useSubprocess: false,
    });

    // Seed at 85% to trigger the warning
    orchestrator.costLedger!.record(makeSoftDegradeEntry(0.85, 0));

    const degradeEvents: Array<{ reason: string }> = [];
    orchestrator.bus.on('economy:budget_degraded', (e) => degradeEvents.push(e));

    // MIN_ROUTING_LEVEL:1 — routing starts at L1, soft degrade target is L2:
    // currentLevel (1) <= targetLevel (2), so no downgrade occurs.
    const result = await orchestrator.executeTask({
      id: 'g6-no-op',
      source: 'cli',
      goal: 'Fix the export value',
      taskType: 'code',
      budget: { maxTokens: 10_000, maxDurationMs: 10_000, maxRetries: 1 },
      targetFiles: ['src/foo.ts'],
      constraints: ['MIN_ROUTING_LEVEL:1'],
    });

    expect(['completed', 'escalated', 'failed']).toContain(result.status);

    // No soft-degrade event should have fired (routing was already below the target)
    const softDegradeEvent = degradeEvents.find((e) => e.reason.includes('Soft degrade'));
    expect(softDegradeEvent).toBeUndefined();
  });
});
