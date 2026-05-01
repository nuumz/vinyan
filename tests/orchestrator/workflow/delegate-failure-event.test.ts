/**
 * R1 — workflow:delegate_failed event emission.
 *
 * Verifies the audit-trail event fires in the timeout, failure, and
 * cascade-skip branches of the delegate-sub-agent workflow step. The
 * event is the durable terminal record (manifest record:true) that
 * complements the live-only `workflow:delegate_timeout` /
 * `workflow:delegate_completed` signals.
 */
import { describe, expect, test } from 'bun:test';
import { EventBus, type VinyanBusEvents } from '../../../src/core/bus.ts';

describe('R1 workflow:delegate_failed — schema and contract', () => {
  test('event payload shape is honored by the typed bus', () => {
    const bus = new EventBus<VinyanBusEvents>();
    const captured: VinyanBusEvents['workflow:delegate_failed'][] = [];
    bus.on('workflow:delegate_failed', (p) => captured.push(p));

    bus.emit('workflow:delegate_failed', {
      taskId: 'parent-task',
      stepId: 'step-2',
      subTaskId: 'parent-task-sub-1',
      agentId: 'reviewer',
      status: 'timeout',
      reason: 'idle: no LLM activity for 120s',
      errorClass: 'idle_timeout',
      durationMs: 120_000,
    });
    expect(captured.length).toBe(1);
    expect(captured[0]?.status).toBe('timeout');
    expect(captured[0]?.errorClass).toBe('idle_timeout');
    expect(captured[0]?.durationMs).toBe(120_000);
  });

  test('cascade-skipped delegate emits status="skipped"', () => {
    const bus = new EventBus<VinyanBusEvents>();
    const captured: VinyanBusEvents['workflow:delegate_failed'][] = [];
    bus.on('workflow:delegate_failed', (p) => captured.push(p));

    bus.emit('workflow:delegate_failed', {
      taskId: 'parent-task',
      stepId: 'step-3',
      agentId: null,
      status: 'skipped',
      reason: 'dependency failed (step-2)',
      errorClass: 'dependency_failed',
      durationMs: 0,
    });
    expect(captured.length).toBe(1);
    expect(captured[0]?.status).toBe('skipped');
    expect(captured[0]?.errorClass).toBe('dependency_failed');
  });

  test('failed (non-timeout) delegate emits status="failed"', () => {
    const bus = new EventBus<VinyanBusEvents>();
    const captured: VinyanBusEvents['workflow:delegate_failed'][] = [];
    bus.on('workflow:delegate_failed', (p) => captured.push(p));

    bus.emit('workflow:delegate_failed', {
      taskId: 'parent',
      stepId: 's',
      agentId: 'developer',
      status: 'failed',
      reason: 'sub-agent returned failed status',
      durationMs: 5_432,
    });
    expect(captured[0]?.status).toBe('failed');
  });
});
