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
});
