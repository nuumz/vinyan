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

/**
 * Scripted executeTask stub for the CoT continuity tests. Emits
 * `kind:'thought'` and `kind:'tool_call'` audit:entry events on the
 * bus during each sub-task call so the collaboration-block's capture
 * subscription can pick them up. Mirrors `captureExecuteTask`'s call
 * shape so existing assertions still apply.
 *
 * Script keys:
 *   - `thoughtsBySubTaskId === 'all-r0'`   → emit one thought per
 *     round-0 sub-task with default content.
 *   - `thoughtsBySubTaskId === { id: [thoughts] }` → emit per-id.
 *   - `toolCallsBySubTaskId === 'all-r0-mutation'` → emit an executed
 *     `edit_file` tool call per round-0 sub-task (A4 mutation gate test).
 */
type ScriptedExecuteTask = ((sub: TaskInput) => Promise<TaskResult>) & {
  calls: CapturedCall[];
};
function scriptedExecuteTask(
  bus: VinyanBus,
  opts: {
    thoughtsBySubTaskId?:
      | 'all-r0'
      | Record<string, Array<{ content: string; trigger?: string; tsOffset?: number }>>;
    toolCallsBySubTaskId?: 'all-r0-mutation';
    thoughtTrigger?: string;
    thoughtContent?: string;
    /** Pin absolute ts for thought emit; overrides the live clock. */
    thoughtTsAbs?: number;
  },
): ScriptedExecuteTask {
  const calls: CapturedCall[] = [];
  const fn = (async (sub: TaskInput): Promise<TaskResult> => {
    calls.push({
      goal: sub.goal,
      agentId: sub.agentId as string | undefined,
      parentTaskId: sub.parentTaskId,
      subTaskId: sub.id,
    });

    const isRound0 = sub.id.endsWith('-r0');

    // Emit thought audit entry per the script BEFORE returning so the
    // FIFO-sync bus delivers it to the orchestrator's capture handler
    // by the time this Promise resolves.
    let scripted: Array<{ content: string; trigger?: string; tsOffset?: number }> | undefined;
    if (opts.thoughtsBySubTaskId === 'all-r0' && isRound0) {
      scripted = [
        {
          content: opts.thoughtContent ?? `${sub.id} reasoning content`,
          ...(opts.thoughtTrigger ? { trigger: opts.thoughtTrigger } : { trigger: 'pre-tool' }),
        },
      ];
    } else if (typeof opts.thoughtsBySubTaskId === 'object') {
      scripted = opts.thoughtsBySubTaskId[sub.id];
    }
    if (scripted) {
      for (const t of scripted) {
        const ts = opts.thoughtTsAbs ?? Date.now() + (t.tsOffset ?? 0);
        bus.emit('audit:entry', {
          id: `synth-${sub.id}-thought`,
          taskId: sub.id,
          ts,
          schemaVersion: 1,
          policyVersion: 'audit-v1',
          actor: { type: 'worker' },
          redactionPolicyHash: 'a'.repeat(64),
          kind: 'thought',
          content: t.content,
          ...(t.trigger
            ? { trigger: t.trigger as 'pre-tool' | 'post-tool' | 'plan' | 'reflect' | 'compaction' }
            : {}),
        } as never);
      }
    }
    if (opts.toolCallsBySubTaskId === 'all-r0-mutation' && isRound0) {
      bus.emit('audit:entry', {
        id: `synth-${sub.id}-tool`,
        taskId: sub.id,
        ts: Date.now(),
        schemaVersion: 1,
        policyVersion: 'audit-v1',
        actor: { type: 'worker' },
        redactionPolicyHash: 'a'.repeat(64),
        kind: 'tool_call',
        lifecycle: 'executed',
        toolId: 'edit_file',
        argsHash: '0'.repeat(64),
        argsRedacted: {},
      } as never);
    }

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
  }) as ScriptedExecuteTask;
  fn.calls = calls;
  return fn;
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

  test('emits paired audit:entry rows (subtask + subagent) per primary on dispatch', async () => {
    // The projection's `bySection.subAgents` reads from `kind:'subagent'`
    // audit rows. Without these emits the multi-agent debate parent shows
    // an empty Sub-Agents tab even though every primary actually ran.
    const plan = buildCollaborationPlan(
      'topic',
      directive({ requestedPrimaryParticipantCount: 3, rebuttalRounds: 1 }),
      makeRegistry(),
      'task-audit-pair',
    );
    const bus = createBus();
    const auditEvents: Array<{ kind: string; subTaskId?: string; subAgentId?: string; persona?: string }> = [];
    bus.on('audit:entry', (entry: unknown) => {
      const e = entry as {
        kind?: string;
        subTaskId?: string;
        subAgentId?: string;
        persona?: string;
      };
      if (e.kind === 'subtask' || e.kind === 'subagent') {
        auditEvents.push({
          kind: e.kind,
          ...(e.subTaskId ? { subTaskId: e.subTaskId } : {}),
          ...(e.subAgentId ? { subAgentId: e.subAgentId } : {}),
          ...(e.persona ? { persona: e.persona } : {}),
        });
      }
    });
    const { fn } = captureExecuteTask();
    const input = makeInput({ id: 'task-audit-pair' });
    await runCollaborationBlock(plan, plan.collaborationBlock!, input, { executeTask: fn, bus });
    const subtasks = auditEvents.filter((e) => e.kind === 'subtask');
    const subagents = auditEvents.filter((e) => e.kind === 'subagent');
    // 3 primaries × 1 dispatch each (cardinality contract: 1 card per agent).
    expect(subtasks).toHaveLength(3);
    expect(subagents).toHaveLength(3);
    // Subagent rows carry the planner-pinned persona so the UI's hierarchy
    // tab can label each agent without inferring it from the agent id.
    for (const sa of subagents) {
      expect(sa.persona).toBeDefined();
    }
    // Round-0 sub-task identity is shared between the two paired rows.
    const subtaskIds = subtasks.map((e) => e.subTaskId).sort();
    const subagentIds = subagents.map((e) => e.subAgentId).sort();
    expect(subtaskIds).toEqual(subagentIds);
  });

  // ── CoT continuity (L1) integration ────────────────────────────────
  // Each test below pins ONE axiom-derived gate from the design audit.
  // Pure-module tests for the gate engine itself live in
  // `cot-injection.test.ts`; these tests prove the wiring delivers the
  // verdict to the round-N+1 prompt + emits the A8 audit row.

  test('CoT inject — round 0 goal carries no CoT trail (baseline)', async () => {
    const plan = buildCollaborationPlan(
      'topic',
      directive({ requestedPrimaryParticipantCount: 2, rebuttalRounds: 1 }),
      makeRegistry(),
      'task-cot-baseline',
    );
    const { fn, calls } = captureExecuteTask();
    await runCollaborationBlock(plan, plan.collaborationBlock!, makeInput(), { executeTask: fn });
    const round0 = calls.filter((c) => c.subTaskId.endsWith('-r0'));
    for (const c of round0) {
      expect(c.goal).not.toContain('Your reasoning trail from round');
    }
  });

  test('CoT inject — round 1 goal contains own round-0 thoughts when prior round emitted them', async () => {
    const plan = buildCollaborationPlan(
      'topic',
      directive({ requestedPrimaryParticipantCount: 2, rebuttalRounds: 1 }),
      makeRegistry(),
      'task-cot-inject',
    );
    const bus = createBus();
    // Worker stub that emits a `kind:'thought'` audit:entry on the bus
    // before returning. The bus is FIFO sync so by the time await
    // resolves, the orchestrator's capture handler has seen the event.
    const fn = scriptedExecuteTask(bus, {
      thoughtsBySubTaskId: 'all-r0',
      thoughtContent: 'I argued X based on F',
      thoughtTrigger: 'pre-tool',
    });
    const input = makeInput({ id: 'task-cot-inject' });
    await runCollaborationBlock(plan, plan.collaborationBlock!, input, { executeTask: fn, bus });
    const round1Calls = fn.calls.filter((c) => c.subTaskId.endsWith('-r1'));
    expect(round1Calls.length).toBeGreaterThan(0);
    // Every round-1 dispatch should carry its own agent's prior-round
    // reasoning header + the scripted content.
    for (const c of round1Calls) {
      expect(c.goal).toContain('Your reasoning trail from round 1');
      expect(c.goal).toContain('I argued X based on F');
      expect(c.goal).toContain('heuristic');
    }
  });

  test('A5 — inject decision audit row carries evidenceRefs back to source thought entry ids', async () => {
    // Memory-as-evidence operationalization: each injected thought must
    // be structurally back-linked from the decision row so a verifier
    // (or replayer) can walk to the exact `audit:entry` events that
    // informed round N+1's generation. Without this link the dependency
    // is only present in the human-readable rationale, which is brittle.
    const plan = buildCollaborationPlan(
      'topic',
      directive({ requestedPrimaryParticipantCount: 1, rebuttalRounds: 1 }),
      makeRegistry(),
      'task-cot-evref',
    );
    const bus = createBus();
    const evidenceRefsByVerdict: Array<{ verdict: string; refs: Array<{ type: string; eventId: string }> }> = [];
    bus.on('audit:entry', (entry: unknown) => {
      const e = entry as {
        kind?: string;
        ruleId?: string;
        verdict?: string;
        evidenceRefs?: Array<{ type: string; eventId: string }>;
      };
      if (e.kind === 'decision' && e.ruleId === 'collab-cot-inject-v1') {
        evidenceRefsByVerdict.push({
          verdict: e.verdict ?? '',
          refs: e.evidenceRefs ?? [],
        });
      }
    });
    const fn = scriptedExecuteTask(bus, {
      thoughtsBySubTaskId: 'all-r0',
      thoughtContent: 'I argued X based on F',
      thoughtTrigger: 'pre-tool',
    });
    await runCollaborationBlock(plan, plan.collaborationBlock!, makeInput({ id: 'task-cot-evref' }), {
      executeTask: fn,
      bus,
    });
    // One inject decision (1 primary × 1 rebuttal round).
    const injects = evidenceRefsByVerdict.filter((d) => d.verdict.startsWith('cot-inject:'));
    expect(injects).toHaveLength(1);
    // Each injected thought generated exactly one evidenceRef of type 'event'.
    expect(injects[0]!.refs.length).toBeGreaterThanOrEqual(1);
    for (const ref of injects[0]!.refs) {
      expect(ref.type).toBe('event');
      expect(ref.eventId).toMatch(/^synth-/); // matches scriptedExecuteTask's id pattern
    }
  });

  test('A5 — skip decision audit row carries NO evidenceRefs (nothing was injected)', async () => {
    // Negative gate: a `cot-skip:*` decision means no thoughts crossed
    // the inject threshold, so there are no evidence links to emit.
    // Asserting this prevents accidental "phantom" refs that would
    // mislead a replayer into thinking inject occurred.
    const plan = buildCollaborationPlan(
      'topic',
      directive({ requestedPrimaryParticipantCount: 1, rebuttalRounds: 1 }),
      makeRegistry(),
      'task-cot-evref-skip',
    );
    const bus = createBus();
    const skipDecisions: Array<{ verdict: string; refs?: Array<{ type: string }> }> = [];
    bus.on('audit:entry', (entry: unknown) => {
      const e = entry as {
        kind?: string;
        ruleId?: string;
        verdict?: string;
        evidenceRefs?: Array<{ type: string }>;
      };
      if (e.kind === 'decision' && e.ruleId === 'collab-cot-inject-v1') {
        skipDecisions.push({
          verdict: e.verdict ?? '',
          ...(e.evidenceRefs ? { refs: e.evidenceRefs } : {}),
        });
      }
    });
    const { fn } = captureExecuteTask();
    await runCollaborationBlock(plan, plan.collaborationBlock!, makeInput({ id: 'task-cot-evref-skip' }), {
      executeTask: fn,
      bus,
    });
    expect(skipDecisions).toHaveLength(1);
    expect(skipDecisions[0]!.verdict.startsWith('cot-skip:')).toBe(true);
    expect(skipDecisions[0]!.refs).toBeUndefined();
  });

  test('A8 — every CoT inject decision emits an audit:entry with ruleId collab-cot-inject-v1', async () => {
    const plan = buildCollaborationPlan(
      'topic',
      directive({ requestedPrimaryParticipantCount: 2, rebuttalRounds: 1 }),
      makeRegistry(),
      'task-cot-audit',
    );
    const bus = createBus();
    const decisionAudits: Array<{ verdict: string; rationale: string; ruleId?: string }> = [];
    bus.on('audit:entry', (entry: unknown) => {
      const e = entry as {
        kind?: string;
        decisionType?: string;
        verdict?: string;
        rationale?: string;
        ruleId?: string;
      };
      if (e.kind === 'decision' && e.ruleId === 'collab-cot-inject-v1') {
        decisionAudits.push({
          verdict: e.verdict ?? '',
          rationale: e.rationale ?? '',
          ...(e.ruleId ? { ruleId: e.ruleId } : {}),
        });
      }
    });
    const fn = scriptedExecuteTask(bus, {
      // Two agents × round 0 each emit a thought.
      thoughtsBySubTaskId: 'all-r0',
    });
    const input = makeInput({ id: 'task-cot-audit' });
    await runCollaborationBlock(plan, plan.collaborationBlock!, input, { executeTask: fn, bus });
    // 2 primaries × 1 rebuttal round = 2 inject decisions (round 1 only).
    expect(decisionAudits).toHaveLength(2);
    for (const da of decisionAudits) {
      expect(da.verdict).toMatch(/^cot-(inject|skip):/);
      expect(da.ruleId).toBe('collab-cot-inject-v1');
    }
  });

  test('A9 — when round 0 emits no thoughts, round 1 dispatches without a CoT block (skip decision audited)', async () => {
    const plan = buildCollaborationPlan(
      'topic',
      directive({ requestedPrimaryParticipantCount: 2, rebuttalRounds: 1 }),
      makeRegistry(),
      'task-cot-empty',
    );
    const bus = createBus();
    const skipReasons: string[] = [];
    bus.on('audit:entry', (entry: unknown) => {
      const e = entry as { kind?: string; ruleId?: string; verdict?: string };
      if (e.kind === 'decision' && e.ruleId === 'collab-cot-inject-v1') {
        skipReasons.push(e.verdict ?? '');
      }
    });
    const { fn, calls } = captureExecuteTask();
    await runCollaborationBlock(plan, plan.collaborationBlock!, makeInput(), { executeTask: fn, bus });
    const round1 = calls.filter((c) => c.subTaskId.endsWith('-r1'));
    for (const c of round1) {
      expect(c.goal).not.toContain('Your reasoning trail from round');
    }
    // Skip decisions emitted with reason 'no-thoughts' (worker stub emitted nothing).
    expect(skipReasons.every((v) => v.startsWith('cot-skip:'))).toBe(true);
    expect(skipReasons.some((v) => v === 'cot-skip:no-thoughts')).toBe(true);
  });

  test('A4 — round 0 mutation tool call gates the round 1 inject', async () => {
    const plan = buildCollaborationPlan(
      'topic',
      directive({ requestedPrimaryParticipantCount: 1, rebuttalRounds: 1 }),
      makeRegistry(),
      'task-cot-mutation',
    );
    const bus = createBus();
    const skipReasons: string[] = [];
    bus.on('audit:entry', (entry: unknown) => {
      const e = entry as { kind?: string; ruleId?: string; verdict?: string };
      if (e.kind === 'decision' && e.ruleId === 'collab-cot-inject-v1') {
        skipReasons.push(e.verdict ?? '');
      }
    });
    const fn = scriptedExecuteTask(bus, {
      // Round 0 emits both a thought AND a mutation tool call. The
      // mutation gate must drop the inject for that step.
      thoughtsBySubTaskId: 'all-r0',
      toolCallsBySubTaskId: 'all-r0-mutation',
    });
    await runCollaborationBlock(plan, plan.collaborationBlock!, makeInput({ id: 'task-cot-mutation' }), {
      executeTask: fn,
      bus,
    });
    const round1 = fn.calls.filter((c) => c.subTaskId.endsWith('-r1'));
    for (const c of round1) {
      expect(c.goal).not.toContain('Your reasoning trail from round');
    }
    expect(skipReasons.some((v) => v === 'cot-skip:mutation-detected')).toBe(true);
  });

  test('A2 — reflect-trigger thought becomes the "must address" section in round 1 goal', async () => {
    const plan = buildCollaborationPlan(
      'topic',
      directive({ requestedPrimaryParticipantCount: 1, rebuttalRounds: 1 }),
      makeRegistry(),
      'task-cot-reflect',
    );
    const bus = createBus();
    const fn = scriptedExecuteTask(bus, {
      thoughtsBySubTaskId: 'all-r0',
      thoughtTrigger: 'reflect',
      thoughtContent: 'I am uncertain whether to use approach A or B',
    });
    await runCollaborationBlock(plan, plan.collaborationBlock!, makeInput({ id: 'task-cot-reflect' }), {
      executeTask: fn,
      bus,
    });
    const round1 = fn.calls.filter((c) => c.subTaskId.endsWith('-r1'));
    expect(round1.length).toBeGreaterThan(0);
    const c = round1[0]!;
    expect(c.goal).toContain('Reflective uncertainty (must address explicitly');
    expect(c.goal).toContain('I am uncertain whether to use approach A or B');
  });

  test('A3 — same scripted execution produces byte-identical round-1 goal across two runs', async () => {
    const buildPlan = () =>
      buildCollaborationPlan(
        'topic',
        directive({ requestedPrimaryParticipantCount: 1, rebuttalRounds: 1 }),
        makeRegistry(),
        'task-cot-determ',
      );
    const fixedClock = (() => {
      let t = 1_000_000;
      return () => (t += 1);
    });
    const buildOnce = async () => {
      const bus = createBus();
      const fn = scriptedExecuteTask(bus, {
        thoughtsBySubTaskId: 'all-r0',
        thoughtTsAbs: 1_000_500,
      });
      const plan = buildPlan();
      await runCollaborationBlock(plan, plan.collaborationBlock!, makeInput({ id: 'task-cot-determ' }), {
        executeTask: fn,
        bus,
        clock: fixedClock(),
      });
      const round1 = fn.calls.filter((c) => c.subTaskId.endsWith('-r1'))[0]!;
      return round1.goal;
    };
    const goalA = await buildOnce();
    const goalB = await buildOnce();
    expect(goalA).toBe(goalB);
  });

  test('A4/A6 — staleness threshold honored via getCotStalenessMs dep', async () => {
    const plan = buildCollaborationPlan(
      'topic',
      directive({ requestedPrimaryParticipantCount: 1, rebuttalRounds: 1 }),
      makeRegistry(),
      'task-cot-stale',
    );
    const bus = createBus();
    const skipReasons: string[] = [];
    bus.on('audit:entry', (entry: unknown) => {
      const e = entry as { kind?: string; ruleId?: string; verdict?: string };
      if (e.kind === 'decision' && e.ruleId === 'collab-cot-inject-v1') {
        skipReasons.push(e.verdict ?? '');
      }
    });
    const fn = scriptedExecuteTask(bus, {
      thoughtsBySubTaskId: 'all-r0',
      // Emit thought with ts FAR in the past (worker stub uses Date.now()
      // by default; pin an absolute ts before the staleness window).
      thoughtTsAbs: 1,
    });
    await runCollaborationBlock(plan, plan.collaborationBlock!, makeInput({ id: 'task-cot-stale' }), {
      executeTask: fn,
      bus,
      // Staleness threshold of 100ms; thought at ts=1 is way past stale.
      getCotStalenessMs: () => 100,
    });
    const round1 = fn.calls.filter((c) => c.subTaskId.endsWith('-r1'));
    for (const c of round1) {
      expect(c.goal).not.toContain('Your reasoning trail from round');
    }
    expect(skipReasons.some((v) => v === 'cot-skip:all-stale')).toBe(true);
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
