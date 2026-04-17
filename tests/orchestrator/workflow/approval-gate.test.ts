/**
 * Tests for the workflow approval gate (Phase E).
 */
import { describe, expect, test } from 'bun:test';
import { createBus } from '../../../src/core/bus.ts';
import {
  approvalTimeoutMs,
  AUTO_APPROVAL_LENGTH_THRESHOLD,
  awaitApprovalDecision,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  requiresApproval,
} from '../../../src/orchestrator/workflow/approval-gate.ts';

describe('requiresApproval', () => {
  test('returns false when config is missing (default auto) and goal is short', () => {
    expect(requiresApproval(undefined, 'fix bug')).toBe(false);
  });

  test('returns true when config is missing and goal is long-form (auto default)', () => {
    const long = 'a'.repeat(AUTO_APPROVAL_LENGTH_THRESHOLD + 1);
    expect(requiresApproval(undefined, long)).toBe(true);
  });

  test('returns true when requireUserApproval is explicitly true', () => {
    expect(requiresApproval({ requireUserApproval: true, approvalTimeoutMs: 1000 }, 'hi')).toBe(true);
  });

  test('returns false when requireUserApproval is explicitly false', () => {
    const long = 'a'.repeat(AUTO_APPROVAL_LENGTH_THRESHOLD + 10);
    expect(requiresApproval({ requireUserApproval: false, approvalTimeoutMs: 1000 }, long)).toBe(false);
  });

  test('auto mode uses length threshold (boundary = threshold counts as long-form)', () => {
    const justAtThreshold = 'a'.repeat(AUTO_APPROVAL_LENGTH_THRESHOLD);
    const justBelow = 'a'.repeat(AUTO_APPROVAL_LENGTH_THRESHOLD - 1);
    expect(requiresApproval({ requireUserApproval: 'auto', approvalTimeoutMs: 1000 }, justAtThreshold)).toBe(true);
    expect(requiresApproval({ requireUserApproval: 'auto', approvalTimeoutMs: 1000 }, justBelow)).toBe(false);
  });
});

describe('approvalTimeoutMs', () => {
  test('returns the config value when present', () => {
    expect(approvalTimeoutMs({ requireUserApproval: 'auto', approvalTimeoutMs: 5_000 })).toBe(5_000);
  });

  test('falls back to DEFAULT_APPROVAL_TIMEOUT_MS when config is missing', () => {
    expect(approvalTimeoutMs(undefined)).toBe(DEFAULT_APPROVAL_TIMEOUT_MS);
  });
});

describe('awaitApprovalDecision', () => {
  test('resolves with "approved" when plan_approved arrives for the matching taskId', async () => {
    const bus = createBus();
    const promise = awaitApprovalDecision(bus, 'task-1', 30_000);
    bus.emit('workflow:plan_approved', { taskId: 'task-1' });
    await expect(promise).resolves.toBe('approved');
  });

  test('resolves with "rejected" when plan_rejected arrives for the matching taskId', async () => {
    const bus = createBus();
    const promise = awaitApprovalDecision(bus, 'task-1', 30_000);
    bus.emit('workflow:plan_rejected', { taskId: 'task-1', reason: 'nope' });
    await expect(promise).resolves.toBe('rejected');
  });

  test('ignores events for a different taskId', async () => {
    const bus = createBus();
    const promise = awaitApprovalDecision(bus, 'task-1', 100);
    bus.emit('workflow:plan_approved', { taskId: 'task-other' });
    await expect(promise).resolves.toBe('timeout');
  });

  test('resolves with "timeout" when nothing arrives', async () => {
    const bus = createBus();
    await expect(awaitApprovalDecision(bus, 'task-1', 50)).resolves.toBe('timeout');
  });

  test('subsequent events after settlement are no-ops', async () => {
    const bus = createBus();
    const promise = awaitApprovalDecision(bus, 'task-1', 30_000);
    bus.emit('workflow:plan_approved', { taskId: 'task-1' });
    const decision = await promise;
    // Second emit after settlement — should not throw and should not flip state
    bus.emit('workflow:plan_rejected', { taskId: 'task-1' });
    expect(decision).toBe('approved');
  });
});
