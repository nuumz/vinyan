/**
 * RoomBlackboard — behavior tests.
 *
 * Covers: authorized writes, A6 scope violations, versioning, read semantics,
 * glob-based key matching, scopedView produces a separate snapshot.
 */
import { describe, expect, it } from 'bun:test';
import { isKeyWritable, RoomBlackboard } from '../../../src/orchestrator/room/room-blackboard.ts';
import { BlackboardScopeViolation, type RoleSpec } from '../../../src/orchestrator/room/types.ts';

const drafter0: RoleSpec = {
  name: 'drafter-0',
  responsibility: 'draft role',
  writableBlackboardKeys: ['draft/0/*'],
  maxTurns: 5,
  canWriteFiles: true,
};
const critic: RoleSpec = {
  name: 'critic',
  responsibility: 'critic role',
  writableBlackboardKeys: ['critique/*'],
  maxTurns: 5,
  canWriteFiles: false,
};
const integrator: RoleSpec = {
  name: 'integrator',
  responsibility: 'integrator role',
  writableBlackboardKeys: ['final/**'],
  maxTurns: 5,
  canWriteFiles: true,
};

describe('isKeyWritable', () => {
  it('single-star wildcard matches within a path segment', () => {
    expect(isKeyWritable('draft/0/mutations', ['draft/0/*'])).toBe(true);
    expect(isKeyWritable('draft/0/mutations/extra', ['draft/0/*'])).toBe(false);
  });

  it('double-star wildcard matches across path segments', () => {
    expect(isKeyWritable('final/v2/mutations', ['final/**'])).toBe(true);
    expect(isKeyWritable('final/nested/deep/ok', ['final/**'])).toBe(true);
  });

  it('exact pattern matches the exact key only', () => {
    expect(isKeyWritable('critique/concerns', ['critique/concerns'])).toBe(true);
    expect(isKeyWritable('critique/other', ['critique/concerns'])).toBe(false);
  });

  it('rejects keys not matching any pattern', () => {
    expect(isKeyWritable('draft/0/mutations', ['critique/*'])).toBe(false);
  });
});

describe('RoomBlackboard', () => {
  it('authorized write succeeds and read returns the value', () => {
    const bb = new RoomBlackboard(() => 1000);
    const entry = bb.write('draft/0/mutations', [{ file: 'a.ts' }], drafter0);
    expect(entry.version).toBe(0);
    expect(entry.authorRole).toBe('drafter-0');
    expect(bb.read('draft/0/mutations')?.value).toEqual([{ file: 'a.ts' }]);
  });

  it('unauthorized write throws BlackboardScopeViolation (A6)', () => {
    const bb = new RoomBlackboard(() => 1000);
    let error: unknown;
    try {
      bb.write('final/mutations', ['x'], drafter0);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BlackboardScopeViolation);
    const violation = error as BlackboardScopeViolation;
    expect(violation.roleName).toBe('drafter-0');
    expect(violation.key).toBe('final/mutations');
  });

  it('critic cannot write to draft or final keys', () => {
    const bb = new RoomBlackboard(() => 1000);
    expect(() => bb.write('draft/0/mutations', ['x'], critic)).toThrow(BlackboardScopeViolation);
    expect(() => bb.write('final/mutations', ['x'], critic)).toThrow(BlackboardScopeViolation);
    // But critic CAN write to critique/*
    const concerns = bb.write('critique/concerns', ['type error'], critic);
    expect(concerns.value).toEqual(['type error']);
  });

  it('overwriting a key increments version', () => {
    const bb = new RoomBlackboard(() => 1000);
    const first = bb.write('draft/0/mutations', ['v1'], drafter0);
    const second = bb.write('draft/0/mutations', ['v2'], drafter0);
    expect(first.version).toBe(0);
    expect(second.version).toBe(1);
    expect(bb.read('draft/0/mutations')?.value).toEqual(['v2']);
  });

  it('read returns undefined for missing keys', () => {
    const bb = new RoomBlackboard(() => 1000);
    expect(bb.read('nothing/here')).toBeUndefined();
  });

  it('scopedView is a separate snapshot — mutating the original does not affect the view', () => {
    const bb = new RoomBlackboard(() => 1000);
    bb.write('draft/0/mutations', ['v1'], drafter0);
    const view = bb.scopedView(drafter0);
    bb.write('draft/0/mutations', ['v2'], drafter0);
    // The view captured at the earlier point in time is a snapshot (shallow copy)
    expect(view.get('draft/0/mutations')?.value).toEqual(['v1']);
  });

  it('integrator can write final/** with multi-segment keys', () => {
    const bb = new RoomBlackboard(() => 1000);
    expect(() => bb.write('final/mutations', ['x'], integrator)).not.toThrow();
    expect(() => bb.write('final/audit/trail', ['t'], integrator)).not.toThrow();
  });
});
