/**
 * Room Selector — Option C trigger tests.
 *
 * Pure function tests. Verifies all 5 trigger rules at their boundaries and
 * confirms the emitted RoomContract's role mapping (drafters → critic → integrator).
 */
import { describe, expect, it } from 'bun:test';
import { ROOM_SELECTOR_CONSTANTS, selectRoomContract } from '../../../src/orchestrator/room/room-selector.ts';
import type { RoutingDecision, TaskDAG, TaskInput } from '../../../src/orchestrator/types.ts';

function makeInput(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 'task-42',
    source: 'cli',
    goal: 'Refactor the payment retry logic',
    taskType: 'code',
    targetFiles: ['src/payment/retry.ts'],
    budget: { maxTokens: 20_000, maxDurationMs: 60_000, maxRetries: 3 },
    ...overrides,
  };
}

function makeRouting(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    level: 3,
    model: 'claude-opus',
    budgetTokens: 20_000,
    latencyBudgetMs: 60_000,
    riskScore: 0.85,
    ...overrides,
  };
}

function makeFanInDag(highRisk = true): TaskDAG {
  return {
    nodes: [
      {
        id: 'src-a',
        description: 'Draft implementation A',
        targetFiles: ['src/payment/retry.ts'],
        dependencies: [],
        assignedOracles: ['type'],
        riskScore: highRisk ? 0.85 : 0.3,
      },
      {
        id: 'src-b',
        description: 'Draft implementation B',
        targetFiles: ['src/payment/retry.ts'],
        dependencies: [],
        assignedOracles: ['type'],
        riskScore: highRisk ? 0.85 : 0.3,
      },
      {
        id: 'integrate',
        description: 'Integrate drafts',
        targetFiles: ['src/payment/retry.ts'],
        dependencies: ['src-a', 'src-b'],
        assignedOracles: ['type', 'test'],
        riskScore: highRisk ? 0.9 : 0.4,
      },
    ],
  };
}

describe('selectRoomContract — trigger rules', () => {
  it('fires on a valid 3-node fan-out → fan-in DAG at L3 with risk ≥0.7', () => {
    const contract = selectRoomContract(makeFanInDag(), makeRouting(), makeInput());
    expect(contract).not.toBeNull();
    expect(contract!.roomId).toBe('room-task-42');
    expect(contract!.parentTaskId).toBe('task-42');
    expect(contract!.minRounds).toBe(ROOM_SELECTOR_CONSTANTS.DEFAULT_MIN_ROUNDS);
    expect(contract!.maxRounds).toBe(ROOM_SELECTOR_CONSTANTS.DEFAULT_MAX_ROUNDS);
    expect(contract!.convergenceThreshold).toBe(ROOM_SELECTOR_CONSTANTS.DEFAULT_CONVERGENCE_THRESHOLD);
  });

  it('rejects when routing level is below 2', () => {
    expect(selectRoomContract(makeFanInDag(), makeRouting({ level: 1 }), makeInput())).toBeNull();
    expect(selectRoomContract(makeFanInDag(), makeRouting({ level: 0 }), makeInput())).toBeNull();
  });

  it('rejects a 2-node DAG (below MIN_NODES floor)', () => {
    const dag: TaskDAG = {
      nodes: [
        { id: 'a', description: 'x', targetFiles: [], dependencies: [], assignedOracles: [], riskScore: 0.9 },
        { id: 'b', description: 'y', targetFiles: [], dependencies: ['a'], assignedOracles: [], riskScore: 0.9 },
      ],
    };
    expect(selectRoomContract(dag, makeRouting(), makeInput())).toBeNull();
  });

  it('rejects a fallback DAG', () => {
    const dag: TaskDAG = { ...makeFanInDag(), isFallback: true };
    expect(selectRoomContract(dag, makeRouting(), makeInput())).toBeNull();
  });

  it('rejects a composed-skill DAG', () => {
    const dag: TaskDAG = { ...makeFanInDag(), isFromComposedSkill: true };
    expect(selectRoomContract(dag, makeRouting(), makeInput())).toBeNull();
  });

  it('rejects a linear DAG (no fan-out)', () => {
    const dag: TaskDAG = {
      nodes: [
        { id: 'a', description: 'x', targetFiles: [], dependencies: [], assignedOracles: [], riskScore: 0.9 },
        { id: 'b', description: 'y', targetFiles: [], dependencies: ['a'], assignedOracles: [], riskScore: 0.9 },
        { id: 'c', description: 'z', targetFiles: [], dependencies: ['b'], assignedOracles: [], riskScore: 0.9 },
      ],
    };
    expect(selectRoomContract(dag, makeRouting(), makeInput())).toBeNull();
  });

  it('rejects a DAG with multiple terminals (no unique fan-in sink)', () => {
    const dag: TaskDAG = {
      nodes: [
        { id: 'a', description: 'x', targetFiles: [], dependencies: [], assignedOracles: [], riskScore: 0.9 },
        { id: 'b', description: 'y', targetFiles: [], dependencies: [], assignedOracles: [], riskScore: 0.9 },
        { id: 'c', description: 'z', targetFiles: [], dependencies: ['a'], assignedOracles: [], riskScore: 0.9 },
        { id: 'd', description: 'w', targetFiles: [], dependencies: ['b'], assignedOracles: [], riskScore: 0.9 },
      ],
    };
    expect(selectRoomContract(dag, makeRouting(), makeInput())).toBeNull();
  });

  it('rejects when aggregate risk is below the 0.7 floor', () => {
    expect(selectRoomContract(makeFanInDag(false), makeRouting(), makeInput())).toBeNull();
  });

  it('role mapping: 2 drafters + critic + integrator = 4 roles', () => {
    const contract = selectRoomContract(makeFanInDag(), makeRouting(), makeInput());
    expect(contract).not.toBeNull();
    expect(contract!.roles).toHaveLength(4);
    expect(contract!.roles[0]!.name).toBe('drafter-0');
    expect(contract!.roles[1]!.name).toBe('drafter-1');
    expect(contract!.roles[2]!.name).toBe('critic');
    expect(contract!.roles[3]!.name).toBe('integrator');
  });

  it('critic role has canWriteFiles=false (A6 file_write removal)', () => {
    const contract = selectRoomContract(makeFanInDag(), makeRouting(), makeInput())!;
    const critic = contract.roles.find((r) => r.name === 'critic')!;
    expect(critic.canWriteFiles).toBe(false);
    const drafter = contract.roles.find((r) => r.name === 'drafter-0')!;
    expect(drafter.canWriteFiles).toBe(true);
  });

  it('drafter writable keys are role-indexed', () => {
    const contract = selectRoomContract(makeFanInDag(), makeRouting(), makeInput())!;
    const drafter0 = contract.roles.find((r) => r.name === 'drafter-0')!;
    const drafter1 = contract.roles.find((r) => r.name === 'drafter-1')!;
    expect(drafter0.writableBlackboardKeys).toEqual(['draft/0/*']);
    expect(drafter1.writableBlackboardKeys).toEqual(['draft/1/*']);
  });

  it('token budget is multiplied by ROOM_BUDGET_MULTIPLIER', () => {
    const contract = selectRoomContract(makeFanInDag(), makeRouting({ budgetTokens: 5_000 }), makeInput())!;
    expect(contract.tokenBudget).toBe(5_000 * ROOM_SELECTOR_CONSTANTS.ROOM_BUDGET_MULTIPLIER);
  });
});

// ---------------------------------------------------------------------------
// Rule 6 — creative-writing bypass (Phase E)
// ---------------------------------------------------------------------------

describe('selectRoomContract — creative-writing bypass', () => {
  it('returns the creative-writing preset when the goal matches and routing permits', () => {
    const contract = selectRoomContract(
      makeFanInDag(),
      makeRouting(),
      makeInput({ goal: 'อยากเขียนนิยายเว็บตูนแนวโรแมนซ์' }),
    )!;
    expect(contract).not.toBeNull();
    const names = contract.roles.map((r) => r.name);
    expect(names).toEqual(['writer', 'editor', 'trend-analyst']);
    expect(contract.convergenceThreshold).toBeCloseTo(0.75, 2);
    expect(contract.maxRounds).toBe(3);
  });

  it('still respects the routing level floor even for creative goals', () => {
    expect(
      selectRoomContract(
        makeFanInDag(),
        makeRouting({ level: 1 }),
        makeInput({ goal: 'write a webtoon novel' }),
      ),
    ).toBeNull();
  });

  it('token budget scales with ROOM_BUDGET_MULTIPLIER in the creative path', () => {
    const contract = selectRoomContract(
      makeFanInDag(),
      makeRouting({ budgetTokens: 10_000 }),
      makeInput({ goal: 'write a webtoon novel' }),
    )!;
    expect(contract.tokenBudget).toBe(10_000 * ROOM_SELECTOR_CONSTANTS.ROOM_BUDGET_MULTIPLIER);
  });

  it('does NOT take the creative bypass for code goals that happen to mention "novel"', () => {
    // "novel approach" is a common phrase — must not trigger creative preset.
    const contract = selectRoomContract(
      makeFanInDag(),
      makeRouting(),
      makeInput({ goal: 'Refactor the payment retry logic' }),
    )!;
    expect(contract.roles.map((r) => r.name)).not.toContain('writer');
  });
});
