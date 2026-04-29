/**
 * Conversational result builder — persona resolution priority.
 *
 * Pins the contract that resolved-persona priority is:
 *   intent.agentId  →  input.agentId  →  registry.defaultAgent()
 *
 * Without this, a delegate-sub-agent that falls through to the
 * conversational short-circuit (e.g. when intent.agentId is unset because
 * STU classified the sub-task as conversational) reverts to the default
 * `coordinator` persona and loses the planner-assigned `author / mentor /
 * researcher` identity. Session a43487fd showed delegates speaking with
 * the coordinator soul instead of their assigned persona — root cause for
 * "competition rule proposals" in place of actual answers.
 */
import { describe, expect, test } from 'bun:test';
import { buildConversationalResult } from '../../src/orchestrator/conversational-result-builder.ts';
import type {
  AgentSpec,
  IntentResolution,
  TaskInput,
} from '../../src/orchestrator/types.ts';

function makeInput(over: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 'task-1',
    source: 'cli',
    goal: 'hello',
    taskType: 'reasoning',
    budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 1 },
    ...over,
  };
}

function intent(over: Partial<IntentResolution> = {}): IntentResolution {
  return {
    strategy: 'conversational',
    refinedGoal: 'hello',
    confidence: 0.9,
    reasoning: 'test',
    reasoningSource: 'deterministic',
    type: 'known',
    ...over,
  } as IntentResolution;
}

const COORDINATOR: AgentSpec = {
  id: 'coordinator',
  name: 'Coordinator',
  description: 'default routing persona',
  builtin: true,
  routingHints: { minLevel: 0 },
  capabilities: [],
  acquirableSkillTags: [],
  soul: 'I route work.',
} as unknown as AgentSpec;

const AUTHOR: AgentSpec = {
  id: 'author',
  name: 'Author',
  description: 'creative writing persona',
  builtin: true,
  routingHints: { minLevel: 0 },
  capabilities: [],
  acquirableSkillTags: [],
  soul: 'I write.',
} as unknown as AgentSpec;

function makeDeps(opts: {
  capturedSystemPrompt: string[];
  workerIdSink: string[];
}): any {
  const provider = {
    id: 'mock',
    tier: 'fast' as const,
    generate: async (req: { systemPrompt: string; userPrompt: string }) => {
      opts.capturedSystemPrompt.push(req.systemPrompt);
      return { content: 'ok', tokensUsed: { input: 1, output: 1 } };
    },
  };
  const traces: any[] = [];
  return {
    llmRegistry: {
      selectByTier: () => provider,
      listProviders: () => [provider],
    },
    agentRegistry: {
      defaultAgent: () => COORDINATOR,
      getAgent: (id: string) => (id === 'author' ? AUTHOR : id === 'coordinator' ? COORDINATOR : null),
      listAgents: () => [COORDINATOR, AUTHOR],
    },
    traceCollector: {
      record: async (t: any) => {
        traces.push(t);
        opts.workerIdSink.push(t.workerId);
      },
    },
    bus: { emit: () => {} },
  };
}

describe('buildConversationalResult — persona resolution priority', () => {
  test('input.agentId wins when intent.agentId is undefined (delegate sub-task fallback)', async () => {
    // The delegate-sub-agent dispatch site sets `subInput.agentId = 'author'`
    // but does NOT set `intent.agentId`. Before the fix, the conversational
    // resolver only checked intent.agentId and reverted to the default
    // coordinator soul — the author delegate spoke with the wrong voice.
    const capturedSystemPrompt: string[] = [];
    const workerIdSink: string[] = [];
    const deps = makeDeps({ capturedSystemPrompt, workerIdSink });
    const result = await buildConversationalResult(
      makeInput({ agentId: 'author' }),
      intent(), // intent.agentId is undefined
      deps,
    );
    expect(result.kind).toBe('final');
    expect(workerIdSink[0]).toBe('author');
    expect(capturedSystemPrompt[0]).toContain('Author');
    expect(capturedSystemPrompt[0]).toContain('I write.');
    // Coordinator soul must NOT be the active persona for this turn.
    expect(capturedSystemPrompt[0]).not.toContain('I route work.');
  });

  test('intent.agentId wins over input.agentId when both are set', async () => {
    // Intent-resolver had a strong signal (e.g. a skill auction picked a
    // different specialist than the parent's hint). intent.agentId is the
    // higher-priority source — input.agentId is only a fallback.
    const capturedSystemPrompt: string[] = [];
    const workerIdSink: string[] = [];
    const deps = makeDeps({ capturedSystemPrompt, workerIdSink });
    await buildConversationalResult(
      makeInput({ agentId: 'coordinator' }),
      intent({ agentId: 'author' } as Partial<IntentResolution>),
      deps,
    );
    expect(workerIdSink[0]).toBe('author');
    expect(capturedSystemPrompt[0]).toContain('I write.');
  });

  test('falls back to defaultAgent when neither agentId is set', async () => {
    const capturedSystemPrompt: string[] = [];
    const workerIdSink: string[] = [];
    const deps = makeDeps({ capturedSystemPrompt, workerIdSink });
    await buildConversationalResult(makeInput(), intent(), deps);
    expect(workerIdSink[0]).toBe('coordinator');
    expect(capturedSystemPrompt[0]).toContain('I route work.');
  });
});
