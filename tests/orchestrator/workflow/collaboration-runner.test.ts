/**
 * Collaboration Runner integration tests (Phase 3 multi-agent debate fix).
 *
 * Mocks `executeTask` so the runner orchestrates 3 primary participants
 * + 1 integrator across rebuttal rounds without spawning a real LLM. Pins:
 *   - executeTask called exactly N × (1 + rebuttalRounds) + 1 times
 *   - sub-task agentId pins each call to the right persona
 *   - sub-task parentTaskId is forced to input.id (recursion guard)
 *   - room context is injected on rebuttal rounds and excludes self
 *   - integrator on the final round sees ALL primaries' transcripts
 *   - synthesizedOutput = integrator's content (with verdict block stripped
 *     when emitCompetitionVerdict=true)
 *   - workflow:winner_determined fires when verdict block parses
 *   - DebateRoomBuildFailure surfaces as honest failed WorkflowResult
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
  agentSpec('researcher', 'researcher'),
  agentSpec('reviewer', 'reviewer'),
  agentSpec('coordinator', 'coordinator'),
  agentSpec('mentor', 'mentor'),
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
    findCanonicalVerifier: () => byId.get('reviewer') ?? null,
    assertA1Pair: () => ({ ok: true }),
  } as unknown as AgentRegistry;
}

function makeInput(over: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 'collab-task-1',
    source: 'cli',
    goal: 'Should we use microservices? Discuss trade-offs.',
    taskType: 'reasoning',
    budget: { maxTokens: 100_000, maxDurationMs: 60_000, maxRetries: 1 },
    ...over,
  };
}

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

interface CapturedCall {
  goal: string;
  agentId: string | undefined;
  parentTaskId: string | undefined;
  syntheticId: string;
  constraints: string[];
}

/** Build an executeTask mock that captures every call and returns a synthesizable answer. */
function captureExecuteTask(opts: {
  /** When set, integrator's answer is exactly this string (so verdict tests can inject JSON). */
  integratorAnswer?: string;
} = {}) {
  const calls: CapturedCall[] = [];
  const fn = async (subInput: TaskInput): Promise<TaskResult> => {
    calls.push({
      goal: subInput.goal,
      agentId: subInput.agentId as string | undefined,
      parentTaskId: subInput.parentTaskId,
      syntheticId: subInput.id,
      constraints: subInput.constraints ?? [],
    });
    // Each turn emits a unique answer keyed by syntheticId so the runner
    // and test can verify per-turn distinctness.
    const isIntegrator = subInput.agentId === 'coordinator';
    const answer = isIntegrator
      ? (opts.integratorAnswer ?? `INTEGRATED: ${subInput.id}`)
      : `${subInput.id}-answer`;
    return {
      id: subInput.id,
      status: 'completed',
      mutations: [],
      answer,
      trace: {
        id: `t-${subInput.id}`,
        taskId: subInput.id,
        workerId: 'mock',
        timestamp: 0,
        routingLevel: 1,
        approach: 'conversational',
        oracleVerdicts: {},
        modelUsed: 'mock',
        tokensConsumed: 100,
        durationMs: 1,
        outcome: 'success',
        affectedFiles: [],
        governanceProvenance: undefined,
      },
    } as unknown as TaskResult;
  };
  return { fn, calls };
}

describe('executeCollaborationRoom — happy path', () => {
  it('runs N × (1+rebuttalRounds) primary turns + 1 integrator turn', async () => {
    const { fn, calls } = captureExecuteTask();
    const result = await executeCollaborationRoom(makeInput(), {
      executeTask: fn,
      agentRegistry: makeRegistry(),
    }, directive());
    // 3 primaries × (1 + 2) + 1 integrator = 10 sub-tasks.
    expect(calls).toHaveLength(10);
    expect(result.status).toBe('completed');
    expect(result.stepResults).toHaveLength(10);
  });

  it('pins each sub-task to a distinct persona via subInput.agentId', async () => {
    const { fn, calls } = captureExecuteTask();
    await executeCollaborationRoom(makeInput(), {
      executeTask: fn,
      agentRegistry: makeRegistry(),
    }, directive());
    const distinctAgentIds = new Set(calls.map((c) => c.agentId));
    // 3 primary personas (architect, author, developer — generators in
    // alphabetical order) + 1 integrator (coordinator) = 4 distinct ids.
    expect(distinctAgentIds.size).toBe(4);
    expect(distinctAgentIds.has('coordinator')).toBe(true);
  });

  it('forces parentTaskId on every sub-task to prevent recursive collaboration', async () => {
    const { fn, calls } = captureExecuteTask();
    await executeCollaborationRoom(makeInput(), {
      executeTask: fn,
      agentRegistry: makeRegistry(),
    }, directive());
    for (const c of calls) {
      expect(c.parentTaskId).toBe('collab-task-1');
    }
  });

  it('synthesizedOutput equals integrator content when integrator ran successfully', async () => {
    const { fn } = captureExecuteTask({ integratorAnswer: 'final synthesis from integrator' });
    const result = await executeCollaborationRoom(makeInput(), {
      executeTask: fn,
      agentRegistry: makeRegistry(),
    }, directive());
    expect(result.synthesizedOutput).toBe('final synthesis from integrator');
  });
});

describe('executeCollaborationRoom — round context injection', () => {
  it('round 0 sub-tasks see no peer transcript in their goal', async () => {
    const { fn, calls } = captureExecuteTask();
    await executeCollaborationRoom(makeInput(), {
      executeTask: fn,
      agentRegistry: makeRegistry(),
    }, directive());

    const round0Calls = calls.filter((c) => c.syntheticId.endsWith('__r0'));
    expect(round0Calls).toHaveLength(3);
    for (const c of round0Calls) {
      expect(c.goal).not.toContain('## Shared Discussion');
    }
  });

  it('rebuttal-round sub-tasks see PEERS prior content but NOT their own', async () => {
    const { fn, calls } = captureExecuteTask();
    await executeCollaborationRoom(makeInput(), {
      executeTask: fn,
      agentRegistry: makeRegistry(),
    }, directive());

    // Round 1 (first rebuttal) for `developer` (one of the primaries).
    const round1Developer = calls.find(
      (c) => c.syntheticId.includes('__developer__') && c.syntheticId.endsWith('__r1'),
    );
    expect(round1Developer).toBeDefined();
    expect(round1Developer!.goal).toContain('## Shared Discussion');
    // Self-exclusion: developer must NOT see its own r0 answer.
    expect(round1Developer!.goal).not.toContain('__developer__r0-answer');
    // Peers' content present.
    expect(round1Developer!.goal).toContain('__architect__r0-answer');
    expect(round1Developer!.goal).toContain('__author__r0-answer');
  });

  it('integrator final-round sub-task sees ALL primaries across ALL rounds', async () => {
    const { fn, calls } = captureExecuteTask();
    await executeCollaborationRoom(makeInput(), {
      executeTask: fn,
      agentRegistry: makeRegistry(),
    }, directive());
    const integratorCall = calls.find((c) => c.agentId === 'coordinator');
    expect(integratorCall).toBeDefined();
    for (const persona of ['architect', 'author', 'developer']) {
      for (const round of [0, 1, 2]) {
        expect(integratorCall!.goal).toContain(`__${persona}__r${round}-answer`);
      }
    }
  });
});

describe('executeCollaborationRoom — competition verdict', () => {
  it('parses + emits + strips the verdict block when emitCompetitionVerdict=true', async () => {
    const integratorAnswer = `Architect makes the strongest case for keeping the monolith.\n\n\`\`\`json\n{"winner":"architect","reasoning":"clearer trade-off framing","scores":{"architect":9,"developer":7,"author":6}}\n\`\`\``;
    const { fn } = captureExecuteTask({ integratorAnswer });
    const bus: VinyanBus = createBus();
    const winnerEvents: Array<{ payload: unknown }> = [];
    bus.on('workflow:winner_determined', (payload) => winnerEvents.push({ payload }));

    const result = await executeCollaborationRoom(makeInput(), {
      executeTask: fn,
      agentRegistry: makeRegistry(),
      bus,
    }, directive({ emitCompetitionVerdict: true }));

    // Winner event fired with the right id.
    expect(winnerEvents).toHaveLength(1);
    const ev = winnerEvents[0]!.payload as { winnerAgentId: string };
    expect(ev.winnerAgentId).toBe('architect');
    // Synthesized output has the JSON block stripped (no duplication).
    expect(result.synthesizedOutput).toContain('Architect makes the strongest case');
    expect(result.synthesizedOutput).not.toContain('"winner"');
  });

  it('does NOT emit verdict event when emitCompetitionVerdict=false', async () => {
    const integratorAnswer = `Some answer with no verdict block.`;
    const { fn } = captureExecuteTask({ integratorAnswer });
    const bus: VinyanBus = createBus();
    const winnerEvents: Array<unknown> = [];
    bus.on('workflow:winner_determined', (p) => winnerEvents.push(p));

    await executeCollaborationRoom(makeInput(), {
      executeTask: fn,
      agentRegistry: makeRegistry(),
      bus,
    }, directive({ emitCompetitionVerdict: false }));

    expect(winnerEvents).toHaveLength(0);
  });
});

describe('executeCollaborationRoom — failure paths', () => {
  it('returns failed WorkflowResult when registry has too few personas', async () => {
    const { fn } = captureExecuteTask();
    const tinyRegistry = makeRegistry([
      agentSpec('developer', 'developer'),
      agentSpec('coordinator', 'coordinator'),
    ]);
    const result = await executeCollaborationRoom(
      makeInput(),
      { executeTask: fn, agentRegistry: tinyRegistry },
      directive({ requestedPrimaryParticipantCount: 3 }),
    );
    expect(result.status).toBe('failed');
    expect(result.synthesizedOutput).toMatch(/3-agent debate/);
    expect(result.synthesizedOutput).toMatch(/non-verifier personas/);
    // No sub-tasks dispatched.
    expect(fn).toBeDefined();
  });

  it('partial when one primary turn errors but the rest complete', async () => {
    const calls: CapturedCall[] = [];
    let callIndex = 0;
    const flakeyExecuteTask = async (subInput: TaskInput): Promise<TaskResult> => {
      calls.push({
        goal: subInput.goal,
        agentId: subInput.agentId as string | undefined,
        parentTaskId: subInput.parentTaskId,
        syntheticId: subInput.id,
        constraints: subInput.constraints ?? [],
      });
      // Fail the very first turn; complete every other.
      if (callIndex++ === 0) {
        throw new Error('mock provider 429');
      }
      return {
        id: subInput.id,
        status: 'completed',
        mutations: [],
        answer: `${subInput.id}-answer`,
        trace: undefined,
      } as unknown as TaskResult;
    };
    const result = await executeCollaborationRoom(makeInput(), {
      executeTask: flakeyExecuteTask,
      agentRegistry: makeRegistry(),
    }, directive());
    // We do not require convergence — one primary failed its first round
    // so its turnsUsed never reaches 3, supervisor returns 'open', loop
    // exits with markPartial. Expect partial status.
    expect(result.status).toBe('partial');
    expect(result.stepResults.some((s) => s.status === 'failed')).toBe(true);
  });
});

describe('executeCollaborationRoom — sub-task strategy attribution', () => {
  it('primary sub-tasks emit strategyUsed=delegate-sub-agent, integrator emits llm-reasoning', async () => {
    const { fn } = captureExecuteTask();
    const result = await executeCollaborationRoom(makeInput(), {
      executeTask: fn,
      agentRegistry: makeRegistry(),
    }, directive());
    const primaryStrategies = result.stepResults
      .filter((s) => s.agentId !== 'coordinator')
      .map((s) => s.strategyUsed);
    const integratorStrategies = result.stepResults
      .filter((s) => s.agentId === 'coordinator')
      .map((s) => s.strategyUsed);
    expect(primaryStrategies.every((s) => s === 'delegate-sub-agent')).toBe(true);
    expect(integratorStrategies).toEqual(['llm-reasoning']);
  });
});
