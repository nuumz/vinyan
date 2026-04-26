/**
 * Phase 0 — failing tests for the new TaskFactsRegistry.
 *
 * The registry holds dispatch-scoped task facts so CommitmentBridge can
 * resolve goal/targetFiles/deadlineAt synchronously when
 * `market:auction_completed` arrives. Facts are registered in
 * `executeTask()` entry and unregistered in its finally block; nothing
 * else owns them.
 *
 * These tests are RED until Phase 3 lands.
 */
import { describe, expect, it } from 'bun:test';

import { TaskFactsRegistry } from '../../../src/orchestrator/ecosystem/task-facts-registry.ts';

describe('TaskFactsRegistry', () => {
  it('register/resolve roundtrip returns the exact facts payload', () => {
    const reg = new TaskFactsRegistry();
    reg.register('t-1', { goal: 'do thing', targetFiles: ['a.ts'], deadlineAt: 1234 });
    const facts = reg.resolve('t-1');
    expect(facts).not.toBeNull();
    expect(facts!.goal).toBe('do thing');
    expect(facts!.targetFiles).toEqual(['a.ts']);
    expect(facts!.deadlineAt).toBe(1234);
  });

  it('resolve returns null for unknown taskIds', () => {
    const reg = new TaskFactsRegistry();
    expect(reg.resolve('missing')).toBeNull();
  });

  it('unregister removes facts so resolve returns null', () => {
    const reg = new TaskFactsRegistry();
    reg.register('t-2', { goal: 'g', deadlineAt: 1 });
    reg.unregister('t-2');
    expect(reg.resolve('t-2')).toBeNull();
  });

  it('unregister of an unknown taskId is a no-op (does not throw)', () => {
    const reg = new TaskFactsRegistry();
    expect(() => reg.unregister('never')).not.toThrow();
  });

  it('overlapping registrations are isolated by taskId', () => {
    const reg = new TaskFactsRegistry();
    reg.register('t-a', { goal: 'A', deadlineAt: 1 });
    reg.register('t-b', { goal: 'B', deadlineAt: 2 });
    expect(reg.resolve('t-a')!.goal).toBe('A');
    expect(reg.resolve('t-b')!.goal).toBe('B');
    reg.unregister('t-a');
    expect(reg.resolve('t-a')).toBeNull();
    expect(reg.resolve('t-b')!.goal).toBe('B');
  });
});
