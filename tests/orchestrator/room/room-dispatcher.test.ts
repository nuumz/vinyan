/**
 * RoomDispatcher — sequential orchestration tests.
 *
 * Mocks `runAgentLoop` and `resolveParticipant` to drive the dispatcher
 * through happy path, admission failure, awaiting-user, budget exhaustion,
 * and blackboard scope violation. Asserts the aggregated RoomDispatchOutcome
 * and the bus event sequence — without spawning any real subprocess.
 */
import { describe, expect, it } from 'bun:test';
import type { AgentContract } from '../../../src/core/agent-contract.ts';
import { createBus } from '../../../src/core/bus.ts';
import { RoomDispatcher, type RoomExecuteInput } from '../../../src/orchestrator/room/room-dispatcher.ts';
import { selectRoomContract } from '../../../src/orchestrator/room/room-selector.ts';
import type { GoalVerifier } from '../../../src/orchestrator/room/room-supervisor.ts';
import { RoomAdmissionFailure } from '../../../src/orchestrator/room/types.ts';
import type {
  PerceptualHierarchy,
  RoutingDecision,
  SemanticTaskUnderstanding,
  TaskDAG,
  TaskInput,
  WorkingMemoryState,
} from '../../../src/orchestrator/types.ts';
import type { AgentLoopDeps, WorkerLoopResult } from '../../../src/orchestrator/worker/agent-loop.ts';

// ── Fixtures ───────────────────────────────────────────────────────

function makeInput(): TaskInput {
  return {
    id: 'task-42',
    source: 'cli',
    goal: 'Refactor the payment retry logic',
    taskType: 'code',
    targetFiles: ['src/payment/retry.ts'],
    budget: { maxTokens: 20_000, maxDurationMs: 60_000, maxRetries: 3 },
  };
}

function makeRouting(): RoutingDecision {
  return {
    level: 3,
    model: 'claude-opus',
    budgetTokens: 20_000,
    latencyBudgetMs: 60_000,
    riskScore: 0.85,
  };
}

function makeFanInDag(): TaskDAG {
  return {
    nodes: [
      {
        id: 'a',
        description: 'draft A',
        targetFiles: ['src/payment/retry.ts'],
        dependencies: [],
        assignedOracles: ['type'],
        riskScore: 0.9,
      },
      {
        id: 'b',
        description: 'draft B',
        targetFiles: ['src/payment/retry.ts'],
        dependencies: [],
        assignedOracles: ['type'],
        riskScore: 0.9,
      },
      {
        id: 'c',
        description: 'integrate',
        targetFiles: ['src/payment/retry.ts'],
        dependencies: ['a', 'b'],
        assignedOracles: ['type', 'test'],
        riskScore: 0.9,
      },
    ],
  };
}

function makePerception(): PerceptualHierarchy {
  return {
    taskTarget: { file: 'src/payment/retry.ts', description: 'payment retry' },
    dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
    diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
    verifiedFacts: [],
    runtime: { nodeVersion: 'v18', os: 'darwin', availableTools: [] },
  };
}

function makeMemory(): WorkingMemoryState {
  return { failedApproaches: [], activeHypotheses: [], unresolvedUncertainties: [], scopedFacts: [] };
}

function makeContract(taskId: string): AgentContract {
  return {
    taskId,
    routingLevel: 3,
    tokenBudget: 20_000,
    timeLimitMs: 60_000,
    maxToolCalls: 50,
    maxToolCallsPerTurn: 10,
    maxTurns: 50,
    maxEscalations: 3,
    capabilities: [
      { type: 'file_read', paths: ['**'] },
      { type: 'file_write', paths: ['src/**'] },
    ],
    onViolation: 'warn_then_kill',
    violationTolerance: 2,
    issuedAt: 1000,
    immutable: true,
  };
}

function makeUnderstanding(): SemanticTaskUnderstanding {
  return {
    rawGoal: 'Refactor payment retry',
    actionVerb: 'refactor',
    actionCategory: 'mutation',
    frameworkContext: [],
    constraints: [],
    acceptanceCriteria: [],
    expectsMutation: true,
    taskDomain: 'code-mutation',
    taskIntent: 'execute',
    toolRequirement: 'tool-needed',
    resolvedEntities: [],
    understandingDepth: 1,
    verifiedClaims: [],
    understandingFingerprint: 'fp-test',
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

function makeExecuteInput(): RoomExecuteInput {
  const input = makeInput();
  const routing = makeRouting();
  const dag = makeFanInDag();
  const contract = selectRoomContract(dag, routing, input);
  if (!contract) throw new Error('room contract expected');
  return {
    parentInput: input,
    perception: makePerception(),
    memory: makeMemory(),
    plan: dag,
    routing,
    parentContract: makeContract(input.id),
    agentLoopDeps: makeAgentLoopDeps(),
    understanding: makeUnderstanding(),
    contract,
  };
}

function verifyPass(confidence = 0.82): GoalVerifier {
  return () => ({ verified: true, type: 'known', confidence, evidence: [], fileHashes: {}, durationMs: 1 });
}

function verifyFail(): GoalVerifier {
  return () => ({ verified: false, type: 'uncertain', confidence: 0.4, evidence: [], fileHashes: {}, durationMs: 1 });
}

function resolverByRoleIndex() {
  // Produces a distinct model id per role so A1 never fires spuriously.
  let counter = 0;
  return async (ctx: { role: { name: string } }) => ({
    workerId: `${ctx.role.name}-worker`,
    workerModelId: `model-${ctx.role.name}-${counter++}`,
  });
}

function resolverCollideOnCritic() {
  // Returns the same model id for the critic as drafter-0 → A1 violation.
  return async (ctx: { role: { name: string }; usedModelIds: ReadonlySet<string> }) => {
    if (ctx.role.name === 'critic') {
      return { workerId: 'w-dup', workerModelId: Array.from(ctx.usedModelIds)[0] ?? 'model-shared' };
    }
    return { workerId: `${ctx.role.name}-w`, workerModelId: `model-${ctx.role.name}` };
  };
}

function resolverNullForCritic() {
  return async (ctx: { role: { name: string } }) => {
    if (ctx.role.name === 'critic') return null;
    return { workerId: `${ctx.role.name}-w`, workerModelId: `model-${ctx.role.name}` };
  };
}

function makeLoopResult(overrides: Partial<WorkerLoopResult> = {}): WorkerLoopResult {
  return {
    mutations: [],
    uncertainties: [],
    tokensConsumed: 500,
    durationMs: 10,
    transcript: [],
    isUncertain: false,
    proposedToolCalls: [],
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('RoomDispatcher — happy path', () => {
  it('runs 4 roles, converges on round 1, returns merged mutations with integrator winning conflicts', async () => {
    const bus = createBus();
    const busEvents: Array<{ topic: string; payload: unknown }> = [];
    for (const topic of [
      'room:opened',
      'room:participant_admitted',
      'room:message_committed',
      'room:converged',
      'room:failed',
    ] as const) {
      bus.on(topic, (payload) => busEvents.push({ topic, payload }));
    }

    let turn = 0;
    const runAgentLoop = async () => {
      const which = turn++;
      // turn 0 = drafter-0: proposes mutations to a.ts and b.ts
      // turn 1 = drafter-1: proposes mutation to c.ts
      // turn 2 = critic: no concerns
      // turn 3 = integrator: overrides b.ts
      if (which === 0) {
        return makeLoopResult({
          mutations: [
            { file: 'src/a.ts', content: 'A-v1', diff: '', explanation: 'drafter-0 a' },
            { file: 'src/b.ts', content: 'B-v1', diff: '', explanation: 'drafter-0 b' },
          ],
          tokensConsumed: 300,
        });
      }
      if (which === 1) {
        return makeLoopResult({
          mutations: [{ file: 'src/c.ts', content: 'C-v1', diff: '', explanation: 'drafter-1 c' }],
          tokensConsumed: 300,
        });
      }
      if (which === 2) {
        return makeLoopResult({ uncertainties: [], tokensConsumed: 200 });
      }
      return makeLoopResult({
        mutations: [{ file: 'src/b.ts', content: 'B-v2-final', diff: '', explanation: 'integrator' }],
        tokensConsumed: 400,
      });
    };

    const dispatcher = new RoomDispatcher({
      runAgentLoop,
      resolveParticipant: resolverByRoleIndex(),
      workspace: '/ws',
      bus,
      goalVerifier: verifyPass(0.82),
      clock: (() => {
        let t = 10_000;
        return () => (t += 10);
      })(),
    });

    const outcome = await dispatcher.execute(makeExecuteInput());

    expect(outcome.result.status).toBe('converged');
    expect(outcome.result.rounds).toBe(1);
    // Integrator's src/b.ts overrode drafter-0's src/b.ts
    const mutationsByFile = new Map(outcome.mutations.map((m) => [m.file, m.content]));
    expect(mutationsByFile.get('src/a.ts')).toBe('A-v1');
    expect(mutationsByFile.get('src/b.ts')).toBe('B-v2-final');
    expect(mutationsByFile.get('src/c.ts')).toBe('C-v1');
    expect(outcome.tokensConsumed).toBe(1200);

    // Bus events observed
    const topics = busEvents.map((e) => e.topic);
    expect(topics).toContain('room:opened');
    expect(topics.filter((t) => t === 'room:participant_admitted')).toHaveLength(4);
    expect(topics.filter((t) => t === 'room:message_committed')).toHaveLength(4);
    expect(topics).toContain('room:converged');
    expect(topics).not.toContain('room:failed');
  });

  it('synthetic overlay ids never appear in the aggregated outcome', async () => {
    let turn = 0;
    const capturedSyntheticIds: string[] = [];
    const runAgentLoop = async (input: TaskInput) => {
      capturedSyntheticIds.push(input.id);
      const which = turn++;
      if (which === 3) {
        return makeLoopResult({
          mutations: [{ file: 'src/a.ts', content: 'v1', diff: '', explanation: 'integ' }],
          tokensConsumed: 500,
        });
      }
      return makeLoopResult({ tokensConsumed: 100 });
    };

    const dispatcher = new RoomDispatcher({
      runAgentLoop,
      resolveParticipant: resolverByRoleIndex(),
      workspace: '/ws',
      goalVerifier: verifyPass(),
    });

    const outcome = await dispatcher.execute(makeExecuteInput());

    expect(capturedSyntheticIds.every((id) => id.includes('__room__'))).toBe(true);
    expect(capturedSyntheticIds.every((id) => /^[a-zA-Z0-9_-]+$/.test(id))).toBe(true);
    // The result's roomId references parent task id, not any synthetic
    expect(outcome.result.roomId).toBe('room-task-42');
    // Ledger entries use participant ids scoped to roomId + roleName, not synthetic overlay ids
    for (const entry of outcome.result.ledger) {
      expect(entry.author.startsWith('room-task-42::')).toBe(true);
      expect(entry.author).not.toContain('__room__');
    }
  });
});

describe('RoomDispatcher — failure modes', () => {
  it('admission failure (null resolver for a required role) throws RoomAdmissionFailure', async () => {
    const dispatcher = new RoomDispatcher({
      runAgentLoop: async () => makeLoopResult(),
      resolveParticipant: resolverNullForCritic(),
      workspace: '/ws',
      goalVerifier: verifyPass(),
    });

    let error: unknown;
    try {
      await dispatcher.execute(makeExecuteInput());
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RoomAdmissionFailure);
  });

  it('A1 collision (resolver reuses a model id) throws RoomAdmissionFailure', async () => {
    const dispatcher = new RoomDispatcher({
      runAgentLoop: async () => makeLoopResult(),
      resolveParticipant: resolverCollideOnCritic(),
      workspace: '/ws',
      goalVerifier: verifyPass(),
    });
    let error: unknown;
    try {
      await dispatcher.execute(makeExecuteInput());
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RoomAdmissionFailure);
    expect((error as RoomAdmissionFailure).reason).toBe('no-distinct-model');
  });

  it('needsUserInput from a participant bubbles up as awaiting-user', async () => {
    let turn = 0;
    const runAgentLoop = async () => {
      const which = turn++;
      if (which === 1) {
        // drafter-1 pauses with a user question
        return makeLoopResult({
          uncertainties: ['Which helper should I update?'],
          tokensConsumed: 200,
        }) as WorkerLoopResult & { needsUserInput: boolean };
      }
      return makeLoopResult({ tokensConsumed: 100 });
    };
    // Patch the returned object so needsUserInput flag is set.
    const runAgentLoopWithPause: typeof runAgentLoop = async (...args) => {
      const r = (await runAgentLoop(...args)) as WorkerLoopResult;
      if (turn - 1 === 1) (r as WorkerLoopResult).needsUserInput = true;
      return r;
    };

    const dispatcher = new RoomDispatcher({
      runAgentLoop: runAgentLoopWithPause as never,
      resolveParticipant: resolverByRoleIndex(),
      workspace: '/ws',
      goalVerifier: verifyPass(),
    });

    const outcome = await dispatcher.execute(makeExecuteInput());
    expect(outcome.needsUserInput).toBe(true);
    expect(outcome.result.status).toBe('awaiting-user');
    expect(outcome.pendingQuestions).toContain('Which helper should I update?');
  });

  it('budget exhausted mid-round closes room as partial', async () => {
    const runAgentLoop = async () =>
      makeLoopResult({
        mutations: [{ file: 'src/a.ts', content: 'x', diff: '', explanation: '' }],
        tokensConsumed: 50_000, // blows the contract budget instantly
      });

    const dispatcher = new RoomDispatcher({
      runAgentLoop,
      resolveParticipant: resolverByRoleIndex(),
      workspace: '/ws',
      goalVerifier: verifyPass(),
    });

    const outcome = await dispatcher.execute(makeExecuteInput());
    expect(outcome.result.status).toBe('partial');
    expect(outcome.uncertainties.some((u) => u.includes('budget exhausted'))).toBe(true);
  });

  it('verifier rejecting every round closes as partial after maxRounds', async () => {
    let turn = 0;
    const runAgentLoop = async () => {
      const which = turn++;
      if (which % 4 === 3) {
        return makeLoopResult({
          mutations: [{ file: 'src/a.ts', content: `v${which}`, diff: '', explanation: 'int' }],
          tokensConsumed: 200,
        });
      }
      return makeLoopResult({ tokensConsumed: 100 });
    };

    const dispatcher = new RoomDispatcher({
      runAgentLoop,
      resolveParticipant: resolverByRoleIndex(),
      workspace: '/ws',
      goalVerifier: verifyFail(),
    });

    const outcome = await dispatcher.execute(makeExecuteInput());
    expect(outcome.result.status).toBe('partial');
    expect(outcome.result.rounds).toBeGreaterThanOrEqual(2);
  });
});
