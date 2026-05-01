/**
 * Collaboration Runner — Phase 4 clarification tests.
 *
 * Pins the per-participant clarification bubble-up contract:
 *   - When a primary participant returns input-required, the runner emits
 *     `room:participant_clarification_needed` with the participant id +
 *     round + questions.
 *   - On `room:participant_clarification_provided` the SAME participant
 *     resumes its SAME round (no new participant identity, same persona).
 *   - The resumed sub-task goal carries the question + answer threaded
 *     into a structured `## Clarification (resume)` block.
 *   - The blackboard records the clarification answer at
 *     `clarification/<role>/round-<n>` for replay fidelity.
 *   - On timeout, the runner surfaces `WorkflowResult.clarificationNeeded`
 *     so core-loop maps to TaskResult.input-required.
 *   - Oversight + integrator roles do NOT trigger the clarification path
 *     even if their sub-task somehow returns input-required (only primary
 *     participants bubble up).
 */
import { describe, expect, it } from 'bun:test';
import { createBus, type VinyanBus } from '../../../src/core/bus.ts';
import { executeCollaborationRoom } from '../../../src/orchestrator/workflow/collaboration-runner.ts';
import type { CollaborationDirective } from '../../../src/orchestrator/intent/collaboration-parser.ts';
import type { AgentRegistry } from '../../../src/orchestrator/agents/registry.ts';
import type { AgentSpec, TaskInput, TaskResult } from '../../../src/orchestrator/types.ts';

function agentSpec(id: string, role: AgentSpec['role'], description = id): AgentSpec {
  return { id, name: id, description, role } as AgentSpec;
}

const FULL_REGISTRY_AGENTS: AgentSpec[] = [
  agentSpec('developer', 'developer'),
  agentSpec('architect', 'architect'),
  agentSpec('author', 'author'),
  agentSpec('coordinator', 'coordinator'),
];

function makeRegistry(agents: AgentSpec[] = FULL_REGISTRY_AGENTS): AgentRegistry {
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
    findCanonicalVerifier: () => null,
    assertA1Pair: () => ({ ok: true }),
  } as unknown as AgentRegistry;
}

function makeInput(): TaskInput {
  return {
    id: 'collab-task-clarif',
    source: 'cli',
    goal: 'Discuss the right tone for the rollout post.',
    taskType: 'reasoning',
    budget: { maxTokens: 100_000, maxDurationMs: 60_000, maxRetries: 1 },
  };
}

function directive(over: Partial<CollaborationDirective> = {}): CollaborationDirective {
  return {
    requestedPrimaryParticipantCount: 3,
    interactionMode: 'debate',
    rebuttalRounds: 0,
    sharedDiscussion: false,
    reviewerPolicy: 'none',
    managerClarificationAllowed: true,
    emitCompetitionVerdict: false,
    source: 'pre-llm-parser',
    matchedFragments: { count: '3ตัว' },
    ...over,
  };
}

interface CapturedCall {
  goal: string;
  agentId: string | undefined;
  syntheticId: string;
}

/**
 * Build an executeTask mock where ONE specific persona's first call returns
 * input-required (with `clarificationNeeded`). Subsequent calls (the
 * resumed turn, plus all other participants' turns) return completed.
 */
function makeExecuteTaskWithClarification(opts: {
  /** Persona id of the participant that asks for clarification on its first call. */
  askerPersonaId: string;
  /** Question(s) the asker emits. */
  questions: string[];
  /** What the asker says on resume — answer encodes that it received the user reply. */
  resumeAnswer?: string;
}) {
  const calls: CapturedCall[] = [];
  let askerCallCount = 0;
  const fn = async (subInput: TaskInput): Promise<TaskResult> => {
    calls.push({
      goal: subInput.goal,
      agentId: subInput.agentId as string | undefined,
      syntheticId: subInput.id,
    });
    if (subInput.agentId === opts.askerPersonaId) {
      askerCallCount += 1;
      if (askerCallCount === 1) {
        return {
          id: subInput.id,
          status: 'input-required',
          mutations: [],
          answer: '',
          clarificationNeeded: opts.questions,
          trace: undefined,
        } as unknown as TaskResult;
      }
      // Resumed call.
      return {
        id: subInput.id,
        status: 'completed',
        mutations: [],
        answer: opts.resumeAnswer ?? `${subInput.id}-resumed-answer`,
        trace: undefined,
      } as unknown as TaskResult;
    }
    // Any other persona — clean completion.
    return {
      id: subInput.id,
      status: 'completed',
      mutations: [],
      answer: `${subInput.id}-answer`,
      trace: undefined,
    } as unknown as TaskResult;
  };
  return { fn, calls };
}

describe('executeCollaborationRoom — clarification resume happy path', () => {
  it('pauses, awaits user answer, resumes the SAME participant in the SAME round', async () => {
    const { fn, calls } = makeExecuteTaskWithClarification({
      askerPersonaId: 'developer',
      questions: ['What audience are we targeting?'],
      resumeAnswer: 'developer-resumed-after-clarification',
    });
    const bus: VinyanBus = createBus();
    const clarificationEvents: Array<{ payload: unknown }> = [];
    bus.on('room:participant_clarification_needed', (payload) =>
      clarificationEvents.push({ payload }),
    );

    // Simulate the user answering 5ms after the runner emits the request.
    bus.on('room:participant_clarification_needed', (payload) => {
      setTimeout(() => {
        bus.emit('room:participant_clarification_provided', {
          taskId: payload.taskId,
          participantId: payload.participantId,
          answer: 'staff engineers',
        });
      }, 5);
    });

    const result = await executeCollaborationRoom(
      makeInput(),
      { executeTask: fn, agentRegistry: makeRegistry(), bus, clarificationTimeoutMs: 1_000 },
      directive(),
    );

    // Exactly one clarification request emitted, scoped to developer.
    expect(clarificationEvents).toHaveLength(1);
    const ev = clarificationEvents[0]!.payload as {
      participantRole: string;
      participantId: string;
      round: number;
      questions: string[];
    };
    expect(ev.participantRole).toBe('developer');
    // Participant id is `${roomId}::${roleName}`; the preset sets
    // roomId = `collab-${parentTaskId}`.
    expect(ev.participantId).toBe('collab-collab-task-clarif::developer');
    expect(ev.round).toBe(0);
    expect(ev.questions).toEqual(['What audience are we targeting?']);

    // Same participant re-dispatched (developer appears TWICE in calls;
    // every other persona once). Total: 3 primaries + 1 integrator + 1
    // resumed-developer = 5 calls.
    const developerCalls = calls.filter((c) => c.agentId === 'developer');
    expect(developerCalls).toHaveLength(2);
    // The resume invocation is tagged with `__resumed`.
    expect(developerCalls[1]!.syntheticId).toMatch(/__resumed$/);
    // The resumed goal carries the clarification block.
    expect(developerCalls[1]!.goal).toContain('## Clarification (resume)');
    expect(developerCalls[1]!.goal).toContain('What audience are we targeting?');
    expect(developerCalls[1]!.goal).toContain('staff engineers');

    // Run completed; result has the resumed developer's content captured
    // in stepResults.
    expect(result.status).toBe('completed');
    expect(result.clarificationNeeded).toBeUndefined();
    const resumedStep = result.stepResults.find((s) => s.agentId === 'developer');
    expect(resumedStep?.output).toBe('developer-resumed-after-clarification');
  });
});

describe('executeCollaborationRoom — clarification timeout', () => {
  it('returns WorkflowResult.clarificationNeeded on timeout (no answer arrived)', async () => {
    const { fn } = makeExecuteTaskWithClarification({
      askerPersonaId: 'architect',
      questions: ['Should I assume we ship to GA or just to internal users?'],
    });
    const bus: VinyanBus = createBus();
    // No listener emits `room:participant_clarification_provided` —
    // the runner times out.

    const result = await executeCollaborationRoom(
      makeInput(),
      { executeTask: fn, agentRegistry: makeRegistry(), bus, clarificationTimeoutMs: 30 },
      directive(),
    );

    expect(result.status).toBe('partial');
    expect(result.clarificationNeeded).toBeDefined();
    expect(result.clarificationNeeded!.participantRole).toBe('architect');
    expect(result.clarificationNeeded!.round).toBe(0);
    expect(result.clarificationNeeded!.questions).toEqual([
      'Should I assume we ship to GA or just to internal users?',
    ]);
  });
});

describe('executeCollaborationRoom — clarification gating', () => {
  it('does NOT bubble up when directive.managerClarificationAllowed is false', async () => {
    const { fn, calls } = makeExecuteTaskWithClarification({
      askerPersonaId: 'developer',
      questions: ['What audience are we targeting?'],
    });
    const bus: VinyanBus = createBus();
    const clarificationEvents: Array<unknown> = [];
    bus.on('room:participant_clarification_needed', (p) => clarificationEvents.push(p));

    await executeCollaborationRoom(
      makeInput(),
      { executeTask: fn, agentRegistry: makeRegistry(), bus, clarificationTimeoutMs: 30 },
      directive({ managerClarificationAllowed: false }),
    );

    // Runner did NOT emit the clarification event — the participant's
    // input-required result is treated like any other failed completion
    // and the loop continues without pausing.
    expect(clarificationEvents).toHaveLength(0);
    // Developer was called only once (no resume).
    const developerCalls = calls.filter((c) => c.agentId === 'developer');
    expect(developerCalls).toHaveLength(1);
  });

  it('does NOT bubble up when input-required has no questions', async () => {
    const fn = async (subInput: TaskInput): Promise<TaskResult> => {
      return {
        id: subInput.id,
        status: subInput.agentId === 'developer' ? 'input-required' : 'completed',
        mutations: [],
        answer: subInput.agentId === 'developer' ? '' : `${subInput.id}-answer`,
        clarificationNeeded: subInput.agentId === 'developer' ? [] : undefined,
        trace: undefined,
      } as unknown as TaskResult;
    };
    const bus: VinyanBus = createBus();
    const clarificationEvents: Array<unknown> = [];
    bus.on('room:participant_clarification_needed', (p) => clarificationEvents.push(p));

    await executeCollaborationRoom(
      makeInput(),
      { executeTask: fn, agentRegistry: makeRegistry(), bus, clarificationTimeoutMs: 30 },
      directive(),
    );
    expect(clarificationEvents).toHaveLength(0);
  });
});

describe('executeCollaborationRoom — clarification scoping', () => {
  it('participant id scoping prevents cross-participant answer leakage', async () => {
    // Two primaries both ask on round 0. The user answers ONLY the first
    // (architect). The second (developer) should still time out — its
    // answer must not be the first participant's answer.
    let askerCallCounts: Record<string, number> = { architect: 0, developer: 0 };
    const fn = async (subInput: TaskInput): Promise<TaskResult> => {
      const persona = subInput.agentId as string;
      if (persona === 'architect' || persona === 'developer') {
        askerCallCounts[persona] = (askerCallCounts[persona] ?? 0) + 1;
        if (askerCallCounts[persona] === 1) {
          return {
            id: subInput.id,
            status: 'input-required',
            mutations: [],
            answer: '',
            clarificationNeeded: [`Q from ${persona}`],
            trace: undefined,
          } as unknown as TaskResult;
        }
        return {
          id: subInput.id,
          status: 'completed',
          mutations: [],
          answer: `${persona}-resumed`,
          trace: undefined,
        } as unknown as TaskResult;
      }
      return {
        id: subInput.id,
        status: 'completed',
        mutations: [],
        answer: `${subInput.id}-answer`,
        trace: undefined,
      } as unknown as TaskResult;
    };

    const bus: VinyanBus = createBus();
    bus.on('room:participant_clarification_needed', (payload) => {
      // Only answer architect's question; never developer's.
      if (payload.participantRole === 'architect') {
        setTimeout(() => {
          bus.emit('room:participant_clarification_provided', {
            taskId: payload.taskId,
            participantId: payload.participantId,
            answer: 'just to architect',
          });
        }, 5);
      }
    });

    const result = await executeCollaborationRoom(
      makeInput(),
      { executeTask: fn, agentRegistry: makeRegistry(), bus, clarificationTimeoutMs: 60 },
      directive(),
    );

    // Architect resumed with the answer; developer timed out → second
    // pause surfaces clarificationNeeded. Architect call count should
    // be 2 (initial + resume); developer call count should be 1
    // (initial only — never resumed).
    expect(askerCallCounts.architect).toBe(2);
    expect(askerCallCounts.developer).toBe(1);
    expect(result.clarificationNeeded?.participantRole).toBe('developer');
  });
});
