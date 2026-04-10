/**
 * Tests for CommandApprovalGate — interactive shell command approval.
 */
import { describe, expect, test } from 'bun:test';
import { createBus } from '../../../src/core/bus.ts';
import { CommandApprovalGate } from '../../../src/orchestrator/tools/command-approval-gate.ts';

describe('CommandApprovalGate', () => {
  test('emits event and resolves on approval', async () => {
    const bus = createBus();
    const gate = new CommandApprovalGate(bus);
    const events: string[] = [];

    bus.on('tool:approval_required', ({ requestId, command }) => {
      events.push(command);
      // Simulate user approving
      gate.resolve(requestId, 'approved');
    });

    const decision = await gate.requestApproval('google-chrome', 'not in allowlist');
    expect(decision).toBe('approved');
    expect(events).toEqual(['google-chrome']);
  });

  test('emits event and resolves on rejection', async () => {
    const bus = createBus();
    const gate = new CommandApprovalGate(bus);

    bus.on('tool:approval_required', ({ requestId }) => {
      gate.resolve(requestId, 'rejected');
    });

    const decision = await gate.requestApproval('google-chrome', 'not in allowlist');
    expect(decision).toBe('rejected');
  });

  test('auto-rejects after timeout', async () => {
    const bus = createBus();
    const gate = new CommandApprovalGate(bus, 50); // 50ms timeout

    const decision = await gate.requestApproval('some-cmd', 'not in allowlist');
    expect(decision).toBe('rejected');
  });

  test('clear() auto-rejects all pending', async () => {
    const bus = createBus();
    const gate = new CommandApprovalGate(bus, 60_000);

    const promise = gate.requestApproval('cmd', 'reason');
    gate.clear();

    const decision = await promise;
    expect(decision).toBe('rejected');
  });

  test('resolve returns false for unknown requestId', () => {
    const bus = createBus();
    const gate = new CommandApprovalGate(bus);

    expect(gate.resolve('nonexistent', 'approved')).toBe(false);
  });
});
