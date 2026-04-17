/**
 * Tests for creative-writing-room preset — role composition + trigger heuristic.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildCreativeWritingRoomContract,
  CREATIVE_WRITING_ROLES,
  shouldUseCreativeWritingRoom,
} from '../../../../src/orchestrator/room/presets/creative-writing-room.ts';
import { RoomContractSchema } from '../../../../src/orchestrator/room/types.ts';

describe('CREATIVE_WRITING_ROLES', () => {
  test('includes writer, editor, and trend-analyst as distinct roles', () => {
    const names = CREATIVE_WRITING_ROLES.map((r) => r.name);
    expect(names).toEqual(['writer', 'editor', 'trend-analyst']);
  });

  test('only the writer can write files; editor and analyst are read-only', () => {
    const writer = CREATIVE_WRITING_ROLES.find((r) => r.name === 'writer')!;
    const editor = CREATIVE_WRITING_ROLES.find((r) => r.name === 'editor')!;
    const analyst = CREATIVE_WRITING_ROLES.find((r) => r.name === 'trend-analyst')!;
    expect(writer.canWriteFiles).toBe(true);
    expect(editor.canWriteFiles).toBe(false);
    expect(analyst.canWriteFiles).toBe(false);
  });

  test('each role has non-overlapping blackboard write scopes', () => {
    const allScopes = CREATIVE_WRITING_ROLES.flatMap((r) => r.writableBlackboardKeys);
    // Verify role-specific prefixes are disjoint.
    expect(allScopes.some((s) => s.startsWith('writer:'))).toBe(true);
    expect(allScopes.some((s) => s.startsWith('editor:'))).toBe(true);
    expect(allScopes.some((s) => s.startsWith('analyst:'))).toBe(true);
  });
});

describe('buildCreativeWritingRoomContract', () => {
  test('produces a Zod-valid RoomContract', () => {
    const contract = buildCreativeWritingRoomContract({
      roomId: 'room-1',
      parentTaskId: 'task-1',
      goal: 'Write a webtoon romance-fantasy',
      tokenBudget: 20_000,
    });
    const parsed = RoomContractSchema.safeParse(contract);
    expect(parsed.success).toBe(true);
  });

  test('applies sensible defaults for rounds and convergence', () => {
    const contract = buildCreativeWritingRoomContract({
      roomId: 'room-1',
      parentTaskId: 'task-1',
      goal: 'x',
      tokenBudget: 1000,
    });
    expect(contract.maxRounds).toBeGreaterThan(contract.minRounds);
    expect(contract.convergenceThreshold).toBeGreaterThan(0.5);
    expect(contract.convergenceThreshold).toBeLessThanOrEqual(1);
    expect(contract.roles).toHaveLength(3);
  });

  test('accepts an override for convergence threshold', () => {
    const contract = buildCreativeWritingRoomContract({
      roomId: 'r',
      parentTaskId: 't',
      goal: 'g',
      tokenBudget: 1000,
      convergenceThreshold: 0.85,
    });
    expect(contract.convergenceThreshold).toBe(0.85);
  });
});

describe('shouldUseCreativeWritingRoom', () => {
  test('fires on explicit creative deliverable requests', () => {
    expect(shouldUseCreativeWritingRoom('เขียนนิยายเว็บตูนสักเรื่อง')).toBe(true);
    expect(shouldUseCreativeWritingRoom('write a novel chapter')).toBe(true);
    expect(shouldUseCreativeWritingRoom('compose a blog post about AI')).toBe(true);
  });

  test('does NOT fire on short or non-creative goals', () => {
    expect(shouldUseCreativeWritingRoom('hi')).toBe(false);
    expect(shouldUseCreativeWritingRoom('fix bug in auth.ts')).toBe(false);
    expect(shouldUseCreativeWritingRoom('refactor the login flow')).toBe(false);
  });
});
