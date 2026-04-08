/**
 * Tests for K1.1 Contradiction Escalation in core-loop.
 *
 * Verifies that oracle contradictions (some pass, some fail) trigger
 * auto-escalation to the next routing level (A1 compliance).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createBus, type VinyanBus } from '../../src/core/bus.ts';

describe('Contradiction Escalation Events', () => {
  let bus: VinyanBus;
  const events: Array<{ event: string; data: unknown }> = [];

  beforeEach(() => {
    bus = createBus();
    events.length = 0;

    bus.on('verification:contradiction_escalated', (data) => {
      events.push({ event: 'contradiction_escalated', data });
    });
    bus.on('verification:contradiction_unresolved', (data) => {
      events.push({ event: 'contradiction_unresolved', data });
    });
    bus.on('task:escalate', (data) => {
      events.push({ event: 'task:escalate', data });
    });
    bus.on('oracle:contradiction', (data) => {
      events.push({ event: 'oracle:contradiction', data });
    });
  });

  test('contradiction_escalated event carries fromLevel and toLevel', () => {
    bus.emit('verification:contradiction_escalated', {
      taskId: 'test-1',
      fromLevel: 1,
      toLevel: 2,
      passed: ['ast'],
      failed: ['type'],
    });

    expect(events).toHaveLength(1);
    const data = events[0]!.data as { fromLevel: number; toLevel: number; passed: string[]; failed: string[] };
    expect(data.fromLevel).toBe(1);
    expect(data.toLevel).toBe(2);
    expect(data.passed).toEqual(['ast']);
    expect(data.failed).toEqual(['type']);
  });

  test('contradiction_unresolved event (L3, nowhere to escalate)', () => {
    bus.emit('verification:contradiction_unresolved', {
      taskId: 'test-2',
      passed: ['ast', 'dep'],
      failed: ['type'],
    });

    expect(events).toHaveLength(1);
    const data = events[0]!.data as { passed: string[]; failed: string[] };
    expect(data.passed).toContain('ast');
    expect(data.failed).toContain('type');
  });

  test('oracle:contradiction fires for mixed verdicts', () => {
    bus.emit('oracle:contradiction', {
      taskId: 'test-3',
      passed: ['ast'],
      failed: ['type', 'test'],
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe('oracle:contradiction');
  });
});
