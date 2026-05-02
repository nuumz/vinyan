/**
 * LLM persona selector tests.
 *
 * Pins the contract that downstream wiring (workflow-planner →
 * buildCollaborationPlan → buildDebateRoomContract) depends on:
 *
 *   - Successful LLM call with valid JSON returns branded primary +
 *     integrator ids that the registry actually has.
 *   - Validation rejects: count mismatch, unknown id, duplicate primary,
 *     reviewer/coordinator as primary, integrator-in-primaries.
 *   - Bad JSON, unparseable JSON, and provider errors all return null
 *     (caller falls back to alphabetical without throwing).
 *   - Registry too small to satisfy count after blocklist returns null
 *     short-circuit (no LLM call wasted).
 *   - 'fast' tier preferred when both fast + balanced registered.
 *   - The selector retries on the first invalid response.
 */
import { describe, expect, it } from 'bun:test';
import type { AgentRegistry } from '../../../../src/orchestrator/agents/registry.ts';
import type { CollaborationDirective } from '../../../../src/orchestrator/intent/collaboration-parser.ts';
import { createScriptedMockProvider } from '../../../../src/orchestrator/llm/mock-provider.ts';
import { LLMProviderRegistry } from '../../../../src/orchestrator/llm/provider-registry.ts';
import { selectPersonasViaLLM } from '../../../../src/orchestrator/room/presets/llm-persona-selector.ts';
import type { AgentSpec } from '../../../../src/orchestrator/types.ts';

function agentSpec(id: string, role: AgentSpec['role'], description = id): AgentSpec {
  return { id, name: id, description, role } as AgentSpec;
}

function makeRegistry(agents: AgentSpec[]): AgentRegistry {
  const byId = new Map<string, AgentSpec>(agents.map((a) => [a.id, a]));
  return {
    getAgent: (id: string) => byId.get(id) ?? null,
    listAgents: () => agents,
    defaultAgent: () => agents.find((a) => a.id === 'coordinator') ?? agents[0]!,
    has: (id: string) => byId.has(id),
    registerAgent: () => {},
    unregisterAgent: () => false,
    unregisterAgentsForTask: () => [],
    mergeCapabilityClaims: () => false,
    getDerivedCapabilities: () => null,
    findCanonicalVerifier: () => byId.get('reviewer') ?? null,
    assertA1Pair: () => ({ ok: true }),
  } as unknown as AgentRegistry;
}

const FULL_AGENTS: AgentSpec[] = [
  agentSpec('developer', 'developer', 'TypeScript developer'),
  agentSpec('architect', 'architect', 'System architect'),
  agentSpec('author', 'author', 'Long-form writer'),
  agentSpec('researcher', 'researcher', 'Researcher'),
  agentSpec('reviewer', 'reviewer', 'Code reviewer'),
  agentSpec('coordinator', 'coordinator', 'Default coordinator'),
  agentSpec('mentor', 'mentor', 'Mentor'),
  agentSpec('assistant', 'assistant', 'General assistant'),
  agentSpec('concierge', 'concierge', 'Concierge'),
];

function directive(over: Partial<CollaborationDirective> = {}): CollaborationDirective {
  return {
    requestedPrimaryParticipantCount: 3,
    interactionMode: 'debate',
    rebuttalRounds: 1,
    sharedDiscussion: true,
    reviewerPolicy: 'none',
    managerClarificationAllowed: true,
    emitCompetitionVerdict: false,
    source: 'pre-llm-parser',
    matchedFragments: { count: '3' },
    ...over,
  };
}

function makeLlmRegistryWith(content: string | string[], tier: 'fast' | 'balanced' = 'fast'): LLMProviderRegistry {
  const responses = (Array.isArray(content) ? content : [content]).map((c) => ({
    content: c,
    stopReason: 'end_turn' as const,
  }));
  const registry = new LLMProviderRegistry();
  registry.register(createScriptedMockProvider(responses, { id: `mock/${tier}`, tier }));
  return registry;
}

describe('selectPersonasViaLLM — happy path', () => {
  it('returns branded primary + integrator ids from valid LLM JSON', async () => {
    const llm = makeLlmRegistryWith(
      JSON.stringify({
        primaryPersonaIds: ['researcher', 'mentor', 'assistant'],
        integratorPersonaId: 'coordinator',
        rationale: 'broad inquiry mix',
      }),
    );
    const result = await selectPersonasViaLLM({
      goal: 'What is the meaning of consciousness?',
      directive: directive(),
      registry: makeRegistry(FULL_AGENTS),
      llmRegistry: llm,
    });
    expect(result).not.toBeNull();
    expect(result!.primaryIds).toEqual(['researcher', 'mentor', 'assistant'] as never);
    expect(result!.integratorId).toEqual('coordinator' as never);
    expect(result!.rationale).toBe('broad inquiry mix');
    expect(result!.attempts).toBe(1);
  });

  it('strips ```json fences from the LLM response', async () => {
    const llm = makeLlmRegistryWith(
      '```json\n' +
        JSON.stringify({
          primaryPersonaIds: ['developer', 'architect', 'author'],
          integratorPersonaId: 'coordinator',
        }) +
        '\n```',
    );
    const result = await selectPersonasViaLLM({
      goal: 'How should we structure the auth module?',
      directive: directive(),
      registry: makeRegistry(FULL_AGENTS),
      llmRegistry: llm,
    });
    expect(result).not.toBeNull();
    expect(result!.primaryIds).toHaveLength(3);
  });

  it('integrator is optional — selector survives missing integratorPersonaId', async () => {
    const llm = makeLlmRegistryWith(
      JSON.stringify({
        primaryPersonaIds: ['developer', 'architect', 'researcher'],
      }),
    );
    const result = await selectPersonasViaLLM({
      goal: 'Architecture review',
      directive: directive(),
      registry: makeRegistry(FULL_AGENTS),
      llmRegistry: llm,
    });
    expect(result).not.toBeNull();
    expect(result!.integratorId).toBeUndefined();
  });
});

describe('selectPersonasViaLLM — validation rejects bad output', () => {
  it('rejects count mismatch and falls back to null after retries', async () => {
    const llm = makeLlmRegistryWith([
      JSON.stringify({
        primaryPersonaIds: ['developer', 'architect'], // count=3 requested
        integratorPersonaId: 'coordinator',
      }),
      JSON.stringify({
        primaryPersonaIds: ['developer'], // still wrong on retry
        integratorPersonaId: 'coordinator',
      }),
    ]);
    const result = await selectPersonasViaLLM({
      goal: 'goal',
      directive: directive({ requestedPrimaryParticipantCount: 3 }),
      registry: makeRegistry(FULL_AGENTS),
      llmRegistry: llm,
    });
    expect(result).toBeNull();
  });

  it('rejects unknown persona id', async () => {
    const llm = makeLlmRegistryWith([
      JSON.stringify({
        primaryPersonaIds: ['developer', 'philosopher', 'author'],
        integratorPersonaId: 'coordinator',
      }),
      JSON.stringify({
        primaryPersonaIds: ['developer', 'wizard', 'author'],
        integratorPersonaId: 'coordinator',
      }),
    ]);
    const result = await selectPersonasViaLLM({
      goal: 'goal',
      directive: directive(),
      registry: makeRegistry(FULL_AGENTS),
      llmRegistry: llm,
    });
    expect(result).toBeNull();
  });

  it('rejects reviewer as primary (A1 reservation)', async () => {
    const llm = makeLlmRegistryWith([
      JSON.stringify({
        primaryPersonaIds: ['developer', 'reviewer', 'author'],
        integratorPersonaId: 'coordinator',
      }),
      JSON.stringify({
        primaryPersonaIds: ['developer', 'reviewer', 'author'],
        integratorPersonaId: 'coordinator',
      }),
    ]);
    const result = await selectPersonasViaLLM({
      goal: 'goal',
      directive: directive(),
      registry: makeRegistry(FULL_AGENTS),
      llmRegistry: llm,
    });
    expect(result).toBeNull();
  });

  it('rejects coordinator as primary (reserved for integrator slot)', async () => {
    const llm = makeLlmRegistryWith([
      JSON.stringify({
        primaryPersonaIds: ['developer', 'coordinator', 'author'],
        integratorPersonaId: 'mentor',
      }),
      JSON.stringify({
        primaryPersonaIds: ['developer', 'coordinator', 'author'],
        integratorPersonaId: 'mentor',
      }),
    ]);
    const result = await selectPersonasViaLLM({
      goal: 'goal',
      directive: directive(),
      registry: makeRegistry(FULL_AGENTS),
      llmRegistry: llm,
    });
    expect(result).toBeNull();
  });

  it('rejects duplicate primary id', async () => {
    const llm = makeLlmRegistryWith([
      JSON.stringify({
        primaryPersonaIds: ['developer', 'developer', 'author'],
        integratorPersonaId: 'coordinator',
      }),
      JSON.stringify({
        primaryPersonaIds: ['author', 'author', 'developer'],
        integratorPersonaId: 'coordinator',
      }),
    ]);
    const result = await selectPersonasViaLLM({
      goal: 'goal',
      directive: directive(),
      registry: makeRegistry(FULL_AGENTS),
      llmRegistry: llm,
    });
    expect(result).toBeNull();
  });

  it('drops integrator when it overlaps with a primary id (keeps the primaries)', async () => {
    const llm = makeLlmRegistryWith(
      JSON.stringify({
        primaryPersonaIds: ['developer', 'architect', 'author'],
        integratorPersonaId: 'developer', // already a primary
      }),
    );
    const result = await selectPersonasViaLLM({
      goal: 'goal',
      directive: directive(),
      registry: makeRegistry(FULL_AGENTS),
      llmRegistry: llm,
    });
    expect(result).not.toBeNull();
    expect(result!.primaryIds).toHaveLength(3);
    expect(result!.integratorId).toBeUndefined();
  });

  it('drops integrator when it is unknown (keeps the primaries)', async () => {
    const llm = makeLlmRegistryWith(
      JSON.stringify({
        primaryPersonaIds: ['developer', 'architect', 'author'],
        integratorPersonaId: 'overlord', // not in registry
      }),
    );
    const result = await selectPersonasViaLLM({
      goal: 'goal',
      directive: directive(),
      registry: makeRegistry(FULL_AGENTS),
      llmRegistry: llm,
    });
    expect(result).not.toBeNull();
    expect(result!.integratorId).toBeUndefined();
  });
});

describe('selectPersonasViaLLM — failure paths return null', () => {
  it('returns null when no provider is registered', async () => {
    const llm = new LLMProviderRegistry();
    const result = await selectPersonasViaLLM({
      goal: 'goal',
      directive: directive(),
      registry: makeRegistry(FULL_AGENTS),
      llmRegistry: llm,
    });
    expect(result).toBeNull();
  });

  it('returns null when registry is empty', async () => {
    const llm = makeLlmRegistryWith(JSON.stringify({ primaryPersonaIds: ['x', 'y', 'z'], integratorPersonaId: 'q' }));
    const result = await selectPersonasViaLLM({
      goal: 'goal',
      directive: directive(),
      registry: makeRegistry([]),
      llmRegistry: llm,
    });
    expect(result).toBeNull();
  });

  it('returns null when registry is too small to honour count after blocklist', async () => {
    // Only reviewer + coordinator remaining → 0 eligible primary slots; cannot satisfy count=3.
    const tiny = makeRegistry([agentSpec('reviewer', 'reviewer'), agentSpec('coordinator', 'coordinator')]);
    const llm = makeLlmRegistryWith(JSON.stringify({ primaryPersonaIds: ['a', 'b', 'c'], integratorPersonaId: 'd' }));
    const result = await selectPersonasViaLLM({
      goal: 'goal',
      directive: directive({ requestedPrimaryParticipantCount: 3 }),
      registry: tiny,
      llmRegistry: llm,
    });
    expect(result).toBeNull();
  });

  it('returns null on unparseable JSON', async () => {
    const llm = makeLlmRegistryWith(['not json at all', 'still not json']);
    const result = await selectPersonasViaLLM({
      goal: 'goal',
      directive: directive(),
      registry: makeRegistry(FULL_AGENTS),
      llmRegistry: llm,
    });
    expect(result).toBeNull();
  });

  it('returns null when JSON parses but schema rejects', async () => {
    const llm = makeLlmRegistryWith([
      JSON.stringify({ wrongShape: true }),
      JSON.stringify({ primaryPersonaIds: 'not-an-array' }),
    ]);
    const result = await selectPersonasViaLLM({
      goal: 'goal',
      directive: directive(),
      registry: makeRegistry(FULL_AGENTS),
      llmRegistry: llm,
    });
    expect(result).toBeNull();
  });
});

describe('selectPersonasViaLLM — retry path', () => {
  it('retries on the first invalid response and returns the second valid one', async () => {
    const llm = makeLlmRegistryWith([
      'totally not json',
      JSON.stringify({
        primaryPersonaIds: ['developer', 'architect', 'researcher'],
        integratorPersonaId: 'coordinator',
        rationale: 'second-attempt success',
      }),
    ]);
    const result = await selectPersonasViaLLM({
      goal: 'goal',
      directive: directive(),
      registry: makeRegistry(FULL_AGENTS),
      llmRegistry: llm,
    });
    expect(result).not.toBeNull();
    expect(result!.attempts).toBe(2);
    expect(result!.rationale).toBe('second-attempt success');
  });
});
