/**
 * Tests for the RoleProtocol registry. Behavior-only: every assertion
 * exercises a public function and verifies the documented contract.
 *
 * Coverage:
 *   - lookup: get + list before/after register/unregister
 *   - validation: id format, duplicate steps, dangling preconditions,
 *     dangling targetFilesFromStep, exit criteria pointing to undeclared
 *     oracles, out-of-range thresholds
 *   - branded id constructor
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  clearDynamicRoleProtocols,
  getRoleProtocol,
  listRoleProtocolIds,
  registerRoleProtocol,
  unregisterRoleProtocol,
  validateProtocol,
} from '../../../../src/orchestrator/agents/role-protocols/registry.ts';
import { makeRoleProtocolId, type RoleProtocol } from '../../../../src/orchestrator/agents/role-protocols/types.ts';

function minimalProtocol(overrides: Partial<RoleProtocol> = {}): RoleProtocol {
  return {
    id: makeRoleProtocolId('test.minimal'),
    description: 'Minimal one-step protocol used by tests.',
    steps: [
      {
        id: 'step-one',
        kind: 'gather',
        description: 'Single placeholder step.',
        promptPrepend: 'You are gathering.',
      },
    ],
    ...overrides,
  };
}

afterEach(() => {
  clearDynamicRoleProtocols();
});

describe('makeRoleProtocolId', () => {
  test('accepts a lowercase dot-namespaced id', () => {
    expect(makeRoleProtocolId('researcher.investigate')).toBe('researcher.investigate' as never);
  });

  test('accepts deeper namespacing', () => {
    expect(makeRoleProtocolId('content-creator.ideate.shortform')).toBe('content-creator.ideate.shortform' as never);
  });

  test('rejects single-segment ids (must dot-namespace)', () => {
    expect(() => makeRoleProtocolId('researcher')).toThrow('Invalid RoleProtocolId');
  });

  test('rejects uppercase letters', () => {
    expect(() => makeRoleProtocolId('Researcher.Investigate')).toThrow('Invalid RoleProtocolId');
  });

  test('rejects empty string', () => {
    expect(() => makeRoleProtocolId('')).toThrow('Invalid RoleProtocolId');
  });
});

describe('registerRoleProtocol / getRoleProtocol', () => {
  test('lookup returns undefined when nothing registered', () => {
    expect(getRoleProtocol('test.minimal')).toBeUndefined();
  });

  test('register makes a protocol visible to lookup', () => {
    const protocol = minimalProtocol();
    registerRoleProtocol(protocol);
    expect(getRoleProtocol('test.minimal')).toBe(protocol);
  });

  test('listRoleProtocolIds includes registered protocols', () => {
    registerRoleProtocol(minimalProtocol({ id: makeRoleProtocolId('test.alpha') }));
    registerRoleProtocol(minimalProtocol({ id: makeRoleProtocolId('test.beta') }));
    const ids = listRoleProtocolIds();
    expect(ids).toContain('test.alpha');
    expect(ids).toContain('test.beta');
  });

  test('re-register overwrites the previous entry', () => {
    registerRoleProtocol(minimalProtocol({ description: 'first' }));
    registerRoleProtocol(minimalProtocol({ description: 'second' }));
    expect(getRoleProtocol('test.minimal')?.description).toBe('second');
  });

  test('unregister removes the entry; returns true on hit', () => {
    registerRoleProtocol(minimalProtocol());
    expect(unregisterRoleProtocol('test.minimal')).toBe(true);
    expect(getRoleProtocol('test.minimal')).toBeUndefined();
  });

  test('unregister returns false when nothing to remove', () => {
    expect(unregisterRoleProtocol('test.never-registered')).toBe(false);
  });
});

describe('validateProtocol', () => {
  test('passes a minimal valid protocol', () => {
    expect(() => validateProtocol(minimalProtocol())).not.toThrow();
  });

  test('rejects an empty steps list', () => {
    expect(() => validateProtocol(minimalProtocol({ steps: [] }))).toThrow('must declare at least one step');
  });

  test('rejects malformed id (not dot-namespaced)', () => {
    expect(() =>
      validateProtocol({
        ...minimalProtocol(),
        id: 'badid' as never,
      }),
    ).toThrow('lowercase dot-namespaced');
  });

  test('rejects duplicate step ids', () => {
    expect(() =>
      validateProtocol(
        minimalProtocol({
          steps: [
            { id: 'a', kind: 'gather', description: 'x', promptPrepend: 'p' },
            { id: 'a', kind: 'analyze', description: 'y', promptPrepend: 'q' },
          ],
        }),
      ),
    ).toThrow('duplicate step id');
  });

  test('rejects forward-referencing precondition', () => {
    expect(() =>
      validateProtocol(
        minimalProtocol({
          steps: [
            { id: 'a', kind: 'gather', description: 'x', promptPrepend: 'p', preconditions: ['b'] },
            { id: 'b', kind: 'analyze', description: 'y', promptPrepend: 'q' },
          ],
        }),
      ),
    ).toThrow('must reference an earlier step');
  });

  test('rejects unknown precondition', () => {
    expect(() =>
      validateProtocol(
        minimalProtocol({
          steps: [{ id: 'a', kind: 'gather', description: 'x', promptPrepend: 'p', preconditions: ['ghost'] }],
        }),
      ),
    ).toThrow('must reference an earlier step');
  });

  test('rejects targetFilesFromStep that points to a later step', () => {
    expect(() =>
      validateProtocol(
        minimalProtocol({
          steps: [
            { id: 'a', kind: 'gather', description: 'x', promptPrepend: 'p', targetFilesFromStep: 'b' },
            { id: 'b', kind: 'analyze', description: 'y', promptPrepend: 'q' },
          ],
        }),
      ),
    ).toThrow('targetFilesFromStep "b"');
  });

  test('rejects oracle-pass exit criterion when no step declares the oracle', () => {
    expect(() =>
      validateProtocol(
        minimalProtocol({
          exitCriteria: [{ kind: 'oracle-pass', oracleName: 'unknown-oracle' }],
        }),
      ),
    ).toThrow('exit criterion references oracle "unknown-oracle"');
  });

  test('accepts oracle-pass exit when at least one step declares the oracle', () => {
    expect(() =>
      validateProtocol(
        minimalProtocol({
          steps: [
            {
              id: 'a',
              kind: 'verify',
              description: 'check',
              promptPrepend: '',
              oracleHooks: [{ oracleName: 'source-citation', blocking: true }],
            },
          ],
          exitCriteria: [{ kind: 'oracle-pass', oracleName: 'source-citation' }],
        }),
      ),
    ).not.toThrow();
  });

  test('rejects evidence-confidence threshold outside [0, 1]', () => {
    expect(() =>
      validateProtocol(minimalProtocol({ exitCriteria: [{ kind: 'evidence-confidence', threshold: 1.5 }] })),
    ).toThrow('out of range');
    expect(() =>
      validateProtocol(minimalProtocol({ exitCriteria: [{ kind: 'evidence-confidence', threshold: -0.1 }] })),
    ).toThrow('out of range');
  });

  test('rejects step-count minSteps < 1', () => {
    expect(() => validateProtocol(minimalProtocol({ exitCriteria: [{ kind: 'step-count', minSteps: 0 }] }))).toThrow(
      'must be ≥ 1',
    );
  });
});

describe('clearDynamicRoleProtocols', () => {
  test('removes every dynamic registration', () => {
    registerRoleProtocol(minimalProtocol({ id: makeRoleProtocolId('test.x') }));
    registerRoleProtocol(minimalProtocol({ id: makeRoleProtocolId('test.y') }));
    clearDynamicRoleProtocols();
    expect(getRoleProtocol('test.x')).toBeUndefined();
    expect(getRoleProtocol('test.y')).toBeUndefined();
  });
});
