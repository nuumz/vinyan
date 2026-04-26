import { describe, expect, test } from 'bun:test';
import { MAX_BRAINSTORM_DRAFTERS } from '../../../../src/orchestrator/intent/ideation-classifier.ts';
import {
  BRAINSTORM_ROOM_DEFAULTS,
  buildBrainstormRoomContract,
} from '../../../../src/orchestrator/room/presets/brainstorm-room.ts';
import { RoomContractSchema } from '../../../../src/orchestrator/room/types.ts';

describe('buildBrainstormRoomContract', () => {
  test('produces a contract that validates against RoomContractSchema', () => {
    const contract = buildBrainstormRoomContract({
      roomId: 'room-1',
      parentTaskId: 'task-1',
      goal: 'How should we migrate the SDK to Rust?',
      tokenBudget: 6000,
    });
    const parsed = RoomContractSchema.safeParse(contract);
    expect(parsed.success).toBe(true);
  });

  test('includes N drafter roles + critic + integrator by default', () => {
    const contract = buildBrainstormRoomContract({
      roomId: 'room-1',
      parentTaskId: 'task-1',
      goal: 'How should we migrate the SDK to Rust?',
      tokenBudget: 6000,
    });
    const drafterCount = contract.roles.filter((r) => r.name.startsWith('drafter-')).length;
    expect(drafterCount).toBe(BRAINSTORM_ROOM_DEFAULTS.drafterCount);
    expect(contract.roles.some((r) => r.name === 'critic')).toBe(true);
    expect(contract.roles.some((r) => r.name === 'integrator')).toBe(true);
  });

  test('clamps drafterCount below 2 up to 2', () => {
    const contract = buildBrainstormRoomContract({
      roomId: 'room-1',
      parentTaskId: 'task-1',
      goal: 'How should we migrate the SDK to Rust?',
      tokenBudget: 6000,
      drafterCount: 1,
    });
    const drafterCount = contract.roles.filter((r) => r.name.startsWith('drafter-')).length;
    expect(drafterCount).toBe(2);
  });

  test('clamps drafterCount above the hard cap', () => {
    const contract = buildBrainstormRoomContract({
      roomId: 'room-1',
      parentTaskId: 'task-1',
      goal: 'How should we migrate the SDK to Rust?',
      tokenBudget: 6000,
      drafterCount: 99,
    });
    const drafterCount = contract.roles.filter((r) => r.name.startsWith('drafter-')).length;
    expect(drafterCount).toBe(MAX_BRAINSTORM_DRAFTERS);
  });

  test('critic role cannot write files and cannot propose candidates', () => {
    const contract = buildBrainstormRoomContract({
      roomId: 'room-1',
      parentTaskId: 'task-1',
      goal: 'How should we migrate the SDK to Rust?',
      tokenBudget: 6000,
    });
    const critic = contract.roles.find((r) => r.name === 'critic')!;
    expect(critic.canWriteFiles).toBe(false);
    expect(critic.writableBlackboardKeys).toEqual(['brainstorm:critique:*']);
  });

  test('drafter scopes are unique per index (A6 blackboard isolation)', () => {
    const contract = buildBrainstormRoomContract({
      roomId: 'room-1',
      parentTaskId: 'task-1',
      goal: 'How should we migrate the SDK to Rust?',
      tokenBudget: 6000,
      drafterCount: 3,
    });
    const drafterScopes = contract.roles
      .filter((r) => r.name.startsWith('drafter-'))
      .flatMap((r) => r.writableBlackboardKeys);
    expect(new Set(drafterScopes).size).toBe(drafterScopes.length);
  });
});
