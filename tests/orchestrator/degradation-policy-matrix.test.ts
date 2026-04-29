/**
 * A9 / T3 — fault injection coverage for the explicit policy matrix and new
 * failure-class bridges (economy accounting, session persistence, write/destructive
 * mutation apply).
 */

import { describe, expect, test } from 'bun:test';
import { createBus } from '../../src/core/bus.ts';
import {
  attachDegradationEventBridge,
  DEGRADATION_POLICY_MATRIX,
  DEGRADATION_POLICY_VERSION,
  decideDegradation,
} from '../../src/orchestrator/degradation-strategy.ts';
import type { DegradationEvent } from '../../src/orchestrator/degradation-strategy.ts';

describe('A9 policy matrix — explicit fail-open / fail-closed contract', () => {
  test('every failure type has a matrix entry with a rationale', () => {
    const expectedTypes: DegradationEvent['failureType'][] = [
      'oracle-unavailable',
      'llm-provider-failure',
      'tool-timeout',
      'tool-failure',
      'rate-limit',
      'peer-unavailable',
      'trace-store-write-failure',
      'budget-pressure',
      'economy-accounting-failure',
      'session-persistence-failure',
      'mutation-apply-failure',
    ];
    for (const ft of expectedTypes) {
      const entry = DEGRADATION_POLICY_MATRIX[ft];
      expect(entry).toBeDefined();
      expect(entry.rationale.length).toBeGreaterThan(20);
    }
  });

  test('fail-closed entries are marked critical, blocked, non-retryable', () => {
    const failClosedTypes: DegradationEvent['failureType'][] = [
      'trace-store-write-failure',
      'mutation-apply-failure',
    ];
    for (const ft of failClosedTypes) {
      const e = DEGRADATION_POLICY_MATRIX[ft];
      expect(e.action).toBe('fail-closed');
      expect(e.capabilityImpact).toBe('blocked');
      expect(e.retryable).toBe(false);
      expect(e.severity).toBe('critical');
    }
  });

  test('advisory subsystems fail open with reduced capability and warning severity', () => {
    const failOpenTypes: DegradationEvent['failureType'][] = [
      'oracle-unavailable',
      'llm-provider-failure',
      'tool-timeout',
      'tool-failure',
      'rate-limit',
      'peer-unavailable',
      'budget-pressure',
      'economy-accounting-failure',
      'session-persistence-failure',
    ];
    for (const ft of failOpenTypes) {
      const e = DEGRADATION_POLICY_MATRIX[ft];
      expect(e.action).not.toBe('fail-closed');
      expect(e.capabilityImpact).toBe('reduced');
      expect(e.severity).toBe('warning');
    }
  });
});

describe('A9 fault injection — economy accounting failure', () => {
  test('bus event normalizes to economy-accounting-failure (degrade open)', () => {
    const bus = createBus();
    const events: DegradationEvent[] = [];
    const bridge = attachDegradationEventBridge(bus);
    bus.on('degradation:triggered', (e) => events.push(e));

    bus.emit('economy:accounting_failed', { taskId: 'task-eco', reason: 'sqlite locked' });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      taskId: 'task-eco',
      failureType: 'economy-accounting-failure',
      component: 'economy-ledger',
      action: 'degrade',
      sourceEvent: 'economy:accounting_failed',
      policyVersion: DEGRADATION_POLICY_VERSION,
    });
    bridge.detach();
  });
});

describe('A9 fault injection — session persistence failure', () => {
  test('bus event normalizes to session-persistence-failure (degrade open)', () => {
    const bus = createBus();
    const events: DegradationEvent[] = [];
    const bridge = attachDegradationEventBridge(bus);
    bus.on('degradation:triggered', (e) => events.push(e));

    bus.emit('session:persistence_failed', { sessionId: 'sess-9', reason: 'disk i/o error' });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      failureType: 'session-persistence-failure',
      component: 'session:sess-9',
      action: 'degrade',
      sourceEvent: 'session:persistence_failed',
    });
    bridge.detach();
  });

  test('falls back to generic component when sessionId absent', () => {
    const bus = createBus();
    const events: DegradationEvent[] = [];
    const bridge = attachDegradationEventBridge(bus);
    bus.on('degradation:triggered', (e) => events.push(e));

    bus.emit('session:persistence_failed', { reason: 'no session context' });
    expect(events[0]?.component).toBe('session-store');
    bridge.detach();
  });
});

describe('A9 fault injection — write/destructive mutation apply failure', () => {
  test('write mutation failure normalizes fail-closed', () => {
    const bus = createBus();
    const events: DegradationEvent[] = [];
    const bridge = attachDegradationEventBridge(bus);
    bus.on('degradation:triggered', (e) => events.push(e));

    bus.emit('tool:mutation_failed', {
      taskId: 'task-mut',
      toolName: 'replace_string_in_file',
      category: 'write',
      reason: 'file checksum mismatch — workspace changed mid-flight',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      taskId: 'task-mut',
      failureType: 'mutation-apply-failure',
      component: 'tool:replace_string_in_file',
      action: 'fail-closed',
      capabilityImpact: 'blocked',
      severity: 'critical',
      sourceEvent: 'tool:mutation_failed',
    });
    expect(events[0]?.reason).toContain('write');
    bridge.detach();
  });

  test('destructive mutation failure normalizes fail-closed', () => {
    const bus = createBus();
    const events: DegradationEvent[] = [];
    const bridge = attachDegradationEventBridge(bus);
    bus.on('degradation:triggered', (e) => events.push(e));

    bus.emit('tool:mutation_failed', {
      taskId: 'task-rm',
      toolName: 'shell_exec',
      category: 'destructive',
      reason: 'partial rm -rf observed',
    });

    expect(events[0]?.action).toBe('fail-closed');
    expect(events[0]?.reason).toContain('destructive');
    bridge.detach();
  });

  test('decideDegradation directly returns fail-closed for mutation-apply-failure', () => {
    const decision = decideDegradation({
      failureType: 'mutation-apply-failure',
      component: 'tool:write_file',
      reason: 'write boundary aborted',
      sourceEvent: 'tool:mutation_failed',
    });
    expect(decision.action).toBe('fail-closed');
    expect(decision.retryable).toBe(false);
  });

  // T3.b: core-loop commit boundary attributes rejected artifact mutations
  // to the synthetic `artifact-commit` tool name (since WorkerResult mutations
  // carry no per-tool provenance). This event must still normalize to
  // mutation-apply-failure / fail-closed.
  test('artifact-commit boundary failure normalizes fail-closed (T3.b)', () => {
    const bus = createBus();
    const events: DegradationEvent[] = [];
    const bridge = attachDegradationEventBridge(bus);
    bus.on('degradation:triggered', (e) => events.push(e));

    bus.emit('tool:mutation_failed', {
      taskId: 'task-commit',
      toolName: 'artifact-commit',
      category: 'write',
      reason: "../escape.ts: Path '../escape.ts' contains '..' traversal",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      taskId: 'task-commit',
      failureType: 'mutation-apply-failure',
      component: 'tool:artifact-commit',
      action: 'fail-closed',
      capabilityImpact: 'blocked',
      severity: 'critical',
    });
    bridge.detach();
  });
});

describe('A9 fault injection — non-governance trace persistence (legacy fail-open)', () => {
  test('arbitrary advisory failure does not block (capability=reduced, retryable=true)', () => {
    const decision = decideDegradation({
      failureType: 'oracle-unavailable',
      component: 'oracle:lint',
      reason: 'circuit open',
      sourceEvent: 'circuit:open',
    });
    expect(decision.capabilityImpact).toBe('reduced');
    expect(decision.retryable).toBe(true);
    expect(decision.action).not.toBe('fail-closed');
  });
});
