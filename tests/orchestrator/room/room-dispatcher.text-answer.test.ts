/**
 * RoomDispatcher — text-answer mode tests (Phase 2 multi-agent debate fix).
 *
 * Pins the new behaviours:
 *   - per-round role gating: primaries act on rounds [0, rebuttalRounds],
 *     integrator acts ONLY on the final round
 *   - composeRoleGoal: primary-participant gets parentGoal verbatim
 *     (no `[Room role: …]` framing)
 *   - buildRoomContext: round 0 emits no ROOM_CONTEXT; round > 0 surfaces
 *     peers' prior `discussion/<peerName>/round-<n>` blackboard entries
 *     and EXCLUDES the current participant's own prior turns
 *   - participant identity is stable across rounds — `state.participants.size`
 *     equals `roles.length`, NOT `roles.length × maxRounds`
 *
 * Mock surface mirrors the legacy room-dispatcher.test.ts.
 */
import { describe, expect, it } from 'bun:test';
import type { AgentContract } from '../../../src/core/agent-contract.ts';
import { RoomDispatcher, type RoomExecuteInput } from '../../../src/orchestrator/room/room-dispatcher.ts';
import type { GoalVerifier } from '../../../src/orchestrator/room/room-supervisor.ts';
import type { RoleSpec, RoomContract } from '../../../src/orchestrator/room/types.ts';
import type {
  PerceptualHierarchy,
  RoutingDecision,
  TaskInput,
  WorkingMemoryState,
} from '../../../src/orchestrator/types.ts';
import type { AgentLoopDeps, WorkerLoopResult } from '../../../src/orchestrator/agent/agent-loop.ts';

const primary1: RoleSpec = {
  name: 'primary-1',
  responsibility: 'answer',
  writableBlackboardKeys: ['discussion/primary-1/*'],
  maxTurns: 5,
  canWriteFiles: false,
  roleClass: 'primary-participant',
};
const primary2: RoleSpec = { ...primary1, name: 'primary-2', writableBlackboardKeys: ['discussion/primary-2/*'] };
const primary3: RoleSpec = { ...primary1, name: 'primary-3', writableBlackboardKeys: ['discussion/primary-3/*'] };
const integrator: RoleSpec = {
  name: 'integrator',
  responsibility: 'synthesize the final answer',
  writableBlackboardKeys: ['final/*'],
  maxTurns: 1,
  canWriteFiles: false,
  roleClass: 'integrator',
};

function makeInput(): TaskInput {
  return {
    id: 'debate-task',
    source: 'cli',
    goal: 'Should we use microservices? Discuss trade-offs.',
    taskType: 'reasoning',
    budget: { maxTokens: 50_000, maxDurationMs: 60_000, maxRetries: 1 },
  };
}

function makeRouting(): RoutingDecision {
  return { level: 2, model: 'claude-opus', budgetTokens: 50_000, latencyBudgetMs: 60_000, riskScore: 0.5 };
}

function makePerception(): PerceptualHierarchy {
  return {
    taskTarget: { file: '', description: 'no target' },
    dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
    diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
    verifiedFacts: [],
    runtime: { nodeVersion: 'v18', os: 'darwin', availableTools: [] },
  };
}

function makeMemory(): WorkingMemoryState {
  return { failedApproaches: [], activeHypotheses: [], unresolvedUncertainties: [], scopedFacts: [] };
}

function makeAgentContract(taskId: string): AgentContract {
  return {
    taskId,
    routingLevel: 2,
    tokenBudget: 50_000,
    timeLimitMs: 60_000,
    maxToolCalls: 50,
    maxToolCallsPerTurn: 10,
    maxTurns: 50,
    maxEscalations: 3,
    capabilities: [{ type: 'file_read', paths: ['**'] }],
    onViolation: 'warn_then_kill',
    violationTolerance: 2,
    issuedAt: 1000,
    immutable: true,
  };
}

function makeAgentLoopDeps(): AgentLoopDeps {
  return {
    workspace: '/ws',
    contextWindow: 128_000,
    agentWorkerEntryPath: '/dev/null',
    toolExecutor: { execute: async () => ({ callId: '', tool: '', status: 'success', output: '', durationMs: 0 }) },
    compressPerception: (p) => p,
  };
}

function textAnswerContract(overrides: Partial<RoomContract> = {}): RoomContract {
  return {
    roomId: 'room-debate',
    parentTaskId: 'debate-task',
    goal: 'Should we use microservices? Discuss trade-offs.',
    roles: [primary1, primary2, primary3, integrator],
    maxRounds: 4,
    minRounds: 0,
    convergenceThreshold: 0.5,
    tokenBudget: 100_000,
    outputMode: 'text-answer',
    rebuttalRounds: 2,
    ...overrides,
  };
}

function makeExecuteInput(contract: RoomContract): RoomExecuteInput {
  const input = makeInput();
  return {
    parentInput: input,
    perception: makePerception(),
    memory: makeMemory(),
    plan: undefined,
    routing: makeRouting(),
    parentContract: makeAgentContract(input.id),
    agentLoopDeps: makeAgentLoopDeps(),
    contract,
  };
}

function distinctModelResolver() {
  let counter = 0;
  return async (ctx: { role: { name: string } }) => ({
    workerId: `${ctx.role.name}-worker`,
    workerModelId: `model-${ctx.role.name}-${counter++}`,
  });
}

function nullVerifier(): GoalVerifier {
  // text-answer mode never invokes the goal verifier; if it does, throw.
  return () => {
    throw new Error('text-answer mode must not invoke goalVerifier');
  };
}

interface CapturedTurn {
  syntheticId: string;
  goal: string;
  roomContext: string | null;
  modelId: string;
}

function captureRunAgentLoop(): {
  runAgentLoop: (
    input: TaskInput,
    perception: PerceptualHierarchy,
    memory: WorkingMemoryState,
    plan: unknown,
    routing: RoutingDecision,
    deps: AgentLoopDeps,
  ) => Promise<WorkerLoopResult>;
  turns: CapturedTurn[];
} {
  const turns: CapturedTurn[] = [];
  const runAgentLoop = async (
    input: TaskInput,
    _perception: PerceptualHierarchy,
    _memory: WorkingMemoryState,
    _plan: unknown,
    routing: RoutingDecision,
  ): Promise<WorkerLoopResult> => {
    const constraints = input.constraints ?? [];
    const roomContextConstraint = constraints.find((c) => c.startsWith('ROOM_CONTEXT:'));
    turns.push({
      syntheticId: input.id,
      goal: input.goal,
      roomContext: roomContextConstraint ? roomContextConstraint.slice('ROOM_CONTEXT:'.length) : null,
      modelId: routing.model ?? '',
    });
    // Each turn emits a unique proposedContent so we can later assert that
    // peers see distinct prior-round content.
    const tag = `${input.id}-content`;
    return {
      mutations: [],
      uncertainties: [],
      tokensConsumed: 100,
      durationMs: 1,
      transcript: [],
      isUncertain: false,
      proposedToolCalls: [],
      proposedContent: tag,
    } as WorkerLoopResult;
  };
  return { runAgentLoop, turns };
}

describe('RoomDispatcher — text-answer per-round role gating', () => {
  it('runs primaries on rounds 0..rebuttalRounds and integrator only on the final round', async () => {
    const { runAgentLoop, turns } = captureRunAgentLoop();
    const dispatcher = new RoomDispatcher({
      runAgentLoop,
      resolveParticipant: distinctModelResolver(),
      workspace: '/ws',
      goalVerifier: nullVerifier(),
    });

    // 3 primaries × (1 + 2 rebuttal) + 1 integrator at the final round.
    // maxRounds=4: rounds 0,1,2 are primary rounds; round 3 is the
    // integrator round.
    const outcome = await dispatcher.execute(makeExecuteInput(textAnswerContract()));

    expect(outcome.result.status).toBe('converged');

    // Assert who acted on which round by counting per-role appearances.
    const primaryAppearances = turns.filter((t) => t.syntheticId.includes('__primary-')).length;
    const integratorAppearances = turns.filter((t) => t.syntheticId.includes('__integrator__')).length;
    // 3 primaries × 3 rounds (initial + 2 rebuttal) = 9 primary turns.
    expect(primaryAppearances).toBe(9);
    // Integrator runs ONCE on the final round.
    expect(integratorAppearances).toBe(1);

    // Synthetic overlay id encodes the round so we can verify gating per round.
    const integratorTurn = turns.find((t) => t.syntheticId.includes('__integrator__'));
    expect(integratorTurn!.syntheticId).toMatch(/__r3$/);

    // Primaries never appear on round 3 (integrator round only).
    const primaryRound3 = turns.filter(
      (t) => t.syntheticId.includes('__primary-') && t.syntheticId.endsWith('__r3'),
    );
    expect(primaryRound3).toHaveLength(0);
  });

  it('preserves the same participant identity across rebuttal rounds', async () => {
    const { runAgentLoop } = captureRunAgentLoop();
    const dispatcher = new RoomDispatcher({
      runAgentLoop,
      resolveParticipant: distinctModelResolver(),
      workspace: '/ws',
      goalVerifier: nullVerifier(),
    });
    const outcome = await dispatcher.execute(makeExecuteInput(textAnswerContract()));

    // Each primary participant appears with the same participant id across
    // all rounds — the dispatcher never creates a new RoomParticipant per
    // round. The aggregated result's ledger entries surface participantId
    // via the `propose` payload.
    const proposeEntries = outcome.result.ledger.filter((e) => e.type === 'propose');
    const primary1Entries = proposeEntries.filter((e) => e.authorRole === 'primary-1');
    expect(primary1Entries).toHaveLength(3); // initial + 2 rebuttal
    // Author id is the stable participantId, not a per-round synthetic.
    for (const e of primary1Entries) {
      expect(e.author).toBe('room-debate::primary-1');
    }
  });
});

describe('RoomDispatcher — text-answer composeRoleGoal', () => {
  it('does NOT prepend "[Room role: …]" framing for primary-participant turns', async () => {
    const { runAgentLoop, turns } = captureRunAgentLoop();
    const dispatcher = new RoomDispatcher({
      runAgentLoop,
      resolveParticipant: distinctModelResolver(),
      workspace: '/ws',
      goalVerifier: nullVerifier(),
    });
    await dispatcher.execute(makeExecuteInput(textAnswerContract()));

    const primaryTurns = turns.filter((t) => t.syntheticId.includes('__primary-'));
    for (const t of primaryTurns) {
      expect(t.goal).toBe('Should we use microservices? Discuss trade-offs.');
      expect(t.goal.startsWith('[Room role:')).toBe(false);
    }
  });

  it('keeps the framing for the integrator (synthesizer is told it is the integrator)', async () => {
    const { runAgentLoop, turns } = captureRunAgentLoop();
    const dispatcher = new RoomDispatcher({
      runAgentLoop,
      resolveParticipant: distinctModelResolver(),
      workspace: '/ws',
      goalVerifier: nullVerifier(),
    });
    await dispatcher.execute(makeExecuteInput(textAnswerContract()));

    const integratorTurn = turns.find((t) => t.syntheticId.includes('__integrator__'))!;
    expect(integratorTurn.goal).toMatch(/\[Room role: integrator/);
  });
});

describe('RoomDispatcher — text-answer buildRoomContext', () => {
  it('emits no ROOM_CONTEXT on round 0 (initial answers are independent)', async () => {
    const { runAgentLoop, turns } = captureRunAgentLoop();
    const dispatcher = new RoomDispatcher({
      runAgentLoop,
      resolveParticipant: distinctModelResolver(),
      workspace: '/ws',
      goalVerifier: nullVerifier(),
    });
    await dispatcher.execute(makeExecuteInput(textAnswerContract()));

    const round0Primaries = turns.filter(
      (t) => t.syntheticId.includes('__primary-') && t.syntheticId.endsWith('__r0'),
    );
    expect(round0Primaries).toHaveLength(3);
    for (const t of round0Primaries) {
      expect(t.roomContext).toBeNull();
    }
  });

  it('on rebuttal rounds, the participant sees PEERS content but NOT its own prior turn', async () => {
    const { runAgentLoop, turns } = captureRunAgentLoop();
    const dispatcher = new RoomDispatcher({
      runAgentLoop,
      resolveParticipant: distinctModelResolver(),
      workspace: '/ws',
      goalVerifier: nullVerifier(),
    });
    await dispatcher.execute(makeExecuteInput(textAnswerContract()));

    // Round 1 = first rebuttal round.
    const round1Primary1 = turns.find(
      (t) => t.syntheticId.includes('__primary-1__') && t.syntheticId.endsWith('__r1'),
    );
    expect(round1Primary1).toBeDefined();
    expect(round1Primary1!.roomContext).not.toBeNull();
    // Each turn's mock `proposedContent` is `${syntheticId}-content`. Round 0
    // primary-1's content tag includes "__primary-1__r0-content" — and that
    // string MUST NOT appear in primary-1's round-1 context (self-exclusion).
    expect(round1Primary1!.roomContext!).not.toContain('__primary-1__r0-content');
    // Peers (primary-2, primary-3) round-0 content MUST be visible.
    expect(round1Primary1!.roomContext!).toContain('__primary-2__r0-content');
    expect(round1Primary1!.roomContext!).toContain('__primary-3__r0-content');
  });

  it('integrator sees ALL primaries\' transcripts including all rounds', async () => {
    const { runAgentLoop, turns } = captureRunAgentLoop();
    const dispatcher = new RoomDispatcher({
      runAgentLoop,
      resolveParticipant: distinctModelResolver(),
      workspace: '/ws',
      goalVerifier: nullVerifier(),
    });
    await dispatcher.execute(makeExecuteInput(textAnswerContract()));

    const integratorTurn = turns.find((t) => t.syntheticId.includes('__integrator__'))!;
    expect(integratorTurn.roomContext).not.toBeNull();
    // Integrator must see every primary's full trajectory (3 rounds × 3 primaries).
    for (const peer of ['primary-1', 'primary-2', 'primary-3']) {
      for (const round of [0, 1, 2]) {
        expect(integratorTurn.roomContext!).toContain(`__${peer}__r${round}-content`);
      }
    }
  });
});

describe('RoomDispatcher — text-answer single-round (no rebuttal)', () => {
  it('with rebuttalRounds=0 the contract runs primaries once + integrator once', async () => {
    const { runAgentLoop, turns } = captureRunAgentLoop();
    const dispatcher = new RoomDispatcher({
      runAgentLoop,
      resolveParticipant: distinctModelResolver(),
      workspace: '/ws',
      goalVerifier: nullVerifier(),
    });
    const contract = textAnswerContract({ rebuttalRounds: 0, maxRounds: 2 });
    const outcome = await dispatcher.execute(makeExecuteInput(contract));

    expect(outcome.result.status).toBe('converged');
    const primaryAppearances = turns.filter((t) => t.syntheticId.includes('__primary-')).length;
    const integratorAppearances = turns.filter((t) => t.syntheticId.includes('__integrator__')).length;
    expect(primaryAppearances).toBe(3); // 3 primaries × 1 round
    expect(integratorAppearances).toBe(1);
  });
});
