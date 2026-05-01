/**
 * Debate Room Preset tests (Phase 3 multi-agent debate fix).
 *
 * Pins the contract shape the collaboration runner depends on:
 *   - exactly N primary roles (no oversight/integrator inflation)
 *   - reviewerPolicy='explicit' adds 1 oversight outside the primary count
 *   - parallel-answer mode skips the integrator
 *   - generator-class personas preferred over mixed-class
 *   - canonical verifier (`reviewer`) NEVER picked as primary
 *   - too few personas → DebateRoomBuildFailure
 */
import { describe, expect, it } from 'bun:test';
import {
  buildDebateRoomContract,
  DEBATE_ROOM_DEFAULTS,
  DebateRoomBuildFailure,
} from '../../../../src/orchestrator/room/presets/debate-room.ts';
import type { CollaborationDirective } from '../../../../src/orchestrator/intent/collaboration-parser.ts';
import type { AgentRegistry } from '../../../../src/orchestrator/agents/registry.ts';
import type { AgentSpec } from '../../../../src/orchestrator/types.ts';
import { effectiveRoleClass } from '../../../../src/orchestrator/room/types.ts';

function agentSpec(id: string, role: AgentSpec['role'], description = id): AgentSpec {
  return { id, name: id, description, role } as AgentSpec;
}

/** Minimal AgentRegistry stub backed by a fixed agent list. */
function makeRegistry(agents: AgentSpec[], canonicalVerifierId?: string): AgentRegistry {
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
    findCanonicalVerifier: () =>
      canonicalVerifierId ? (byId.get(canonicalVerifierId) ?? null) : null,
    assertA1Pair: () => ({ ok: true }),
  } as unknown as AgentRegistry;
}

const FULL_REGISTRY_AGENTS: AgentSpec[] = [
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
    rebuttalRounds: 2,
    sharedDiscussion: true,
    reviewerPolicy: 'none',
    managerClarificationAllowed: true,
    emitCompetitionVerdict: false,
    source: 'pre-llm-parser',
    matchedFragments: { count: '3ตัว' },
    ...over,
  };
}

describe('buildDebateRoomContract — basic shape', () => {
  it('builds 3 primary + 1 integrator roles for a 3-agent debate with rebuttalRounds=2', () => {
    const registry = makeRegistry(FULL_REGISTRY_AGENTS, 'reviewer');
    const bundle = buildDebateRoomContract({
      parentTaskId: 'task-1',
      goal: 'discuss',
      directive: directive(),
      registry,
    });

    const primaryCount = bundle.contract.roles.filter(
      (r) => effectiveRoleClass(r) === 'primary-participant',
    ).length;
    const oversightCount = bundle.contract.roles.filter(
      (r) => effectiveRoleClass(r) === 'oversight',
    ).length;
    const integratorCount = bundle.contract.roles.filter(
      (r) => effectiveRoleClass(r) === 'integrator',
    ).length;

    expect(primaryCount).toBe(3);
    expect(oversightCount).toBe(0);
    expect(integratorCount).toBe(1);
    expect(bundle.contract.outputMode).toBe('text-answer');
    expect(bundle.contract.rebuttalRounds).toBe(2);
    // maxRounds = 1 (initial) + 2 (rebuttal) + 1 (integrator) = 4.
    expect(bundle.contract.maxRounds).toBe(4);
    expect(bundle.contract.minRounds).toBe(0);
    expect(bundle.primaryParticipantIds).toHaveLength(3);
    // Branded PersonaId compared as plain string to avoid casting noise.
    expect(String(bundle.integratorParticipantId)).toBe('coordinator');
    expect(bundle.oversightParticipantId).toBeNull();
  });

  it('reviewerPolicy="explicit" adds 1 oversight role WITHOUT inflating primary count', () => {
    const registry = makeRegistry(FULL_REGISTRY_AGENTS, 'reviewer');
    const bundle = buildDebateRoomContract({
      parentTaskId: 'task-1',
      goal: 'discuss',
      directive: directive({ reviewerPolicy: 'explicit' }),
      registry,
    });

    const primaryCount = bundle.contract.roles.filter(
      (r) => effectiveRoleClass(r) === 'primary-participant',
    ).length;
    const oversightCount = bundle.contract.roles.filter(
      (r) => effectiveRoleClass(r) === 'oversight',
    ).length;
    expect(primaryCount).toBe(3);
    expect(oversightCount).toBe(1);
    expect(String(bundle.oversightParticipantId)).toBe('reviewer');
  });

  it('parallel-answer mode skips the integrator role', () => {
    const registry = makeRegistry(FULL_REGISTRY_AGENTS, 'reviewer');
    const bundle = buildDebateRoomContract({
      parentTaskId: 'task-1',
      goal: 'discuss',
      directive: directive({ interactionMode: 'parallel-answer', rebuttalRounds: 0 }),
      registry,
    });

    const integratorCount = bundle.contract.roles.filter(
      (r) => effectiveRoleClass(r) === 'integrator',
    ).length;
    expect(integratorCount).toBe(0);
    expect(bundle.integratorParticipantId).toBeNull();
    // Without integrator: maxRounds = 1 + 0 = 1.
    expect(bundle.contract.maxRounds).toBe(1);
  });

  it('every primary role pins personaId so the dispatcher routes to the right soul', () => {
    const registry = makeRegistry(FULL_REGISTRY_AGENTS, 'reviewer');
    const bundle = buildDebateRoomContract({
      parentTaskId: 'task-1',
      goal: 'discuss',
      directive: directive(),
      registry,
    });
    const primaries = bundle.contract.roles.filter(
      (r) => effectiveRoleClass(r) === 'primary-participant',
    );
    for (const r of primaries) {
      expect(r.personaId).toBeDefined();
      expect(String(r.personaId)).toBe(r.name);
    }
  });
});

describe('buildDebateRoomContract — persona selection precedence', () => {
  it('prefers generator-class personas over mixed-class', () => {
    const registry = makeRegistry(FULL_REGISTRY_AGENTS, 'reviewer');
    const bundle = buildDebateRoomContract({
      parentTaskId: 'task-1',
      goal: 'discuss',
      directive: directive({ requestedPrimaryParticipantCount: 4 }),
      registry,
    });
    // Sort by id for deterministic comparison; the first four
    // generator-class agents (alphabetical) are: architect, author,
    // developer, researcher.
    const idsAsStrings = new Set(bundle.primaryParticipantIds.map(String));
    expect(idsAsStrings).toEqual(new Set(['architect', 'author', 'developer', 'researcher']));
  });

  it('NEVER picks the canonical verifier (reviewer) as a primary', () => {
    const registry = makeRegistry(FULL_REGISTRY_AGENTS, 'reviewer');
    const bundle = buildDebateRoomContract({
      parentTaskId: 'task-1',
      goal: 'discuss',
      directive: directive({ requestedPrimaryParticipantCount: 6 }),
      registry,
    });
    expect(bundle.primaryParticipantIds).not.toContain('reviewer');
    // We have 4 generators + 3 mixed (mentor, assistant, concierge —
    // coordinator is excluded as integrator). 6 picks fall within that pool.
    expect(bundle.primaryParticipantIds.length).toBe(6);
  });

  it('NEVER picks coordinator as a primary (reserved for integrator)', () => {
    const registry = makeRegistry(FULL_REGISTRY_AGENTS, 'reviewer');
    const bundle = buildDebateRoomContract({
      parentTaskId: 'task-1',
      goal: 'discuss',
      directive: directive({ requestedPrimaryParticipantCount: 6 }),
      registry,
    });
    expect(bundle.primaryParticipantIds).not.toContain('coordinator');
  });

  it('falls back to mixed-class personas when there are not enough generators', () => {
    const registry = makeRegistry(FULL_REGISTRY_AGENTS, 'reviewer');
    const bundle = buildDebateRoomContract({
      parentTaskId: 'task-1',
      goal: 'discuss',
      directive: directive({ requestedPrimaryParticipantCount: 6 }),
      registry,
    });
    // The 4 generators plus 2 mixed (alphabetical: assistant, concierge).
    const ids = bundle.primaryParticipantIds.map(String);
    expect(ids).toContain('assistant');
    expect(ids).toContain('concierge');
  });
});

describe('buildDebateRoomContract — failure paths', () => {
  it('throws DebateRoomBuildFailure when the registry has fewer eligible personas than requested', () => {
    // Tiny registry: 1 generator + 1 mixed (coordinator excluded as integrator).
    // No mixed-class personas left for primaries beyond the first generator.
    const registry = makeRegistry(
      [agentSpec('developer', 'developer'), agentSpec('coordinator', 'coordinator')],
      undefined,
    );
    expect(() =>
      buildDebateRoomContract({
        parentTaskId: 'task-1',
        goal: 'discuss',
        directive: directive({ requestedPrimaryParticipantCount: 3 }),
        registry,
      }),
    ).toThrow(DebateRoomBuildFailure);
  });
});

describe('buildDebateRoomContract — token budget sizing', () => {
  it('budget scales with primary count × rounds + integrator + oversight', () => {
    const registry = makeRegistry(FULL_REGISTRY_AGENTS, 'reviewer');
    const bundle = buildDebateRoomContract({
      parentTaskId: 'task-1',
      goal: 'discuss',
      directive: directive({
        requestedPrimaryParticipantCount: 3,
        rebuttalRounds: 2,
        reviewerPolicy: 'explicit',
      }),
      registry,
    });
    // 3 primaries × 3 rounds + 3 oversight rounds + 1 integrator = 13 turns.
    const expected = 13 * DEBATE_ROOM_DEFAULTS.PER_TURN_TOKEN_BUDGET;
    expect(bundle.contract.tokenBudget).toBe(expected);
  });

  it('respects the per-turn token budget override', () => {
    const registry = makeRegistry(FULL_REGISTRY_AGENTS, 'reviewer');
    const bundle = buildDebateRoomContract({
      parentTaskId: 'task-1',
      goal: 'discuss',
      directive: directive({ rebuttalRounds: 0 }),
      registry,
      perTurnTokenBudget: 2_000,
    });
    // 3 primaries × 1 round + 1 integrator = 4 turns × 2_000 = 8_000.
    expect(bundle.contract.tokenBudget).toBe(8_000);
  });
});
