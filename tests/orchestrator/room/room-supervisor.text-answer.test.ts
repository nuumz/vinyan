/**
 * RoomSupervisor — text-answer mode tests (Phase 2 multi-agent debate fix).
 *
 * Pins the new convergence path that does NOT require staged mutations or
 * a goal-alignment verdict. Convergence in text-answer mode is purely a
 * function of per-role `turnsUsed`:
 *   - every primary-participant has spoken `1 + rebuttalRounds` turns
 *   - the integrator (when present) has spoken at least once
 *
 * Mutation-mode behaviour is covered by the existing room-supervisor.test.ts.
 */
import { describe, expect, it } from 'bun:test';
import { RoomBlackboard } from '../../../src/orchestrator/room/room-blackboard.ts';
import { RoomLedger } from '../../../src/orchestrator/room/room-ledger.ts';
import {
  type GoalVerifier,
  type ParticipantResult,
  RoomSupervisor,
} from '../../../src/orchestrator/room/room-supervisor.ts';
import type { RoleSpec, RoomContract, RoomParticipant } from '../../../src/orchestrator/room/types.ts';

const primary1: RoleSpec = {
  name: 'primary-1',
  responsibility: 'answer the user goal',
  writableBlackboardKeys: ['discussion/primary-1/*'],
  maxTurns: 5,
  canWriteFiles: false,
  roleClass: 'primary-participant',
};
const primary2: RoleSpec = { ...primary1, name: 'primary-2', writableBlackboardKeys: ['discussion/primary-2/*'] };
const primary3: RoleSpec = { ...primary1, name: 'primary-3', writableBlackboardKeys: ['discussion/primary-3/*'] };
const oversight: RoleSpec = {
  name: 'oversight',
  responsibility: 'flag concerns',
  writableBlackboardKeys: ['oversight/*'],
  maxTurns: 5,
  canWriteFiles: false,
  roleClass: 'oversight',
};
const integrator: RoleSpec = {
  name: 'integrator',
  responsibility: 'synthesize the final answer',
  writableBlackboardKeys: ['final/*'],
  maxTurns: 1,
  canWriteFiles: false,
  roleClass: 'integrator',
};

function textAnswerContract(overrides: Partial<RoomContract> = {}): RoomContract {
  // 3 primaries × (1 initial + 2 rebuttal) + 1 integrator = 4 rounds total.
  return {
    roomId: 'room-debate',
    parentTaskId: 't-debate',
    goal: 'discuss the trade-offs',
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

function makeParticipant(role: RoleSpec, modelId = `${role.name}-model`): RoomParticipant {
  return {
    id: `room-debate::${role.name}`,
    roomId: 'room-debate',
    roleName: role.name,
    workerId: `${role.name}-worker`,
    workerModelId: modelId,
    turnsUsed: 0,
    tokensUsed: 0,
    status: 'admitted',
    admittedAt: 1000,
  };
}

function makeResult(content = 'an answer', overrides: Partial<ParticipantResult> = {}): ParticipantResult {
  return {
    mutations: [],
    uncertainties: [],
    tokensConsumed: 100,
    needsUserInput: false,
    durationMs: 10,
    proposedContent: content,
    ...overrides,
  };
}

// A verifier that should never be consulted in text-answer mode. If it is
// called, the test should fail by surfacing this throw.
function shouldNotBeCalledVerifier(): GoalVerifier {
  return () => {
    throw new Error('text-answer mode must not invoke goalVerifier');
  };
}

function admitAll(sup: RoomSupervisor, state: ReturnType<RoomSupervisor['open']>, roles: RoleSpec[]): void {
  for (const r of roles) sup.admit(state, makeParticipant(r));
}

describe('RoomSupervisor — text-answer convergence', () => {
  it('returns "open" when no participant has spoken yet', () => {
    const sup = new RoomSupervisor({ goalVerifier: shouldNotBeCalledVerifier() });
    const state = sup.open(textAnswerContract());
    admitAll(sup, state, [primary1, primary2, primary3, integrator]);
    expect(sup.checkConvergence(state, { workspace: '/tmp' })).toBe('open');
  });

  it('returns "open" until every primary has spoken 1 + rebuttalRounds turns', () => {
    const sup = new RoomSupervisor({ goalVerifier: shouldNotBeCalledVerifier() });
    const state = sup.open(textAnswerContract());
    admitAll(sup, state, [primary1, primary2, primary3, integrator]);
    const ledger = new RoomLedger(() => 1000);
    const blackboard = new RoomBlackboard(() => 1000);

    // Simulate 3 rounds of primaries speaking. We bump state.rounds
    // manually because the dispatcher (not the supervisor) advances rounds
    // in the real loop.
    for (let round = 0; round < 3; round++) {
      state.rounds = round;
      for (const role of [primary1, primary2, primary3]) {
        sup.recordResult(state, ledger, blackboard, role, `room-debate::${role.name}`, makeResult(`r${round}`));
      }
    }
    // Primaries done; integrator has not spoken yet → still open.
    expect(state.participants.get('room-debate::primary-1')?.turnsUsed).toBe(3);
    expect(state.participants.get('room-debate::primary-2')?.turnsUsed).toBe(3);
    expect(state.participants.get('room-debate::primary-3')?.turnsUsed).toBe(3);
    expect(sup.checkConvergence(state, { workspace: '/tmp' })).toBe('open');

    // Integrator speaks → converged.
    state.rounds = 3;
    sup.recordResult(state, ledger, blackboard, integrator, 'room-debate::integrator', makeResult('synth'));
    expect(state.participants.get('room-debate::integrator')?.turnsUsed).toBe(1);
    expect(sup.checkConvergence(state, { workspace: '/tmp' })).toBe('converged');
  });

  it('does NOT require staged mutations to converge', () => {
    const sup = new RoomSupervisor({ goalVerifier: shouldNotBeCalledVerifier() });
    const state = sup.open(textAnswerContract({ rebuttalRounds: 0, maxRounds: 2 }));
    admitAll(sup, state, [primary1, primary2, primary3, integrator]);
    const ledger = new RoomLedger(() => 1000);
    const blackboard = new RoomBlackboard(() => 1000);

    state.rounds = 0;
    for (const role of [primary1, primary2, primary3]) {
      sup.recordResult(state, ledger, blackboard, role, `room-debate::${role.name}`, makeResult('hi'));
    }
    state.rounds = 1;
    sup.recordResult(state, ledger, blackboard, integrator, 'room-debate::integrator', makeResult('synth'));

    expect(state.stagedMutations.size).toBe(0);
    expect(sup.checkConvergence(state, { workspace: '/tmp' })).toBe('converged');
  });

  it('returns "converged" without an integrator role when only primaries are configured', () => {
    const sup = new RoomSupervisor({ goalVerifier: shouldNotBeCalledVerifier() });
    const state = sup.open(
      textAnswerContract({
        roles: [primary1, primary2, primary3],
        maxRounds: 1,
        rebuttalRounds: 0,
      }),
    );
    admitAll(sup, state, [primary1, primary2, primary3]);
    const ledger = new RoomLedger(() => 1000);
    const blackboard = new RoomBlackboard(() => 1000);

    state.rounds = 0;
    for (const role of [primary1, primary2, primary3]) {
      sup.recordResult(state, ledger, blackboard, role, `room-debate::${role.name}`, makeResult('answer'));
    }
    expect(sup.checkConvergence(state, { workspace: '/tmp' })).toBe('converged');
  });

  it('returns "partial" when budget exhausted regardless of turn count', () => {
    const sup = new RoomSupervisor({ goalVerifier: shouldNotBeCalledVerifier() });
    const state = sup.open(textAnswerContract({ tokenBudget: 100 }));
    admitAll(sup, state, [primary1, primary2, primary3, integrator]);
    state.tokensConsumed = 200; // exceeds budget
    expect(sup.checkConvergence(state, { workspace: '/tmp' })).toBe('partial');
  });
});

describe('RoomSupervisor — text-answer recordResult', () => {
  it('writes proposedContent to discussion/<role>/round-<n> blackboard key', () => {
    const sup = new RoomSupervisor({ goalVerifier: shouldNotBeCalledVerifier() });
    const state = sup.open(textAnswerContract());
    admitAll(sup, state, [primary1, primary2, primary3, integrator]);
    const ledger = new RoomLedger(() => 1000);
    const blackboard = new RoomBlackboard(() => 1000);

    state.rounds = 1;
    sup.recordResult(
      state,
      ledger,
      blackboard,
      primary2,
      'room-debate::primary-2',
      makeResult('this is my round-2 answer'),
    );
    const entry = blackboard.read('discussion/primary-2/round-1');
    expect(entry).toBeDefined();
    expect(entry!.value).toBe('this is my round-2 answer');
  });

  it('does NOT stage mutations from a primary participant even if result has them', () => {
    const sup = new RoomSupervisor({ goalVerifier: shouldNotBeCalledVerifier() });
    const state = sup.open(textAnswerContract());
    admitAll(sup, state, [primary1, primary2, primary3, integrator]);
    const ledger = new RoomLedger(() => 1000);
    const blackboard = new RoomBlackboard(() => 1000);

    state.rounds = 0;
    sup.recordResult(state, ledger, blackboard, primary1, 'room-debate::primary-1', {
      ...makeResult('text answer'),
      mutations: [{ file: 'a.ts', diff: '+x', content: 'x', explanation: '' }],
    });
    expect(state.stagedMutations.size).toBe(0);
  });

  it('integrator writes final/answer and emits "claim" ledger entry', () => {
    const sup = new RoomSupervisor({ goalVerifier: shouldNotBeCalledVerifier() });
    const state = sup.open(textAnswerContract());
    admitAll(sup, state, [primary1, primary2, primary3, integrator]);
    const ledger = new RoomLedger(() => 1000);
    const blackboard = new RoomBlackboard(() => 1000);

    state.rounds = 3;
    sup.recordResult(state, ledger, blackboard, integrator, 'room-debate::integrator', makeResult('synthesized output'));
    const finalEntry = blackboard.read('final/answer');
    expect(finalEntry?.value).toBe('synthesized output');
    const claim = ledger.readAll().find((e) => e.type === 'claim');
    expect(claim).toBeDefined();
    expect(claim!.authorRole).toBe('integrator');
  });

  it('needsUserInput from primary-participant transitions room to awaiting-user', () => {
    const sup = new RoomSupervisor({ goalVerifier: shouldNotBeCalledVerifier() });
    const state = sup.open(textAnswerContract());
    admitAll(sup, state, [primary1, primary2, primary3, integrator]);
    const ledger = new RoomLedger(() => 1000);
    const blackboard = new RoomBlackboard(() => 1000);

    state.rounds = 0;
    sup.recordResult(state, ledger, blackboard, primary2, 'room-debate::primary-2', {
      ...makeResult(''),
      needsUserInput: true,
      uncertainties: ['what tone do you want?'],
    });
    expect(state.status).toBe('awaiting-user');
    expect(state.pendingQuestions).toContain('what tone do you want?');
    // The participant still counts as having yielded a turn — Phase 4
    // resume behaviour is implemented at the dispatcher level.
    expect(state.participants.get('room-debate::primary-2')?.turnsUsed).toBe(1);
  });
});

describe('RoomSupervisor — backward compatibility (mutation mode)', () => {
  // Spot check that mutation-mode rooms still work — the full mutation-mode
  // suite lives in room-supervisor.test.ts; this is a smoke check that the
  // text-answer changes did not regress the legacy default.
  it('legacy roles without roleClass still dispatch by name', () => {
    const drafter: RoleSpec = {
      name: 'drafter-0',
      responsibility: 'd',
      writableBlackboardKeys: ['draft/0/*'],
      maxTurns: 1,
      canWriteFiles: true,
    };
    const sup = new RoomSupervisor({ goalVerifier: shouldNotBeCalledVerifier() });
    const contract: RoomContract = {
      roomId: 'r',
      parentTaskId: 't',
      goal: 'g',
      roles: [drafter],
      maxRounds: 2,
      minRounds: 1,
      convergenceThreshold: 0.7,
      tokenBudget: 1000,
      // no outputMode → defaults to mutation behaviour
    };
    const state = sup.open(contract);
    admitAll(sup, state, [drafter]);
    const ledger = new RoomLedger(() => 1000);
    const blackboard = new RoomBlackboard(() => 1000);
    sup.recordResult(state, ledger, blackboard, drafter, 'r::drafter-0', {
      mutations: [{ file: 'a.ts', diff: '+x', content: 'x', explanation: '' }],
      uncertainties: [],
      tokensConsumed: 10,
      needsUserInput: false,
      durationMs: 1,
    });
    // Legacy drafter staged the mutation — proves name-based derivation
    // routed to applyDrafter via 'mutation-drafter' class.
    expect(state.stagedMutations.size).toBe(1);
  });
});
