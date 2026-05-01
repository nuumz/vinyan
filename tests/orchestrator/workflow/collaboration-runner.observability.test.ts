/**
 * Collaboration Runner — Phase 5 observability tests.
 *
 * Pins the UI-animation contract: a collaboration run is observable from
 * the same `workflow:plan_ready` / `workflow:delegate_dispatched` /
 * `workflow:delegate_completed` events the workflow-executor emits.
 * Without these the chat surface freezes during a 30-second run with no
 * indication that participants are working.
 *
 * Pinned:
 *   - `workflow:plan_ready` fires once at room open with a synthetic
 *     plan that lists each (participant, round) pair + integrator.
 *   - `workflow:delegate_dispatched` brackets every primary turn (and
 *     the integrator's synthesis turn).
 *   - `workflow:delegate_completed` brackets every turn with status +
 *     bounded outputPreview + tokensUsed.
 *   - dispatched/completed pair counts == executeTask call count for
 *     completed runs (no orphan events).
 *   - Synthetic stepIds are stable: dispatched and completed for the
 *     same turn carry the same `stepId`.
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
    id: 'collab-task-obs',
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

/** Capture every workflow:* event the runner emits, in order. */
function captureWorkflowEvents(bus: VinyanBus) {
  const planReady: Array<unknown> = [];
  const dispatched: Array<{ stepId: string; agentId: string | null; subTaskId: string }> = [];
  const completed: Array<{
    stepId: string;
    agentId: string | null;
    status: string;
    outputPreview: string;
    tokensUsed: number;
  }> = [];
  bus.on('workflow:plan_ready', (p) => planReady.push(p));
  bus.on('workflow:delegate_dispatched', (p) =>
    dispatched.push({ stepId: p.stepId, agentId: p.agentId, subTaskId: p.subTaskId }),
  );
  bus.on('workflow:delegate_completed', (p) =>
    completed.push({
      stepId: p.stepId,
      agentId: p.agentId,
      status: p.status,
      outputPreview: p.outputPreview,
      tokensUsed: p.tokensUsed,
    }),
  );
  return { planReady, dispatched, completed };
}

function makeExecuteTaskAlwaysSucceeds() {
  const fn = async (subInput: TaskInput): Promise<TaskResult> => ({
    id: subInput.id,
    status: 'completed',
    mutations: [],
    answer: `${subInput.id}-answer`,
    trace: {
      tokensConsumed: 100,
      durationMs: 1,
    },
  } as unknown as TaskResult);
  return fn;
}

describe('executeCollaborationRoom — workflow:plan_ready emission', () => {
  it('emits plan_ready once at room open with all (participant, round) + integrator steps', async () => {
    const bus = createBus();
    const events = captureWorkflowEvents(bus);
    await executeCollaborationRoom(
      makeInput(),
      { executeTask: makeExecuteTaskAlwaysSucceeds(), agentRegistry: makeRegistry(), bus },
      directive(),
    );

    expect(events.planReady).toHaveLength(1);
    const ev = events.planReady[0]! as {
      taskId: string;
      goal: string;
      steps: Array<{ id: string; description: string; strategy: string; dependencies: string[] }>;
      awaitingApproval: boolean;
    };
    expect(ev.taskId).toBe('collab-task-obs');
    expect(ev.awaitingApproval).toBe(false);
    // 3 primaries × 3 rounds + 1 integrator = 10 synthetic plan steps.
    expect(ev.steps).toHaveLength(10);
    // Round 0 primary steps have no dependencies.
    const round0Primaries = ev.steps.filter((s) => s.id.endsWith('-r0'));
    expect(round0Primaries).toHaveLength(3);
    for (const s of round0Primaries) expect(s.dependencies).toEqual([]);
    // Integrator depends on every primary's last (round 2) step.
    const integratorStep = ev.steps.find((s) => s.strategy === 'llm-reasoning');
    expect(integratorStep).toBeDefined();
    expect(integratorStep!.dependencies).toHaveLength(3);
    for (const dep of integratorStep!.dependencies) expect(dep).toMatch(/-r2$/);
  });
});

describe('executeCollaborationRoom — workflow:delegate_dispatched / completed bracketing', () => {
  it('emits dispatched + completed pair per executed turn, with stable stepId', async () => {
    const bus = createBus();
    const events = captureWorkflowEvents(bus);
    await executeCollaborationRoom(
      makeInput(),
      { executeTask: makeExecuteTaskAlwaysSucceeds(), agentRegistry: makeRegistry(), bus },
      directive(),
    );

    // 10 turns total = 10 dispatched + 10 completed.
    expect(events.dispatched).toHaveLength(10);
    expect(events.completed).toHaveLength(10);

    // dispatched/completed for the same turn share the same stepId.
    const dispatchedIds = new Set(events.dispatched.map((e) => e.stepId));
    const completedIds = new Set(events.completed.map((e) => e.stepId));
    expect(dispatchedIds).toEqual(completedIds);

    // Each completed event carries a non-empty preview + the step's tokens.
    for (const c of events.completed) {
      expect(c.status).toBe('completed');
      expect(c.outputPreview.length).toBeGreaterThan(0);
      expect(c.tokensUsed).toBe(100);
    }
  });

  it('completed.outputPreview is bounded so very long answers are truncated', async () => {
    // Answer with a 5000-char body; preview cap is 2000 chars. The truncated
    // preview ends with the truncation marker `…`.
    const longAnswer = 'a'.repeat(5_000);
    const fn = async (subInput: TaskInput): Promise<TaskResult> =>
      ({
        id: subInput.id,
        status: 'completed',
        mutations: [],
        answer: longAnswer,
        trace: { tokensConsumed: 50, durationMs: 1 },
      }) as unknown as TaskResult;
    const bus = createBus();
    const events = captureWorkflowEvents(bus);
    await executeCollaborationRoom(
      makeInput(),
      { executeTask: fn, agentRegistry: makeRegistry(), bus },
      directive({ rebuttalRounds: 0 }),
    );
    for (const c of events.completed) {
      expect(c.outputPreview.length).toBeLessThanOrEqual(2_001); // 2000 + ellipsis
      expect(c.outputPreview).toMatch(/…$/);
    }
  });

  it('emits delegate_completed with status=failed when the sub-task throws', async () => {
    const fn = async (_subInput: TaskInput): Promise<TaskResult> => {
      throw new Error('mock provider 429');
    };
    const bus = createBus();
    const events = captureWorkflowEvents(bus);
    // parallel-answer mode skips the integrator so this test focuses on
    // primary-turn failure behaviour without the integrator's adjacent turn.
    await executeCollaborationRoom(
      makeInput(),
      { executeTask: fn, agentRegistry: makeRegistry(), bus },
      directive({ rebuttalRounds: 0, interactionMode: 'parallel-answer' }),
    );
    // 3 primaries, all throw → 3 dispatched + 3 completed (all failed).
    expect(events.dispatched).toHaveLength(3);
    const failedCompleted = events.completed.filter((c) => c.status === 'failed');
    expect(failedCompleted).toHaveLength(3);
    for (const c of failedCompleted) {
      expect(c.outputPreview).toMatch(/Sub-task failed/);
    }
  });
});

describe('executeCollaborationRoom — synthetic stepId scheme', () => {
  it('stepId encodes role name + round so a UI consumer can correlate per-round events', async () => {
    const bus = createBus();
    const events = captureWorkflowEvents(bus);
    await executeCollaborationRoom(
      makeInput(),
      { executeTask: makeExecuteTaskAlwaysSucceeds(), agentRegistry: makeRegistry(), bus },
      directive(),
    );
    // Format is `p-${roleName}-r${round}`; e.g., `p-developer-r2`.
    for (const d of events.dispatched) {
      expect(d.stepId).toMatch(/^p-[a-z][a-z0-9-]*-r\d+$/);
    }
    // Developer appears on rounds 0, 1, 2 → 3 distinct stepIds for developer.
    const developerSteps = events.dispatched.filter((d) => d.stepId.startsWith('p-developer-'));
    expect(developerSteps).toHaveLength(3);
    expect(new Set(developerSteps.map((d) => d.stepId))).toEqual(
      new Set(['p-developer-r0', 'p-developer-r1', 'p-developer-r2']),
    );
  });
});
