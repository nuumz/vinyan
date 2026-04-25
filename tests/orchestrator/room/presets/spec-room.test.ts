import { describe, expect, test } from 'bun:test';
import {
  buildSpecRoomContract,
  shouldUseSpecRoom,
  SPEC_ROOM_ROLES,
} from '../../../../src/orchestrator/room/presets/spec-room.ts';
import { RoomContractSchema } from '../../../../src/orchestrator/room/types.ts';

describe('SPEC_ROOM_ROLES', () => {
  test('contains exactly 4 roles with distinct names', () => {
    expect(SPEC_ROOM_ROLES.length).toBe(4);
    const names = SPEC_ROOM_ROLES.map((r) => r.name);
    expect(new Set(names).size).toBe(4);
    expect(names).toEqual(['spec-author', 'api-designer', 'edge-case-critic', 'spec-integrator']);
  });

  test('every role has a non-overlapping writable blackboard scope', () => {
    const scopes = SPEC_ROOM_ROLES.map((r) => r.writableBlackboardKeys.join(','));
    expect(new Set(scopes).size).toBe(4);
  });

  test('no role may write files (spec production is metadata, not code)', () => {
    for (const role of SPEC_ROOM_ROLES) {
      expect(role.canWriteFiles).toBe(false);
    }
  });
});

describe('buildSpecRoomContract', () => {
  test('produces a RoomContract that validates against RoomContractSchema', () => {
    const contract = buildSpecRoomContract({
      roomId: 'room-1',
      parentTaskId: 'task-1',
      goal: 'Implement cost ledger feature',
      tokenBudget: 8000,
    });
    const parsed = RoomContractSchema.safeParse(contract);
    expect(parsed.success).toBe(true);
  });

  test('defaults convergenceThreshold to 0.7', () => {
    const contract = buildSpecRoomContract({
      roomId: 'room-1',
      parentTaskId: 'task-1',
      goal: 'Implement cost ledger feature',
      tokenBudget: 8000,
    });
    expect(contract.convergenceThreshold).toBe(0.7);
  });

  test('caller can override convergenceThreshold', () => {
    const contract = buildSpecRoomContract({
      roomId: 'room-1',
      parentTaskId: 'task-1',
      goal: 'Implement cost ledger feature',
      tokenBudget: 8000,
      convergenceThreshold: 0.9,
    });
    expect(contract.convergenceThreshold).toBe(0.9);
  });

  test('includes teamId + teamSharedKeys when provided (Ecosystem O3)', () => {
    const contract = buildSpecRoomContract({
      roomId: 'room-1',
      parentTaskId: 'task-1',
      goal: 'Implement cost ledger feature',
      tokenBudget: 8000,
      teamId: 'team-economy',
      teamSharedKeys: ['shared:budget-rules'],
    });
    expect(contract.teamId).toBe('team-economy');
    expect(contract.teamSharedKeys).toEqual(['shared:budget-rules']);
  });
});

describe('shouldUseSpecRoom', () => {
  test('rejects goals shorter than minimum length', () => {
    expect(shouldUseSpecRoom('short one')).toBe(false);
  });

  test('matches concrete build/implement verbs with deliverable nouns', () => {
    expect(shouldUseSpecRoom('Implement new API endpoint for cost reporting')).toBe(true);
    expect(shouldUseSpecRoom('Build a feature that tracks spend per tenant')).toBe(true);
  });

  test('matches Thai deliverable framings', () => {
    expect(shouldUseSpecRoom('ทำฟีเจอร์รายงานต้นทุนต่อผู้ใช้แบบละเอียด')).toBe(true);
  });

  test('does not match pure ideation goals (those go to brainstorm)', () => {
    expect(shouldUseSpecRoom('What should we do about cold start latency?')).toBe(false);
  });
});
