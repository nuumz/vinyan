import { describe, expect, test } from 'bun:test';
import { createBus } from '../../src/core/bus.ts';
import { ApprovalGate } from '../../src/orchestrator/approval-gate.ts';

describe('ApprovalGate', () => {
  test('requestApproval emits bus event', () => {
    const bus = createBus();
    const gate = new ApprovalGate(bus, 5000);
    let emitted = false;

    bus.on('task:approval_required', (payload) => {
      emitted = true;
      expect(payload.taskId).toBe('task-1');
      expect(payload.riskScore).toBe(0.85);
      expect(payload.reason).toBe('high risk');
    });

    // Start the request (don't await — it blocks until resolved)
    const promise = gate.requestApproval('task-1', 0.85, 'high risk');
    expect(emitted).toBe(true);

    // Resolve it
    gate.resolve('task-1', 'approved');
    return promise.then((decision) => {
      expect(decision).toBe('approved');
    });
  });

  test('resolve returns false for unknown taskId', () => {
    const bus = createBus();
    const gate = new ApprovalGate(bus, 5000);
    expect(gate.resolve('nonexistent', 'approved')).toBe(false);
  });

  test('resolve returns true for pending taskId', async () => {
    const bus = createBus();
    const gate = new ApprovalGate(bus, 5000);

    const promise = gate.requestApproval('task-1', 0.5, 'test');
    expect(gate.hasPending('task-1')).toBe(true);
    expect(gate.getPendingIds()).toEqual(['task-1']);

    const resolved = gate.resolve('task-1', 'rejected');
    expect(resolved).toBe(true);
    expect(gate.hasPending('task-1')).toBe(false);

    const decision = await promise;
    expect(decision).toBe('rejected');
  });

  test('auto-rejects after timeout', async () => {
    const bus = createBus();
    const gate = new ApprovalGate(bus, 100); // 100ms timeout

    const decision = await gate.requestApproval('task-1', 0.9, 'timeout test');
    expect(decision).toBe('rejected');
    expect(gate.hasPending('task-1')).toBe(false);
  });

  test('clear rejects all pending', async () => {
    const bus = createBus();
    const gate = new ApprovalGate(bus, 60_000);

    const p1 = gate.requestApproval('task-1', 0.5, 'test 1');
    const p2 = gate.requestApproval('task-2', 0.6, 'test 2');

    expect(gate.getPendingIds()).toHaveLength(2);

    gate.clear();

    expect(gate.getPendingIds()).toHaveLength(0);

    const [d1, d2] = await Promise.all([p1, p2]);
    expect(d1).toBe('rejected');
    expect(d2).toBe('rejected');
  });

  test('multiple resolves are safe (idempotent)', async () => {
    const bus = createBus();
    const gate = new ApprovalGate(bus, 5000);

    const promise = gate.requestApproval('task-1', 0.5, 'test');

    gate.resolve('task-1', 'approved');
    const secondResolve = gate.resolve('task-1', 'rejected'); // already resolved
    expect(secondResolve).toBe(false);

    const decision = await promise;
    expect(decision).toBe('approved'); // first resolve wins
  });

  test('resolve emits task:approval_resolved with source=human', async () => {
    const bus = createBus();
    const gate = new ApprovalGate(bus, 5000);
    const events: Array<{ taskId: string; decision: string; source: string }> = [];
    bus.on('task:approval_resolved', (p) => events.push(p));

    const promise = gate.requestApproval('task-1', 0.5, 'test');
    gate.resolve('task-1', 'approved');
    await promise;

    expect(events).toEqual([{ taskId: 'task-1', decision: 'approved', source: 'human' }]);
  });

  test('timeout emits task:approval_resolved with source=timeout', async () => {
    const bus = createBus();
    const gate = new ApprovalGate(bus, 50); // tight timeout
    const events: Array<{ taskId: string; decision: string; source: string }> = [];
    bus.on('task:approval_resolved', (p) => events.push(p));

    const decision = await gate.requestApproval('task-1', 0.9, 'timeout test');
    expect(decision).toBe('rejected');
    expect(events).toEqual([{ taskId: 'task-1', decision: 'rejected', source: 'timeout' }]);
  });

  test('clear emits task:approval_resolved with source=shutdown for each pending', async () => {
    const bus = createBus();
    const gate = new ApprovalGate(bus, 60_000);
    const events: Array<{ taskId: string; decision: string; source: string }> = [];
    bus.on('task:approval_resolved', (p) => events.push(p));

    const p1 = gate.requestApproval('task-A', 0.5, 'a');
    const p2 = gate.requestApproval('task-B', 0.5, 'b');
    gate.clear();
    await Promise.all([p1, p2]);

    expect(events.length).toBe(2);
    expect(events.every((e) => e.source === 'shutdown' && e.decision === 'rejected')).toBe(true);
    expect(new Set(events.map((e) => e.taskId))).toEqual(new Set(['task-A', 'task-B']));
  });
});

describe('ApprovalGate — idempotency on duplicate slot', () => {
  test('duplicate request for same taskId/default key emits task:approval_required exactly once', async () => {
    const bus = createBus();
    const gate = new ApprovalGate(bus, 60_000);
    const requiredEvents: Array<{ taskId: string; riskScore: number; reason: string }> = [];
    bus.on('task:approval_required', (p) => requiredEvents.push(p));
    const dupEvents: Array<{ taskId: string; approvalKey: string; existingRequestedAt: number; ledgerDuplicate: boolean }> = [];
    bus.on('approval:duplicate_request_ignored', (p) => dupEvents.push(p));

    const p1 = gate.requestApproval('task-1', 0.5, 'first');
    const p2 = gate.requestApproval('task-1', 0.99, 'second');

    expect(requiredEvents.length).toBe(1);
    expect(requiredEvents[0]?.reason).toBe('first');
    expect(dupEvents.length).toBe(1);
    expect(dupEvents[0]?.ledgerDuplicate).toBe(false);
    expect(dupEvents[0]?.existingRequestedAt).toBeGreaterThan(0);

    gate.resolve('task-1', 'approved');
    const [d1, d2] = await Promise.all([p1, p2]);
    expect(d1).toBe('approved');
    expect(d2).toBe('approved');
  });

  test('duplicate request preserves the original requestedAt — no timer reset', async () => {
    const bus = createBus();
    const gate = new ApprovalGate(bus, 60_000);
    const p1 = gate.requestApproval('task-x', 0.5, 'orig');
    const firstRequestedAt = gate.getPending()[0]?.requestedAt;
    expect(firstRequestedAt).toBeGreaterThan(0);

    // Wait long enough that Date.now() advances, then duplicate-request.
    await new Promise((r) => setTimeout(r, 5));
    const p2 = gate.requestApproval('task-x', 0.99, 'duplicate');
    const afterDup = gate.getPending();
    expect(afterDup.length).toBe(1);
    expect(afterDup[0]?.requestedAt).toBe(firstRequestedAt!);
    // Reason / riskScore / approvalKey not overwritten by duplicate request.
    expect(afterDup[0]?.reason).toBe('orig');
    expect(afterDup[0]?.riskScore).toBe(0.5);

    gate.resolve('task-x', 'rejected');
    await Promise.all([p1, p2]);
  });

  test('duplicate waiters all receive rejected on timeout', async () => {
    const bus = createBus();
    const gate = new ApprovalGate(bus, 50);
    const requiredEvents: Array<unknown> = [];
    bus.on('task:approval_required', (p) => requiredEvents.push(p));
    const resolvedEvents: Array<{ taskId: string; decision: string; source: string }> = [];
    bus.on('task:approval_resolved', (p) => resolvedEvents.push(p));

    const promises = [
      gate.requestApproval('task-t', 0.5, 'r1'),
      gate.requestApproval('task-t', 0.5, 'r2'),
      gate.requestApproval('task-t', 0.5, 'r3'),
    ];
    expect(requiredEvents.length).toBe(1);

    const decisions = await Promise.all(promises);
    expect(decisions).toEqual(['rejected', 'rejected', 'rejected']);
    // Single timeout event — not three.
    expect(resolvedEvents.length).toBe(1);
    expect(resolvedEvents[0]).toEqual({ taskId: 'task-t', decision: 'rejected', source: 'timeout' });
  });

  test('clear settles all duplicate waiters as rejected', async () => {
    const bus = createBus();
    const gate = new ApprovalGate(bus, 60_000);
    const promises = [
      gate.requestApproval('task-c', 0.5, 'a'),
      gate.requestApproval('task-c', 0.5, 'b'),
    ];
    expect(gate.getPending().length).toBe(1);

    gate.clear();
    const decisions = await Promise.all(promises);
    expect(decisions).toEqual(['rejected', 'rejected']);
    expect(gate.getPending().length).toBe(0);
  });

  test('distinct approvalKey for same taskId opens a separate slot', async () => {
    const bus = createBus();
    const gate = new ApprovalGate(bus, 60_000);
    const requiredEvents: Array<{ taskId: string }> = [];
    bus.on('task:approval_required', (p) => requiredEvents.push(p));

    const pDefault = gate.requestApproval('task-k', 0.5, 'default reason');
    const pSpec = gate.requestApproval('task-k', 0.5, 'spec reason', { approvalKey: 'spec' });

    // Two distinct slots — two events fire.
    expect(requiredEvents.length).toBe(2);
    expect(gate.getPending().length).toBe(2);
    const keys = gate.getPending().map((p) => p.approvalKey).sort();
    expect(keys).toEqual(['default', 'spec']);

    // Resolving the default slot does NOT settle the spec slot.
    gate.resolve('task-k', 'approved');
    expect(await pDefault).toBe('approved');
    expect(gate.hasPending('task-k')).toBe(true);

    gate.resolve('task-k', 'rejected', undefined, 'spec');
    expect(await pSpec).toBe('rejected');
    expect(gate.hasPending('task-k')).toBe(false);
  });

  test('resolve(default) does not settle a spec-keyed slot — distinct slots stay isolated', async () => {
    const bus = createBus();
    const gate = new ApprovalGate(bus, 60_000);
    const pSpec = gate.requestApproval('task-iso', 0.5, 'spec', { approvalKey: 'spec' });

    // No default slot exists — resolving by default key returns false.
    expect(gate.resolve('task-iso', 'approved')).toBe(false);
    // The spec slot is still pending.
    expect(gate.hasPending('task-iso')).toBe(true);

    gate.resolve('task-iso', 'approved', undefined, 'spec');
    expect(await pSpec).toBe('approved');
  });
});
