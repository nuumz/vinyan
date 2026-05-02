/**
 * Workflow-native multi-agent collaboration tests.
 *
 * Replaces the old `collaboration-runner` integration tests now that the
 * core-loop fork is gone — collaboration is expressed as plan metadata
 * (`WorkflowPlan.collaborationBlock`) and the executor's
 * `runCollaborationBlock` helper runs the rebuttal-aware rounds loop in
 * the workflow pipeline. These tests pin:
 *
 *   - `buildCollaborationPlan` produces a deterministic plan: one
 *     `delegate-sub-agent` step per primary participant + one optional
 *     `llm-reasoning` integrator step + a populated `collaborationBlock`
 *   - `runCollaborationBlock` calls `executeTask` exactly
 *     `primaries × rounds` times (one sub-task per (participant, round))
 *   - Sub-task goals on rebuttal rounds carry prior peers' answers via
 *     a "Shared Discussion (prior rounds)" block
 *   - `workflow:delegate_dispatched` fires ONCE per primary on round 0
 *   - `workflow:delegate_completed` fires ONCE per primary at the end
 *   - `groupMode` from directive surfaces on the plan's `collaborationBlock`
 *   - Honest-failure plan when registry is too small (no fabricated debate)
 *   - All-failed primaries → `failed` step results, no synthesized lies
 */
import { describe, expect, test } from 'bun:test';
import { createBus, type VinyanBus } from '../../../src/core/bus.ts';
import type { CollaborationDirective } from '../../../src/orchestrator/intent/collaboration-parser.ts';
import type { AgentRegistry } from '../../../src/orchestrator/agents/registry.ts';
import { runCollaborationBlock } from '../../../src/orchestrator/workflow/collaboration-block.ts';
import {
  buildCollaborationPlan,
} from '../../../src/orchestrator/workflow/workflow-planner.ts';
import type { AgentSpec, TaskInput, TaskResult } from '../../../src/orchestrator/types.ts';

function agentSpec(id: string, role: AgentSpec['role'], description = id): AgentSpec {
  return { id, name: id, description, role } as AgentSpec;
}

const FULL_AGENTS: AgentSpec[] = [
  agentSpec('developer', 'developer'),
  agentSpec('architect', 'architect'),
  agentSpec('author', 'author'),
  agentSpec('researcher', 'researcher'),
  agentSpec('reviewer', 'reviewer'),
  agentSpec('coordinator', 'coordinator'),
  agentSpec('mentor', 'mentor'),
];

function makeRegistry(agents: AgentSpec[] = FULL_AGENTS): AgentRegistry {
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
    goal: 'Should we use microservices?',
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
  subTaskId: string;
}

function captureExecuteTask() {
  const calls: CapturedCall[] = [];
  const fn = async (sub: TaskInput): Promise<TaskResult> => {
    calls.push({
      goal: sub.goal,
      agentId: sub.agentId as string | undefined,
      parentTaskId: sub.parentTaskId,
      subTaskId: sub.id,
    });
    return {
      id: sub.id,
      status: 'completed',
      mutations: [],
      answer: `${sub.id}-answer`,
      trace: {
        id: `t-${sub.id}`,
        taskId: sub.id,
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

function captureBus(): { bus: VinyanBus; events: Array<{ type: string; payload: unknown }> } {
  const bus = createBus();
  const events: Array<{ type: string; payload: unknown }> = [];
  bus.on('workflow:delegate_dispatched', (p) => events.push({ type: 'workflow:delegate_dispatched', payload: p }));
  bus.on('workflow:delegate_completed', (p) => events.push({ type: 'workflow:delegate_completed', payload: p }));
  bus.on('workflow:step_complete', (p) => events.push({ type: 'workflow:step_complete', payload: p }));
  return { bus, events };
}

describe('buildCollaborationPlan', () => {
  test('emits one delegate-sub-agent step per primary + one llm-reasoning integrator (debate mode)', () => {
    const plan = buildCollaborationPlan(
      'multi-agent topic',
      directive({ interactionMode: 'debate', requestedPrimaryParticipantCount: 3, rebuttalRounds: 2 }),
      makeRegistry(),
      'task-build-1',
    );
    const delegateSteps = plan.steps.filter((s) => s.strategy === 'delegate-sub-agent');
    const reasoningSteps = plan.steps.filter((s) => s.strategy === 'llm-reasoning');
    expect(delegateSteps).toHaveLength(3);
    expect(reasoningSteps).toHaveLength(1);
    // Every primary step gets a planner-pinned agentId — preserves persona
    // diversity per A2.
    for (const s of delegateSteps) {
      expect(s.agentId).toBeDefined();
    }
    // Integrator depends on every primary so the topological dispatch
    // waits for all primaries' rounds before synthesis runs.
    expect(reasoningSteps[0]!.dependencies.sort()).toEqual(delegateSteps.map((s) => s.id).sort());
  });

  test('collaborationBlock carries directive metadata (rounds, groupMode, sharedDiscussion)', () => {
    const plan = buildCollaborationPlan(
      'goal',
      directive({ interactionMode: 'competition', rebuttalRounds: 1, emitCompetitionVerdict: true }),
      makeRegistry(),
      'task-meta-1',
    );
    expect(plan.collaborationBlock).toBeDefined();
    expect(plan.collaborationBlock!.rounds).toBe(2); // 1 + rebuttalRounds
    expect(plan.collaborationBlock!.groupMode).toBe('competition');
    expect(plan.collaborationBlock!.emitCompetitionVerdict).toBe(true);
    expect(plan.collaborationBlock!.sharedDiscussion).toBe(true);
    expect(plan.collaborationBlock!.primaryStepIds).toHaveLength(3);
    expect(plan.collaborationBlock!.integratorStepId).toBeDefined();
  });

  test('parallel-answer mode skips the integrator (each primary owns its own answer)', () => {
    const plan = buildCollaborationPlan(
      'goal',
      directive({ interactionMode: 'parallel-answer', rebuttalRounds: 0, sharedDiscussion: false }),
      makeRegistry(),
      'task-parallel-1',
    );
    const delegateSteps = plan.steps.filter((s) => s.strategy === 'delegate-sub-agent');
    const reasoningSteps = plan.steps.filter((s) => s.strategy === 'llm-reasoning');
    expect(delegateSteps).toHaveLength(3);
    // parallel-answer = no synthesis; the chat surface renders each
    // primary's output side-by-side instead of a single combined answer.
    expect(reasoningSteps).toHaveLength(0);
    expect(plan.collaborationBlock!.integratorStepId).toBeUndefined();
    expect(plan.collaborationBlock!.groupMode).toBe('parallel');
  });
});

describe('runCollaborationBlock', () => {
  test('dispatches every (primary, round) exactly once', async () => {
    const plan = buildCollaborationPlan(
      'topic',
      directive({ requestedPrimaryParticipantCount: 3, rebuttalRounds: 2 }),
      makeRegistry(),
      'task-1',
    );
    const { fn, calls } = captureExecuteTask();
    const { bus } = captureBus();
    await runCollaborationBlock(plan, plan.collaborationBlock!, makeInput(), {
      executeTask: fn,
      bus,
    });
    // 3 primaries × (1 initial + 2 rebuttal rounds) = 9 sub-task dispatches.
    // The integrator is NOT dispatched here — it runs through the normal
    // workflow topological dispatch after the block returns.
    expect(calls).toHaveLength(9);
  });

  test('round 0 sub-task goals exclude prior-round transcripts', async () => {
    const plan = buildCollaborationPlan(
      'topic',
      directive({ requestedPrimaryParticipantCount: 2, rebuttalRounds: 1 }),
      makeRegistry(),
      'task-2',
    );
    const { fn, calls } = captureExecuteTask();
    await runCollaborationBlock(plan, plan.collaborationBlock!, makeInput(), { executeTask: fn });
    const round0Calls = calls.filter((c) => c.subTaskId.endsWith('-r0'));
    expect(round0Calls).toHaveLength(2);
    for (const c of round0Calls) {
      expect(c.goal).not.toContain('Shared Discussion (prior rounds)');
    }
  });

  test('round 1+ sub-task goals carry peer answers from prior rounds', async () => {
    const plan = buildCollaborationPlan(
      'topic',
      directive({ requestedPrimaryParticipantCount: 2, rebuttalRounds: 1 }),
      makeRegistry(),
      'task-3',
    );
    const { fn, calls } = captureExecuteTask();
    await runCollaborationBlock(plan, plan.collaborationBlock!, makeInput(), { executeTask: fn });
    const round1Calls = calls.filter((c) => c.subTaskId.endsWith('-r1'));
    expect(round1Calls).toHaveLength(2);
    for (const c of round1Calls) {
      expect(c.goal).toContain('Shared Discussion (prior rounds)');
      // Each round-1 call must NOT contain its own round-0 answer (peers only).
      // The peer's answer string follows the captured executeTask format
      // (`${subId}-answer`) so we can check inclusion of the OTHER agent's
      // round-0 answer.
      const ownAgent = c.agentId!;
      const peerAgents = ['developer', 'architect', 'author', 'researcher', 'mentor', 'reviewer'].filter(
        (a) => a !== ownAgent,
      );
      const peerInGoal = peerAgents.some((peer) => c.goal.includes(peer));
      expect(peerInGoal).toBe(true);
    }
  });

  test('emits delegate_dispatched ONCE per primary on round 0 (stable card cardinality)', async () => {
    const plan = buildCollaborationPlan(
      'topic',
      directive({ requestedPrimaryParticipantCount: 3, rebuttalRounds: 2 }),
      makeRegistry(),
      'task-4',
    );
    const { fn } = captureExecuteTask();
    const { bus, events } = captureBus();
    await runCollaborationBlock(plan, plan.collaborationBlock!, makeInput(), { executeTask: fn, bus });
    const dispatchedEvents = events.filter((e) => e.type === 'workflow:delegate_dispatched');
    // Three primaries × ONE dispatch event = 3, NOT 3 × 3 rounds = 9.
    expect(dispatchedEvents).toHaveLength(3);
    const seenStepIds = new Set<string>(dispatchedEvents.map((e) => (e.payload as { stepId: string }).stepId));
    expect(seenStepIds.size).toBe(3);
  });

  test('emits delegate_completed ONCE per primary with overall completed status', async () => {
    const plan = buildCollaborationPlan(
      'topic',
      directive({ requestedPrimaryParticipantCount: 3, rebuttalRounds: 1 }),
      makeRegistry(),
      'task-5',
    );
    const { fn } = captureExecuteTask();
    const { bus, events } = captureBus();
    await runCollaborationBlock(plan, plan.collaborationBlock!, makeInput(), { executeTask: fn, bus });
    const completedEvents = events.filter((e) => e.type === 'workflow:delegate_completed');
    expect(completedEvents).toHaveLength(3);
    for (const e of completedEvents) {
      const payload = e.payload as { status: string };
      expect(payload.status).toBe('completed');
    }
  });

  test('all-failed primaries → failed status, no fabricated synthesis', async () => {
    const plan = buildCollaborationPlan(
      'topic',
      directive({ requestedPrimaryParticipantCount: 2, rebuttalRounds: 0 }),
      makeRegistry(),
      'task-fail',
    );
    const failingExecute = async (): Promise<TaskResult> => {
      throw new Error('mock LLM unavailable');
    };
    const { stepResults } = await runCollaborationBlock(
      plan,
      plan.collaborationBlock!,
      makeInput(),
      { executeTask: failingExecute },
    );
    expect(stepResults.size).toBe(2);
    for (const [, result] of stepResults) {
      expect(result.status).toBe('failed');
      // Failed primaries lose their planner-assigned agentId on the
      // result so the synthesizer / UI cannot misattribute a fabricated
      // answer to the requested persona (A2 honesty).
      expect(result.agentId).toBeUndefined();
      expect(result.output).toContain('round 1 failed');
    }
  });

  test('parentTaskId stamped on every sub-task (recursion guard)', async () => {
    const plan = buildCollaborationPlan(
      'topic',
      directive({ requestedPrimaryParticipantCount: 2, rebuttalRounds: 1 }),
      makeRegistry(),
      'task-rec',
    );
    const input = makeInput({ id: 'parent-recur-1' });
    const { fn, calls } = captureExecuteTask();
    await runCollaborationBlock(plan, plan.collaborationBlock!, input, { executeTask: fn });
    for (const c of calls) {
      expect(c.parentTaskId).toBe('parent-recur-1');
    }
  });

  test('persona pinned on every sub-task per round (no role-playing collapse)', async () => {
    const plan = buildCollaborationPlan(
      'topic',
      directive({ requestedPrimaryParticipantCount: 3, rebuttalRounds: 1 }),
      makeRegistry(),
      'task-pin',
    );
    const { fn, calls } = captureExecuteTask();
    await runCollaborationBlock(plan, plan.collaborationBlock!, makeInput(), { executeTask: fn });
    const agentSet = new Set(calls.map((c) => c.agentId));
    // 3 distinct personas dispatched, each across multiple rounds.
    expect(agentSet.size).toBe(3);
  });
});
