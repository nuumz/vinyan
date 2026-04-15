/**
 * RoomSupervisor — FSM + convergence tests.
 *
 * The supervisor is pure, so we inject fake clock + fake goalVerifier and
 * drive transitions directly. No agent-loop, no DB, no bus.
 */
import { describe, expect, it } from 'bun:test';
import { RoomBlackboard } from '../../../src/orchestrator/room/room-blackboard.ts';
import { RoomLedger } from '../../../src/orchestrator/room/room-ledger.ts';
import {
  type GoalVerifier,
  type ParticipantResult,
  RoomSupervisor,
} from '../../../src/orchestrator/room/room-supervisor.ts';
import type { RoleSpec, RoomContract, RoomParticipant, RoomStatus } from '../../../src/orchestrator/room/types.ts';
import type { ProposedMutation } from '../../../src/orchestrator/worker/session-overlay.ts';

const drafter0: RoleSpec = {
  name: 'drafter-0',
  responsibility: 'draft',
  writableBlackboardKeys: ['draft/0/*'],
  maxTurns: 5,
  canWriteFiles: true,
};
const critic: RoleSpec = {
  name: 'critic',
  responsibility: 'review',
  writableBlackboardKeys: ['critique/*'],
  maxTurns: 5,
  canWriteFiles: false,
};
const integrator: RoleSpec = {
  name: 'integrator',
  responsibility: 'integrate',
  writableBlackboardKeys: ['final/*'],
  maxTurns: 5,
  canWriteFiles: true,
};

function makeContract(overrides: Partial<RoomContract> = {}): RoomContract {
  return {
    roomId: 'room-t1',
    parentTaskId: 't1',
    goal: 'test goal',
    roles: [drafter0, critic, integrator],
    maxRounds: 2,
    minRounds: 1,
    convergenceThreshold: 0.7,
    tokenBudget: 10_000,
    ...overrides,
  };
}

function makeParticipant(role: RoleSpec, modelId = `${role.name}-model`): RoomParticipant {
  return {
    id: `room-t1::${role.name}`,
    roomId: 'room-t1',
    roleName: role.name,
    workerId: `${role.name}-worker`,
    workerModelId: modelId,
    turnsUsed: 0,
    tokensUsed: 0,
    status: 'admitted',
    admittedAt: 1000,
  };
}

function makeResult(overrides: Partial<ParticipantResult> = {}): ParticipantResult {
  return {
    mutations: [],
    uncertainties: [],
    tokensConsumed: 100,
    needsUserInput: false,
    durationMs: 10,
    ...overrides,
  };
}

function makeMutation(file: string, content = 'new content'): ProposedMutation {
  return { file, content, diff: `+++ ${file}`, explanation: `edit ${file}` };
}

// A goal verifier that always returns `verified` with a given confidence.
function verifierReturning(verified: boolean, confidence: number): GoalVerifier {
  return () =>
    ({
      verified,
      type: verified ? 'known' : 'uncertain',
      confidence,
      evidence: [],
      fileHashes: {},
      durationMs: 1,
    }) as ReturnType<GoalVerifier>;
}

// A goal verifier that abstains (returns type: 'abstained').
function abstainingVerifier(): GoalVerifier {
  return () => ({ type: 'abstained', reason: 'no_understanding', oracleName: 'goal-alignment', durationMs: 1 });
}

describe('RoomSupervisor — open/admit', () => {
  it('open returns an opening state with the contract and empty collections', () => {
    const sup = new RoomSupervisor({ goalVerifier: verifierReturning(true, 0.9), clock: () => 500 });
    const state = sup.open(makeContract());
    expect(state.status).toBe('opening');
    expect(state.rounds).toBe(0);
    expect(state.currentRoleIndex).toBe(0);
    expect(state.participants.size).toBe(0);
    expect(state.stagedMutations.size).toBe(0);
    expect(state.openedAt).toBe(500);
  });

  it('admit transitions opening → active when the last required role is filled', () => {
    const sup = new RoomSupervisor({ goalVerifier: verifierReturning(true, 0.9) });
    const state = sup.open(makeContract());
    sup.admit(state, makeParticipant(drafter0));
    expect(state.status).toBe('opening');
    sup.admit(state, makeParticipant(critic));
    expect(state.status).toBe('opening');
    sup.admit(state, makeParticipant(integrator));
    expect(state.status).toBe('active');
    expect(state.participants.size).toBe(3);
  });
});

describe('RoomSupervisor — recordResult role dispatch', () => {
  function setup() {
    const sup = new RoomSupervisor({ goalVerifier: verifierReturning(true, 0.9), clock: () => 1000 });
    const state = sup.open(makeContract());
    const ledger = new RoomLedger(() => 1000);
    const blackboard = new RoomBlackboard(() => 1000);
    sup.admit(state, makeParticipant(drafter0));
    sup.admit(state, makeParticipant(critic));
    sup.admit(state, makeParticipant(integrator));
    return { sup, state, ledger, blackboard };
  }

  it('drafter: stages mutations, writes draft/{i}/mutations blackboard, appends propose entry', () => {
    const { sup, state, ledger, blackboard } = setup();
    sup.recordResult(
      state,
      ledger,
      blackboard,
      drafter0,
      'room-t1::drafter-0',
      makeResult({ mutations: [makeMutation('src/a.ts'), makeMutation('src/b.ts')], tokensConsumed: 500 }),
    );
    expect(state.stagedMutations.size).toBe(2);
    expect(state.stagedMutations.get('src/a.ts')).toBeTruthy();
    expect(state.tokensConsumed).toBe(500);
    expect(ledger.size()).toBe(1);
    expect(ledger.latest()!.type).toBe('propose');
    expect(blackboard.read('draft/0/mutations')).toBeTruthy();
  });

  it('critic with concerns: writes critique/concerns and appends reject entry', () => {
    const { sup, state, ledger, blackboard } = setup();
    sup.recordResult(
      state,
      ledger,
      blackboard,
      critic,
      'room-t1::critic',
      makeResult({ uncertainties: ['type mismatch on line 42'], tokensConsumed: 300 }),
    );
    expect(ledger.latest()!.type).toBe('reject');
    expect(blackboard.read('critique/concerns')?.value).toEqual(['type mismatch on line 42']);
    expect(state.uncertainties).toContain('type mismatch on line 42');
  });

  it('critic with no concerns: appends affirm entry', () => {
    const { sup, state, ledger, blackboard } = setup();
    sup.recordResult(state, ledger, blackboard, critic, 'room-t1::critic', makeResult({ uncertainties: [] }));
    expect(ledger.latest()!.type).toBe('affirm');
  });

  it('integrator: overrides staged mutations (last-writer-wins per file) and appends claim entry', () => {
    const { sup, state, ledger, blackboard } = setup();
    // Drafter-0 stages src/a.ts with content "v1"
    sup.recordResult(
      state,
      ledger,
      blackboard,
      drafter0,
      'room-t1::drafter-0',
      makeResult({
        mutations: [{ file: 'src/a.ts', content: 'v1', diff: '', explanation: 'drafter proposal' }],
      }),
    );
    // Integrator overrides with content "v2"
    sup.recordResult(
      state,
      ledger,
      blackboard,
      integrator,
      'room-t1::integrator',
      makeResult({
        mutations: [{ file: 'src/a.ts', content: 'v2', diff: '', explanation: 'integrator finalization' }],
      }),
    );
    expect(state.stagedMutations.get('src/a.ts')?.content).toBe('v2');
    expect(ledger.latest()!.type).toBe('claim');
  });

  it('needsUserInput: transitions to awaiting-user and appends query entry', () => {
    const { sup, state, ledger, blackboard } = setup();
    sup.recordResult(
      state,
      ledger,
      blackboard,
      drafter0,
      'room-t1::drafter-0',
      makeResult({
        needsUserInput: true,
        uncertainties: ['Which auth module did you mean?'],
      }),
    );
    expect(state.status).toBe('awaiting-user');
    expect(state.needsUserInput).toBe(true);
    expect(state.pendingQuestions).toEqual(['Which auth module did you mean?']);
    expect(ledger.latest()!.type).toBe('query');
  });
});

describe('RoomSupervisor — checkConvergence predicate', () => {
  function setup(contractOverrides: Partial<RoomContract> = {}, verifier: GoalVerifier = verifierReturning(true, 0.9)) {
    const sup = new RoomSupervisor({ goalVerifier: verifier });
    const state = sup.open(makeContract(contractOverrides));
    state.status = 'active' as RoomStatus;
    return { sup, state };
  }

  const ctx = { workspace: '/ws', understanding: undefined, targetFiles: ['src/a.ts'] };

  it('returns open when rounds < minRounds', () => {
    const { sup, state } = setup({ minRounds: 2 });
    state.rounds = 1;
    state.stagedMutations.set('src/a.ts', makeMutation('src/a.ts'));
    expect(sup.checkConvergence(state, ctx)).toBe('open');
  });

  it('returns open when no mutations have been staged (integrator has not spoken)', () => {
    const { sup, state } = setup();
    state.rounds = 1;
    expect(sup.checkConvergence(state, ctx)).toBe('open');
  });

  it('returns partial when rounds ≥ maxRounds', () => {
    const { sup, state } = setup({ maxRounds: 2 });
    state.rounds = 2;
    state.stagedMutations.set('src/a.ts', makeMutation('src/a.ts'));
    expect(sup.checkConvergence(state, ctx)).toBe('partial');
  });

  it('returns partial when tokens exceed the contract budget', () => {
    const { sup, state } = setup({ tokenBudget: 500 });
    state.rounds = 1;
    state.tokensConsumed = 600;
    state.stagedMutations.set('src/a.ts', makeMutation('src/a.ts'));
    expect(sup.checkConvergence(state, ctx)).toBe('partial');
  });

  it('returns open when the verifier rejects the result', () => {
    const { sup, state } = setup({}, verifierReturning(false, 0.9));
    state.rounds = 1;
    state.stagedMutations.set('src/a.ts', makeMutation('src/a.ts'));
    expect(sup.checkConvergence(state, ctx)).toBe('open');
  });

  it('returns open when verifier confidence is below the threshold', () => {
    const { sup, state } = setup({ convergenceThreshold: 0.8 }, verifierReturning(true, 0.5));
    state.rounds = 1;
    state.stagedMutations.set('src/a.ts', makeMutation('src/a.ts'));
    expect(sup.checkConvergence(state, ctx)).toBe('open');
  });

  it('returns open when the verifier abstains', () => {
    const { sup, state } = setup({}, abstainingVerifier());
    state.rounds = 1;
    state.stagedMutations.set('src/a.ts', makeMutation('src/a.ts'));
    expect(sup.checkConvergence(state, ctx)).toBe('open');
  });

  it('returns converged when all conditions hold', () => {
    const { sup, state } = setup(
      { minRounds: 1, maxRounds: 5, convergenceThreshold: 0.6 },
      verifierReturning(true, 0.82),
    );
    state.rounds = 1;
    state.stagedMutations.set('src/a.ts', makeMutation('src/a.ts'));
    expect(sup.checkConvergence(state, ctx)).toBe('converged');
  });
});

describe('RoomSupervisor — terminal transitions and finalize', () => {
  it('markBudgetExhausted → partial with uncertainty message', () => {
    const sup = new RoomSupervisor({ goalVerifier: verifierReturning(true, 0.9), clock: () => 2000 });
    const state = sup.open(makeContract());
    state.status = 'active' as RoomStatus;
    state.rounds = 1;
    sup.markBudgetExhausted(state);
    expect(state.status).toBe('partial');
    expect(state.uncertainties[0]).toContain('budget exhausted');
    expect(state.closedAt).toBe(2000);
  });

  it('markViolation → failed with reason', () => {
    const sup = new RoomSupervisor({ goalVerifier: verifierReturning(true, 0.9) });
    const state = sup.open(makeContract());
    state.status = 'active' as RoomStatus;
    sup.markViolation(state, 'scope breach');
    expect(state.status).toBe('failed');
    expect(state.failureReason).toBe('scope breach');
  });

  it('markConverged → converged', () => {
    const sup = new RoomSupervisor({ goalVerifier: verifierReturning(true, 0.9) });
    const state = sup.open(makeContract());
    state.status = 'active' as RoomStatus;
    sup.markConverged(state);
    expect(state.status).toBe('converged');
  });

  it('finalize returns a RoomResult with mutations flattened from stagedMutations', () => {
    const sup = new RoomSupervisor({ goalVerifier: verifierReturning(true, 0.9), clock: () => 1000 });
    const state = sup.open(makeContract());
    const ledger = new RoomLedger(() => 1000);
    state.stagedMutations.set('src/a.ts', makeMutation('src/a.ts'));
    state.stagedMutations.set('src/b.ts', makeMutation('src/b.ts'));
    state.status = 'converged';
    const result = sup.finalize(state, ledger, 50);
    expect(result.mutations).toHaveLength(2);
    expect(result.status).toBe('converged');
    expect(result.durationMs).toBe(50);
    expect(result.roomId).toBe('room-t1');
  });
});
