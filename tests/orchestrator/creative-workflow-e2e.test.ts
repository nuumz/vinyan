/**
 * End-to-end integration test for the creative-workflow path.
 *
 * Exercises the event sequence the user sees when they ask Vinyan to write a
 * long-form creative piece (the original "ช่วยเขียนนิยายลงขายในเว็บตูน" bug):
 *
 *   Turn 1 (fresh session):
 *     resolveIntent → agentic-workflow
 *     maybeEmitCreativeClarificationGate → input-required + structured questions
 *     Bus events: intent-style signal → trace:record → agent:clarification_requested → task:complete
 *
 *   (User responds via HTTP POST /sessions/:id/clarification/respond.)
 *
 *   Turn 2 (continuation — session now has history):
 *     resolveIntent → agentic-workflow (same)
 *     maybeEmitCreativeClarificationGate → null (skips — session has turns)
 *     → executeWorkflow fires normally
 *     Bus events: workflow:research_injected → workflow:plan_ready (awaitingApproval
 *                 if approval required) → [approval event from HTTP] → steps execute
 *
 * This test is "partial" — it composes the real helpers against a mocked
 * LLM provider and captures bus events. It does NOT spin up a full factory
 * orchestrator, does NOT exercise the Room dispatcher, and does NOT run the
 * actual step execution (workflow-executor falls back to a single-step
 * plan when no provider is registered).
 */
import { describe, expect, test } from 'bun:test';
import { createBus, type VinyanBus } from '../../src/core/bus.ts';
import { maybeEmitCreativeClarificationGate } from '../../src/orchestrator/creative-clarification-gate.ts';
import {
  clearIntentResolverCache,
  resolveIntent,
} from '../../src/orchestrator/intent-resolver.ts';
import { LLMProviderRegistry } from '../../src/orchestrator/llm/provider-registry.ts';
import { executeWorkflow } from '../../src/orchestrator/workflow/workflow-executor.ts';
import type {
  ConversationEntry,
  ExecutionTrace,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  RoutingDecision,
  TaskInput,
} from '../../src/orchestrator/types.ts';

function makeInput(goal: string, overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 'e2e-task-1',
    source: 'cli',
    goal,
    taskType: 'reasoning',
    budget: { maxTokens: 2000, maxDurationMs: 10_000, maxRetries: 1 },
    sessionId: 's1',
    ...overrides,
  };
}

function makeRouting(level: 0 | 1 | 2 | 3 = 2): RoutingDecision {
  return {
    level,
    model: 'mock',
    budgetTokens: 8000,
    latencyBudgetMs: 8000,
    riskScore: 0.4,
  };
}

function makeProvider(content: string): LLMProvider {
  return {
    id: 'mock-balanced',
    tier: 'balanced',
    async generate(_req: LLMRequest): Promise<LLMResponse> {
      return {
        content,
        toolCalls: [],
        tokensUsed: { input: 10, output: 10 },
        model: 'mock-balanced',
        stopReason: 'end_turn',
      };
    },
  };
}

// Capture every bus event in order so we can assert the full sequence.
function instrumentBus(): { bus: VinyanBus; events: Array<{ name: string; payload: unknown }> } {
  const bus = createBus();
  const events: Array<{ name: string; payload: unknown }> = [];
  // Explicit subscriptions — ensures the listener is registered when events fire.
  const names = [
    'trace:record',
    'agent:clarification_requested',
    'task:complete',
    'workflow:plan_ready',
    'workflow:research_injected',
    'workflow:complete',
    'workflow:plan_approved',
    'workflow:plan_rejected',
  ] as const;
  for (const name of names) {
    bus.on(name, (payload) => events.push({ name, payload }));
  }
  return { bus, events };
}

function makeTraceCollector() {
  const recorded: ExecutionTrace[] = [];
  return {
    collector: { record: async (t: ExecutionTrace) => { recorded.push(t); } },
    recorded,
  };
}

// ---------------------------------------------------------------------------
// Turn 1: creative goal on a fresh session → input-required with structured questions
// ---------------------------------------------------------------------------

describe('creative-workflow E2E — turn 1 (fresh session)', () => {
  test('webtoon novel request produces structured clarifications', async () => {
    clearIntentResolverCache();
    const { bus, events } = instrumentBus();
    const { collector } = makeTraceCollector();

    const provider = makeProvider(
      JSON.stringify({
        strategy: 'agentic-workflow',
        refinedGoal: 'Write a webtoon-style multi-chapter novel',
        reasoning: 'Long-form creative deliverable.',
        workflowPrompt: 'Plan genre → outline → draft.',
        confidence: 0.95,
      }),
    );
    const registry = new LLMProviderRegistry();
    registry.register(provider);

    // Step 1 — intent resolution.
    const intent = await resolveIntent(
      makeInput('อยากให้ช่วยเขียนนิยายลงขายในเว็บตูนสักเรื่อง'),
      { registry, sessionId: 's1' },
    );
    expect(intent.strategy).toBe('agentic-workflow');

    // Step 2 — creative-clarification gate (fresh session → fires).
    const gateResult = await maybeEmitCreativeClarificationGate(
      makeInput('อยากให้ช่วยเขียนนิยายลงขายในเว็บตูนสักเรื่อง'),
      makeRouting(),
      {
        bus,
        sessionManager: { getConversationHistoryCompacted: () => [] },
        traceCollector: collector,
      },
    );

    expect(gateResult).not.toBeNull();
    expect(gateResult!.status).toBe('input-required');
    expect(gateResult!.clarificationNeeded!.length).toBeGreaterThanOrEqual(3);

    // Step 3 — bus event sequence.
    const sequence = events.map((e) => e.name);
    expect(sequence).toEqual([
      'trace:record',
      'agent:clarification_requested',
      'task:complete',
    ]);

    const clarifyPayload = events.find((e) => e.name === 'agent:clarification_requested')!
      .payload as {
        structuredQuestions: Array<{ id: string; kind: string; options?: unknown[] }>;
        source: string;
      };
    expect(clarifyPayload.source).toBe('orchestrator');
    const ids = clarifyPayload.structuredQuestions.map((q) => q.id);
    expect(ids).toContain('genre');
    expect(ids).toContain('audience');
    expect(ids).toContain('tone');
    // Genre for webtoon has specific options (e.g. romance-fantasy).
    const genre = clarifyPayload.structuredQuestions.find((q) => q.id === 'genre')!;
    expect(Array.isArray(genre.options)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Turn 2: continuation — gate skips because session has history
// ---------------------------------------------------------------------------

describe('creative-workflow E2E — turn 2 (with history) → executor approval path', () => {
  test('gate skips and executor pauses for approval, then resumes on approve', async () => {
    clearIntentResolverCache();
    const { bus, events } = instrumentBus();
    const { collector } = makeTraceCollector();

    const prior: ConversationEntry[] = [
      { role: 'user', content: 'อยากเขียนนิยาย', taskId: 't0', timestamp: 1, tokenEstimate: 4 },
      { role: 'assistant', content: 'ตอบคำถามตามตัวเลือก...', taskId: 't0', timestamp: 2, tokenEstimate: 8 },
    ];

    // Gate must skip (session has history).
    const gateResult = await maybeEmitCreativeClarificationGate(
      makeInput('อยากเขียนนิยายเว็บตูนโรแมนซ์แฟนตาซี'),
      makeRouting(),
      {
        bus,
        sessionManager: { getConversationHistoryCompacted: () => prior },
        traceCollector: collector,
      },
    );
    expect(gateResult).toBeNull();

    // Executor runs; approval required because 'auto' + long-form. Using an
    // empty provider registry means planWorkflow falls back to a single-step
    // plan — sufficient to exercise the approval gate.
    const runPromise = executeWorkflow(
      makeInput('อยากเขียนนิยายเว็บตูนโรแมนซ์แฟนตาซีครับ เป็นเรื่องยาวหลายตอน'),
      {
        bus,
        workflowConfig: { requireUserApproval: 'auto', approvalTimeoutMs: 30_000 },
      },
    );

    // Let the executor subscribe + emit plan_ready.
    await new Promise((r) => setTimeout(r, 20));
    const planReady = events.find((e) => e.name === 'workflow:plan_ready');
    expect(planReady).toBeDefined();
    expect((planReady!.payload as { awaitingApproval: boolean }).awaitingApproval).toBe(true);

    // Simulate user approving via the HTTP endpoint (which emits this event).
    bus.emit('workflow:plan_approved', { taskId: 'e2e-task-1' });
    const result = await runPromise;

    expect(result.synthesizedOutput).not.toContain('rejected');
    expect(result.synthesizedOutput).not.toContain('timed out');
  });
});

// ---------------------------------------------------------------------------
// Rejection path — HTTP reject translates into a failed WorkflowResult
// ---------------------------------------------------------------------------

describe('creative-workflow E2E — rejection short-circuits execution', () => {
  test('executor returns failed when user rejects via bus', async () => {
    const { bus } = instrumentBus();
    const runPromise = executeWorkflow(
      makeInput('Write a long, detailed multi-chapter creative novel with supporting outlines'),
      {
        bus,
        workflowConfig: { requireUserApproval: true, approvalTimeoutMs: 30_000 },
      },
    );
    await new Promise((r) => setTimeout(r, 20));
    bus.emit('workflow:plan_rejected', { taskId: 'e2e-task-1', reason: 'not interested' });
    const result = await runPromise;
    expect(result.status).toBe('failed');
    expect(result.synthesizedOutput).toContain('rejected');
    expect(result.stepResults).toHaveLength(0);
  });
});
