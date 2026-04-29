/**
 * Phase-13 persona class taxonomy.
 *
 * Covers `personaClassOf` (pure classifier) and `assertA1Compatible`
 * (pair guard). Soul-lint integration is tested via the registry suite.
 */
import { describe, expect, test } from 'bun:test';
import {
  assertA1Compatible,
  CANONICAL_VERIFIER_ROLE,
  GENERATOR_ROLES,
  MIXED_ROLES,
  personaClassOf,
  VERIFIER_ROLES,
} from '../../../src/orchestrator/agents/persona-class.ts';

describe('personaClassOf', () => {
  test('every shipped builtin role maps to exactly one class', () => {
    const allRoles = [...GENERATOR_ROLES, ...VERIFIER_ROLES, ...MIXED_ROLES];
    expect(allRoles).toHaveLength(9);
    const seen = new Set<string>();
    for (const r of allRoles) {
      expect(seen.has(r)).toBe(false);
      seen.add(r);
    }
  });

  test('Generator-class roles', () => {
    for (const r of GENERATOR_ROLES) expect(personaClassOf(r)).toBe('generator');
  });

  test('Verifier-class roles', () => {
    for (const r of VERIFIER_ROLES) expect(personaClassOf(r)).toBe('verifier');
  });

  test('Mixed-class roles', () => {
    for (const r of MIXED_ROLES) expect(personaClassOf(r)).toBe('mixed');
  });

  test('undefined / unknown role → mixed (forgiving for legacy personas)', () => {
    expect(personaClassOf(undefined)).toBe('mixed');
  });

  test('CANONICAL_VERIFIER_ROLE is a Verifier-class role', () => {
    expect(personaClassOf(CANONICAL_VERIFIER_ROLE)).toBe('verifier');
  });
});

describe('assertA1Compatible', () => {
  test('same persona id → fail (no self-verify)', () => {
    const r = assertA1Compatible('developer', 'dev1', 'developer', 'dev1');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('same persona');
  });

  test('Generator + Verifier → ok', () => {
    expect(assertA1Compatible('developer', 'dev', 'reviewer', 'rev').ok).toBe(true);
    expect(assertA1Compatible('architect', 'arch', 'reviewer', 'rev').ok).toBe(true);
    expect(assertA1Compatible('author', 'au', 'reviewer', 'rev').ok).toBe(true);
    expect(assertA1Compatible('researcher', 'res', 'reviewer', 'rev').ok).toBe(true);
  });

  test('Generator + Generator → fail', () => {
    const r = assertA1Compatible('developer', 'dev', 'architect', 'arch');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('A1 violation');
  });

  test('Generator + Mixed → ok (forgiveness slot)', () => {
    expect(assertA1Compatible('developer', 'dev', 'coordinator', 'coord').ok).toBe(true);
    expect(assertA1Compatible('developer', 'dev', 'assistant', 'asst').ok).toBe(true);
  });

  test('Verifier + Verifier → ok (A1 binds the generator side)', () => {
    expect(assertA1Compatible('reviewer', 'rev1', 'reviewer', 'rev2').ok).toBe(true);
  });

  test('Mixed + Mixed → ok', () => {
    expect(assertA1Compatible('coordinator', 'coord', 'assistant', 'asst').ok).toBe(true);
  });

  test('undefined roles → mixed → ok (legacy / user-authored personas)', () => {
    expect(assertA1Compatible(undefined, 'a', undefined, 'b').ok).toBe(true);
  });
});
