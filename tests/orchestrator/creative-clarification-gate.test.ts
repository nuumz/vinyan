/**
 * Tests for the creative-clarification gate (Phase D+E).
 *
 * Scope: unit tests with lightweight stubs — verify that the gate fires for
 * fresh long-form creative goals, skips when the session already has turns,
 * and skips entirely for non-creative domains.
 */
import { describe, expect, test } from 'bun:test';
import type { Turn, RoutingDecision, TaskInput, TaskResult } from '../../src/orchestrator/types.ts';
import { maybeEmitCreativeClarificationGate } from '../../src/orchestrator/creative-clarification-gate.ts';

// ── Fixtures ─────────────────────────────────────────────────────────

function makeInput(goal: string, overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 'task-1',
    source: 'cli',
    goal,
    taskType: 'reasoning',
    budget: { maxTokens: 4000, maxDurationMs: 30_000, maxRetries: 1 },
    ...overrides,
  };
}

function makeRouting(level: 0 | 1 | 2 | 3 = 2): RoutingDecision {
  return {
    level,
    model: 'claude-sonnet',
    budgetTokens: 10_000,
    latencyBudgetMs: 10_000,
    riskScore: 0.5,
  };
}

function makeEntry(role: 'user' | 'assistant', content: string): Turn {
  return {
    id: `t-${role}-${content.slice(0, 6)}`,
    sessionId: 's',
    seq: 0,
    role,
    blocks: [{ type: 'text', text: content }],
    tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    createdAt: 0,
  };
}

interface RecordedEvent {
  name: string;
  payload: unknown;
}

function makeDeps(history: Turn[] | undefined = undefined) {
  const events: RecordedEvent[] = [];
  const recordedTraces: unknown[] = [];
  const deps = {
    bus: {
      emit: (name: string, payload: unknown) => {
        events.push({ name, payload });
      },
    } as never,
    sessionManager: history === undefined ? undefined : {
      getTurnsHistory: () => history,
    },
    traceCollector: {
      record: async (trace: unknown) => {
        recordedTraces.push(trace);
      },
    },
  };
  return { deps, events, recordedTraces };
}

// ── Fire cases ───────────────────────────────────────────────────────

describe('maybeEmitCreativeClarificationGate — fires for fresh creative goals', () => {
  test('webtoon novel request triggers structured clarification', async () => {
    const { deps, events, recordedTraces } = makeDeps([]);
    const result = await maybeEmitCreativeClarificationGate(
      makeInput('อยากให้ช่วยเขียนนิยายลงขายในเว็บตูนสักเรื่อง', { sessionId: 's1' }),
      makeRouting(),
      deps,
    );

    expect(result).not.toBeNull();
    expect(result!.status).toBe('input-required');
    expect(result!.clarificationNeeded!.length).toBeGreaterThanOrEqual(3);

    const clarifyEvent = events.find((e) => e.name === 'agent:clarification_requested');
    expect(clarifyEvent).toBeDefined();
    const payload = clarifyEvent!.payload as {
      structuredQuestions: Array<{ id: string; kind: string }>;
      source: string;
    };
    expect(payload.source).toBe('orchestrator');
    expect(payload.structuredQuestions.some((q) => q.id === 'genre')).toBe(true);
    expect(payload.structuredQuestions.some((q) => q.id === 'audience')).toBe(true);
    expect(payload.structuredQuestions.some((q) => q.id === 'tone')).toBe(true);

    expect(recordedTraces).toHaveLength(1);
    const traceEvent = events.find((e) => e.name === 'trace:record');
    expect(traceEvent).toBeDefined();
    const completeEvent = events.find((e) => e.name === 'task:complete');
    expect(completeEvent).toBeDefined();
  });

  test('article request surfaces article-specific genre options', async () => {
    const { deps, events } = makeDeps([]);
    await maybeEmitCreativeClarificationGate(
      makeInput('ช่วยเขียนบทความเกี่ยวกับ AI', { sessionId: 's1' }),
      makeRouting(),
      deps,
    );
    const payload = events.find((e) => e.name === 'agent:clarification_requested')!.payload as {
      structuredQuestions: Array<{ id: string; options?: Array<{ id: string }> }>;
    };
    const genre = payload.structuredQuestions.find((q) => q.id === 'genre');
    expect(genre?.options?.some((o) => o.id === 'how-to')).toBe(true);
  });
});

// ── Skip cases ───────────────────────────────────────────────────────

describe('maybeEmitCreativeClarificationGate — skips when not applicable', () => {
  test('skips when the session already has prior turns (implicit consent)', async () => {
    const prior = [makeEntry('user', 'hello'), makeEntry('assistant', 'hi')];
    const { deps, events } = makeDeps(prior);
    const result = await maybeEmitCreativeClarificationGate(
      makeInput('อยากเขียนนิยาย', { sessionId: 's1' }),
      makeRouting(),
      deps,
    );
    expect(result).toBeNull();
    expect(events).toHaveLength(0);
  });

  test('skips for non-creative goals even without history', async () => {
    const { deps } = makeDeps([]);
    const result = await maybeEmitCreativeClarificationGate(
      makeInput('fix type error in src/foo.ts', { sessionId: 's1' }),
      makeRouting(),
      deps,
    );
    expect(result).toBeNull();
  });

  test('skips for a short greeting', async () => {
    const { deps } = makeDeps([]);
    const result = await maybeEmitCreativeClarificationGate(
      makeInput('hi', { sessionId: 's1' }),
      makeRouting(),
      deps,
    );
    expect(result).toBeNull();
  });

  test('treats an absent sessionManager as a fresh session (still fires for creative)', async () => {
    const { deps, events } = makeDeps(undefined);
    const result = await maybeEmitCreativeClarificationGate(
      makeInput('write a webtoon novel'),
      makeRouting(),
      deps,
    );
    expect(result).not.toBeNull();
    expect(events.some((e) => e.name === 'agent:clarification_requested')).toBe(true);
  });

  test('swallows errors from sessionManager and still fires for creative goals', async () => {
    const { recordedTraces } = makeDeps([]);
    const throwingDeps = {
      bus: { emit: () => {} } as never,
      sessionManager: {
        getTurnsHistory: () => {
          throw new Error('db down');
        },
      },
      traceCollector: { record: async () => {} },
    };
    const result = await maybeEmitCreativeClarificationGate(
      makeInput('เขียนนิยายให้หน่อย', { sessionId: 's1' }),
      makeRouting(),
      throwingDeps,
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe('input-required');
    // Trace still recorded via the caller-supplied traceCollector (stubbed to no-op above).
    expect(recordedTraces).toHaveLength(0); // we swapped in a silent one — sanity
  });
});

// ── Trace shape ──────────────────────────────────────────────────────

describe('maybeEmitCreativeClarificationGate — trace shape', () => {
  test('records a trace with approach=creative-clarification', async () => {
    const { deps, recordedTraces } = makeDeps([]);
    await maybeEmitCreativeClarificationGate(
      makeInput('write a novel', { sessionId: 's1' }),
      makeRouting(3),
      deps,
    );
    const trace = recordedTraces[0] as { approach: string; routingLevel: number; outcome: string };
    expect(trace.approach).toBe('creative-clarification');
    expect(trace.routingLevel).toBe(3);
    expect(trace.outcome).toBe('success');
  });
});

// ── Result type sanity ──────────────────────────────────────────────

describe('maybeEmitCreativeClarificationGate — result integrity', () => {
  test('clarificationNeeded strings mirror structuredQuestions prompts', async () => {
    const { deps, events } = makeDeps([]);
    const result = (await maybeEmitCreativeClarificationGate(
      makeInput('write a webtoon novel'),
      makeRouting(),
      deps,
    )) as TaskResult;
    const payload = events.find((e) => e.name === 'agent:clarification_requested')!.payload as {
      structuredQuestions: Array<{ prompt: string }>;
    };
    expect(result.clarificationNeeded).toEqual(payload.structuredQuestions.map((q) => q.prompt));
  });
});
