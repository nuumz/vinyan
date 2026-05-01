/**
 * A1 — Epistemic Separation invariant.
 *
 * No engine evaluates its own output. The persona-class taxonomy enforces
 * this at the dispatcher boundary BEFORE any LLM is invoked (A3-safe).
 */
import { describe, expect, test } from 'bun:test';
import {
  assertA1Compatible,
  CANONICAL_VERIFIER_ROLE,
  personaClassOf,
} from '../../src/orchestrator/agents/persona-class.ts';

describe('A1 — Epistemic Separation', () => {
  test('rejects same persona id on both sides of the gen/verify boundary', () => {
    const check = assertA1Compatible('developer', 'agent-x', 'developer', 'agent-x');
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('same persona');
  });

  test('rejects two generator-class personas paired across the boundary', () => {
    const check = assertA1Compatible('developer', 'dev', 'architect', 'arch');
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('A1 violation');
  });

  test('accepts generator paired with verifier-class persona', () => {
    const check = assertA1Compatible('developer', 'dev', 'reviewer', CANONICAL_VERIFIER_ROLE);
    expect(check.ok).toBe(true);
  });

  test('accepts generator paired with mixed-class persona (forgiveness slot)', () => {
    const check = assertA1Compatible('developer', 'dev', 'coordinator', 'coord');
    expect(check.ok).toBe(true);
  });

  test('classifier returns generator for generator-class roles', () => {
    expect(personaClassOf('developer')).toBe('generator');
    expect(personaClassOf('architect')).toBe('generator');
    expect(personaClassOf('reviewer')).toBe('verifier');
    expect(personaClassOf('coordinator')).toBe('mixed');
    expect(personaClassOf(undefined)).toBe('mixed');
  });
});
