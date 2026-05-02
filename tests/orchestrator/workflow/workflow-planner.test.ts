import { describe, expect, test } from 'bun:test';
import { createBus } from '../../../src/core/bus.ts';
import type { AgentRegistry } from '../../../src/orchestrator/agents/registry.ts';
import type { CollaborationDirective } from '../../../src/orchestrator/intent/collaboration-parser.ts';
import type { AgentSpec } from '../../../src/orchestrator/types.ts';
import { planWorkflow, type WorkflowPlannerDeps } from '../../../src/orchestrator/workflow/workflow-planner.ts';

function makeDeps(override?: Partial<WorkflowPlannerDeps>): WorkflowPlannerDeps {
  return {
    knowledgeDeps: {},
    ...override,
  };
}

interface CapturedPlanCreated {
  taskId: string;
  sessionId?: string;
  goal: string;
  origin: 'llm' | 'fallback' | 'collaboration';
  attempts: number;
  steps: Array<{ id: string; description: string; strategy: string; dependencies: string[] }>;
}

function captureBus(): { bus: ReturnType<typeof createBus>; events: CapturedPlanCreated[] } {
  const bus = createBus();
  const events: CapturedPlanCreated[] = [];
  bus.on('workflow:plan_created', (payload) => {
    events.push(payload);
  });
  return { bus, events };
}

describe('planWorkflow', () => {
  test('no LLM → fallback single-step llm-reasoning plan', async () => {
    const plan = await planWorkflow(makeDeps(), { goal: 'summarize the auth module', taskId: 'task-1' });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.strategy).toBe('llm-reasoning');
    expect(plan.goal).toBe('summarize the auth module');
  });

  test('LLM returns valid JSON → parsed as WorkflowPlan', async () => {
    const validPlan = JSON.stringify({
      goal: 'fix bug in auth',
      steps: [
        {
          id: 'step1',
          description: 'read auth files',
          strategy: 'knowledge-query',
          dependencies: [],
          inputs: {},
          expectedOutput: 'file contents',
          budgetFraction: 0.2,
        },
        {
          id: 'step2',
          description: 'fix the bug',
          strategy: 'full-pipeline',
          dependencies: ['step1'],
          inputs: { context: '$step1.result' },
          expectedOutput: 'fixed code',
          budgetFraction: 0.6,
        },
        {
          id: 'step3',
          description: 'summarize changes',
          strategy: 'llm-reasoning',
          dependencies: ['step2'],
          inputs: { changes: '$step2.result' },
          expectedOutput: 'summary',
          budgetFraction: 0.2,
        },
      ],
      synthesisPrompt: 'Combine the fix and summary.',
    });

    const deps = makeDeps({
      llmRegistry: {
        selectByTier: () => ({
          id: 'mock',
          generate: async () => ({ content: validPlan, tokensUsed: { input: 100, output: 200 } }),
        }),
      } as any,
    });

    const plan = await planWorkflow(deps, { goal: 'fix bug in auth', taskId: 'task-2' });
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[0]!.strategy).toBe('knowledge-query');
    expect(plan.steps[1]!.strategy).toBe('full-pipeline');
    expect(plan.steps[2]!.strategy).toBe('llm-reasoning');
    expect(plan.steps[1]!.dependencies).toContain('step1');
  });

  test('LLM returns invalid JSON → fallback plan', async () => {
    const deps = makeDeps({
      llmRegistry: {
        selectByTier: () => ({
          id: 'mock',
          generate: async () => ({ content: 'not json at all', tokensUsed: { input: 10, output: 10 } }),
        }),
      } as any,
    });

    const plan = await planWorkflow(deps, { goal: 'do a thing', taskId: 'task-3' });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.strategy).toBe('llm-reasoning');
  });

  test('creative guidance is sent through the planner prompt without overriding the LLM plan', async () => {
    let capturedSystemPrompt = '';
    const creativePlan = JSON.stringify({
      goal: 'อยากให้ช่วยเขียนนิยายลงขายในเว็บตูนสักเรื่อง',
      steps: [
        {
          id: 'step1',
          description: 'creative-director coordinates the writing team',
          strategy: 'llm-reasoning',
        },
        {
          id: 'step2',
          description: 'novelist drafts the first chapter',
          strategy: 'llm-reasoning',
        },
      ],
      synthesisPrompt: 'Combine creative outputs.',
    });
    const deps = makeDeps({
      llmRegistry: {
        selectByTier: () => ({
          id: 'mock',
          generate: async (request: { systemPrompt: string }) => {
            capturedSystemPrompt = request.systemPrompt;
            return { content: creativePlan, tokensUsed: { input: 100, output: 200 } };
          },
        }),
      } as any,
    });

    const plan = await planWorkflow(deps, {
      goal: 'อยากให้ช่วยเขียนนิยายลงขายในเว็บตูนสักเรื่อง',
      taskId: 'task-4',
    });
    const descriptions = plan.steps.map((step) => step.description).join('\n');

    expect(capturedSystemPrompt).toContain('Creative writing rules');
    expect(capturedSystemPrompt).toContain('write" means author creative text, not write code');
    expect(capturedSystemPrompt).toContain('Internal creative roles are routing hints');
    expect(capturedSystemPrompt).toContain('do not leak handoff mechanics');
    expect(descriptions).toContain('creative-director');
    expect(descriptions).toContain('novelist');
    expect(plan.steps).toHaveLength(2);
  });

  test('LLM returns wrapped in code fences → still parsed', async () => {
    const validPlan = JSON.stringify({
      goal: 'test',
      steps: [{ id: 's1', description: 'do it', strategy: 'llm-reasoning' }],
      synthesisPrompt: 'Return s1 directly.',
    });

    const deps = makeDeps({
      llmRegistry: {
        selectByTier: () => ({
          id: 'mock',
          generate: async () => ({
            content: `\`\`\`json\n${validPlan}\n\`\`\``,
            tokensUsed: { input: 10, output: 20 },
          }),
        }),
      } as any,
    });

    const plan = await planWorkflow(deps, { goal: 'test', taskId: 'task-5' });
    expect(plan.steps).toHaveLength(1);
  });

  test('emits workflow:plan_created exactly once on LLM-success path', async () => {
    const validPlan = JSON.stringify({
      goal: 'analyze the data',
      steps: [
        {
          id: 'step1',
          description: 'gather context',
          strategy: 'knowledge-query',
          dependencies: [],
        },
        {
          id: 'step2',
          description: 'reason over context',
          strategy: 'llm-reasoning',
          dependencies: ['step1'],
        },
      ],
      synthesisPrompt: 'Combine results.',
    });
    const { bus, events } = captureBus();
    const deps = makeDeps({
      bus,
      llmRegistry: {
        selectByTier: () => ({
          id: 'mock',
          generate: async () => ({ content: validPlan, tokensUsed: { input: 100, output: 200 } }),
        }),
      } as any,
    });

    await planWorkflow(deps, {
      goal: 'analyze the data',
      taskId: 'task-emit-1',
      sessionId: 'session-emit-1',
    });

    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.taskId).toBe('task-emit-1');
    expect(evt.sessionId).toBe('session-emit-1');
    expect(evt.goal).toBe('analyze the data');
    expect(evt.origin).toBe('llm');
    expect(evt.attempts).toBe(1);
    expect(evt.steps).toHaveLength(2);
    expect(evt.steps[0]!.id).toBe('step1');
    expect(evt.steps[0]!.strategy).toBe('knowledge-query');
    expect(evt.steps[0]!.dependencies).toEqual([]);
    expect(evt.steps[1]!.dependencies).toEqual(['step1']);
  });

  test('emits exactly once with attempts=2 when first LLM call throws then succeeds', async () => {
    const validPlan = JSON.stringify({
      goal: 'recover after retry',
      steps: [{ id: 's1', description: 'do it', strategy: 'llm-reasoning' }],
      synthesisPrompt: 'Return s1.',
    });
    let callCount = 0;
    const { bus, events } = captureBus();
    const deps = makeDeps({
      bus,
      llmRegistry: {
        selectByTier: () => ({
          id: 'mock',
          generate: async () => {
            callCount += 1;
            if (callCount === 1) {
              return { content: 'totally not json', tokensUsed: { input: 5, output: 5 } };
            }
            return { content: validPlan, tokensUsed: { input: 100, output: 200 } };
          },
        }),
      } as any,
    });

    await planWorkflow(deps, { goal: 'recover after retry', taskId: 'task-emit-retry' });

    expect(callCount).toBe(2);
    expect(events).toHaveLength(1);
    expect(events[0]!.origin).toBe('llm');
    expect(events[0]!.attempts).toBe(2);
  });

  test('emits exactly once with origin=fallback,attempts=2 when both LLM attempts fail', async () => {
    const { bus, events } = captureBus();
    const deps = makeDeps({
      bus,
      llmRegistry: {
        selectByTier: () => ({
          id: 'mock',
          generate: async () => ({ content: 'not json', tokensUsed: { input: 1, output: 1 } }),
        }),
      } as any,
    });

    const plan = await planWorkflow(deps, { goal: 'will fall back', taskId: 'task-emit-fallback' });

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.strategy).toBe('llm-reasoning');
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.origin).toBe('fallback');
    expect(evt.attempts).toBe(2);
    expect(evt.taskId).toBe('task-emit-fallback');
    expect(evt.steps).toHaveLength(1);
    expect(evt.steps[0]!.dependencies).toEqual([]);
  });

  test('emits with origin=fallback,attempts=0 when no LLM provider is configured', async () => {
    const { bus, events } = captureBus();
    const deps = makeDeps({ bus });

    const plan = await planWorkflow(deps, { goal: 'no provider here', taskId: 'task-emit-noprovider' });

    expect(plan.steps).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]!.origin).toBe('fallback');
    expect(events[0]!.attempts).toBe(0);
    expect(events[0]!.taskId).toBe('task-emit-noprovider');
  });

  test('collaboration shortcut uses LLM-selected personas when llmRegistry + directive + agentRegistry all present', async () => {
    // Roster has 4 generators sorted alphabetically as architect/author/
    // developer/researcher. The legacy bypass would return the first 3 of
    // those (architect/author/developer) for ANY 3-agent goal. With LLM
    // persona selection, the goal-aware response forces a different mix.
    const agents: AgentSpec[] = [
      { id: 'developer', name: 'developer', description: 'TypeScript developer', role: 'developer' } as AgentSpec,
      { id: 'architect', name: 'architect', description: 'System architect', role: 'architect' } as AgentSpec,
      { id: 'author', name: 'author', description: 'Long-form writer', role: 'author' } as AgentSpec,
      { id: 'researcher', name: 'researcher', description: 'Researcher', role: 'researcher' } as AgentSpec,
      { id: 'reviewer', name: 'reviewer', description: 'Code reviewer', role: 'reviewer' } as AgentSpec,
      { id: 'coordinator', name: 'coordinator', description: 'Default coordinator', role: 'coordinator' } as AgentSpec,
      { id: 'mentor', name: 'mentor', description: 'Mentor', role: 'mentor' } as AgentSpec,
      { id: 'assistant', name: 'assistant', description: 'General assistant', role: 'assistant' } as AgentSpec,
      { id: 'concierge', name: 'concierge', description: 'Concierge', role: 'concierge' } as AgentSpec,
    ];
    const byId = new Map<string, AgentSpec>(agents.map((a) => [a.id, a]));
    const agentRegistry = {
      getAgent: (id: string) => byId.get(id) ?? null,
      listAgents: () => agents,
      defaultAgent: () => byId.get('coordinator') ?? agents[0]!,
      has: (id: string) => byId.has(id),
      registerAgent: () => {},
      unregisterAgent: () => false,
      unregisterAgentsForTask: () => [],
      mergeCapabilityClaims: () => false,
      getDerivedCapabilities: () => null,
      findCanonicalVerifier: () => byId.get('reviewer') ?? null,
      assertA1Pair: () => ({ ok: true }),
    } as unknown as AgentRegistry;

    const directive: CollaborationDirective = {
      requestedPrimaryParticipantCount: 3,
      interactionMode: 'debate',
      rebuttalRounds: 1,
      sharedDiscussion: true,
      reviewerPolicy: 'none',
      managerClarificationAllowed: true,
      emitCompetitionVerdict: false,
      source: 'pre-llm-parser',
      matchedFragments: { count: '3' },
    };

    const selectorResponse = JSON.stringify({
      primaryPersonaIds: ['researcher', 'mentor', 'assistant'],
      integratorPersonaId: 'coordinator',
      rationale: 'open-inquiry mix for a philosophical question',
    });
    const deps = makeDeps({
      agentRegistry,
      llmRegistry: {
        selectByTier: () => ({
          id: 'mock',
          generate: async () => ({ content: selectorResponse, tokensUsed: { input: 50, output: 80 } }),
        }),
      } as any,
    });

    const plan = await planWorkflow(deps, {
      goal: 'What does it mean to live a meaningful life?',
      taskId: 'task-llm-selection',
      collaborationDirective: directive,
    });

    const delegateSteps = plan.steps.filter((s) => s.strategy === 'delegate-sub-agent');
    const integratorSteps = plan.steps.filter((s) => s.strategy === 'llm-reasoning');
    const delegateAgentIds = delegateSteps.map((s) => s.agentId).sort();

    // LLM-chosen personas — proves the bypass is no longer alphabetical.
    expect(delegateAgentIds).toEqual(['assistant', 'mentor', 'researcher'] as never);
    // Integrator slot reflects the LLM's pick, not the hardcoded
    // 'coordinator → defaultAgent()' fallback chain (here they happen to
    // match, but the wiring still proves the integrator preference flows
    // through).
    expect(integratorSteps).toHaveLength(1);
    expect(integratorSteps[0]!.agentId).toBe('coordinator' as never);
    // CollaborationBlock metadata still populated as before.
    expect(plan.collaborationBlock).toBeDefined();
    expect(plan.collaborationBlock!.groupMode).toBe('debate');
  });

  test('collaboration shortcut falls back to alphabetical when LLM selector returns invalid output', async () => {
    const agents: AgentSpec[] = [
      { id: 'developer', name: 'developer', description: 'TypeScript developer', role: 'developer' } as AgentSpec,
      { id: 'architect', name: 'architect', description: 'System architect', role: 'architect' } as AgentSpec,
      { id: 'author', name: 'author', description: 'Long-form writer', role: 'author' } as AgentSpec,
      { id: 'researcher', name: 'researcher', description: 'Researcher', role: 'researcher' } as AgentSpec,
      { id: 'coordinator', name: 'coordinator', description: 'Default coordinator', role: 'coordinator' } as AgentSpec,
      { id: 'mentor', name: 'mentor', description: 'Mentor', role: 'mentor' } as AgentSpec,
    ];
    const byId = new Map<string, AgentSpec>(agents.map((a) => [a.id, a]));
    const agentRegistry = {
      getAgent: (id: string) => byId.get(id) ?? null,
      listAgents: () => agents,
      defaultAgent: () => byId.get('coordinator') ?? agents[0]!,
      has: (id: string) => byId.has(id),
      registerAgent: () => {},
      unregisterAgent: () => false,
      unregisterAgentsForTask: () => [],
      mergeCapabilityClaims: () => false,
      getDerivedCapabilities: () => null,
      findCanonicalVerifier: () => null,
      assertA1Pair: () => ({ ok: true }),
    } as unknown as AgentRegistry;

    const directive: CollaborationDirective = {
      requestedPrimaryParticipantCount: 3,
      interactionMode: 'competition',
      rebuttalRounds: 0,
      sharedDiscussion: false,
      reviewerPolicy: 'none',
      managerClarificationAllowed: true,
      emitCompetitionVerdict: true,
      source: 'pre-llm-parser',
      matchedFragments: { count: '3' },
    };

    // Both attempts return invalid JSON → selector returns null → planner
    // falls back to alphabetical-by-class slicing in the deterministic path.
    const deps = makeDeps({
      agentRegistry,
      llmRegistry: {
        selectByTier: () => ({
          id: 'mock',
          generate: async () => ({ content: 'not json', tokensUsed: { input: 5, output: 5 } }),
        }),
      } as any,
    });

    const plan = await planWorkflow(deps, {
      goal: 'compete on a coding question',
      taskId: 'task-llm-fallback',
      collaborationDirective: directive,
    });

    const delegateSteps = plan.steps.filter((s) => s.strategy === 'delegate-sub-agent');
    const delegateAgentIds = delegateSteps.map((s) => s.agentId).sort();

    // Alphabetical generators slice (architect, author, developer) — the
    // legacy contract the rest of the test suite pins.
    expect(delegateAgentIds).toEqual(['architect', 'author', 'developer'] as never);
  });

  test('emitted steps[].dependencies is always an array, never undefined', async () => {
    // LLM returns a step that omits `dependencies` — schema defaults but emit
    // path should still produce an array (defensive `?? []`).
    const planWithoutDeps = JSON.stringify({
      goal: 'sparse plan',
      steps: [{ id: 'step1', description: 'lonely step', strategy: 'llm-reasoning' }],
      synthesisPrompt: 'Return step1.',
    });
    const { bus, events } = captureBus();
    const deps = makeDeps({
      bus,
      llmRegistry: {
        selectByTier: () => ({
          id: 'mock',
          generate: async () => ({ content: planWithoutDeps, tokensUsed: { input: 10, output: 10 } }),
        }),
      } as any,
    });

    await planWorkflow(deps, { goal: 'sparse plan', taskId: 'task-emit-deps' });

    expect(events).toHaveLength(1);
    expect(events[0]!.steps[0]!.dependencies).toEqual([]);
    expect(Array.isArray(events[0]!.steps[0]!.dependencies)).toBe(true);
  });
});
