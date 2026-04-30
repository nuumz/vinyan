import { describe, expect, test } from 'bun:test';
import { CodingCliApprovalBridge } from '../../../src/orchestrator/external-coding-cli/external-coding-cli-approval-bridge.ts';
import { ApprovalGate } from '../../../src/orchestrator/approval-gate.ts';
import { createBus } from '../../../src/core/bus.ts';
import type {
  ApprovalPolicy,
  CodingCliApprovalRequest,
} from '../../../src/orchestrator/external-coding-cli/types.ts';

const STRICT_POLICY: ApprovalPolicy = {
  autoApproveReadOnly: false,
  requireHumanForWrites: true,
  requireHumanForShell: true,
  requireHumanForGit: true,
  allowDangerousSkipPermissions: false,
};

const PERMISSIVE_READ_ONLY_POLICY: ApprovalPolicy = {
  ...STRICT_POLICY,
  autoApproveReadOnly: true,
};

function makeRequest(scope: CodingCliApprovalRequest['scope'], detail: string): CodingCliApprovalRequest {
  return {
    requestId: `req-${Date.now()}`,
    scope,
    summary: 'test',
    detail,
    providerData: {},
  };
}

const CTX = {
  taskId: 't1',
  codingCliSessionId: 'sess-1',
  providerId: 'claude-code' as const,
  state: 'running' as const,
};

describe('CodingCliApprovalBridge.evaluate (policy)', () => {
  test('git mutation always requires human', () => {
    const bridge = new CodingCliApprovalBridge({
      bus: createBus(),
      approvalGate: new ApprovalGate(createBus()),
      policy: PERMISSIVE_READ_ONLY_POLICY,
    });
    const verdict = bridge.evaluate(makeRequest('shell', 'git commit -am "x"'));
    expect(verdict.decision).toBe('require-human');
  });

  test('shell read-only auto-approves when allowed', () => {
    const bridge = new CodingCliApprovalBridge({
      bus: createBus(),
      approvalGate: new ApprovalGate(createBus()),
      policy: PERMISSIVE_READ_ONLY_POLICY,
    });
    const verdict = bridge.evaluate(makeRequest('shell', 'ls -la'));
    expect(verdict.decision).toBe('auto-approve');
  });

  test('shell read-only requires human when autoApproveReadOnly disabled', () => {
    const bridge = new CodingCliApprovalBridge({
      bus: createBus(),
      approvalGate: new ApprovalGate(createBus()),
      policy: STRICT_POLICY,
    });
    const verdict = bridge.evaluate(makeRequest('shell', 'ls -la'));
    expect(verdict.decision).toBe('require-human');
  });

  test('write requires human when requireHumanForWrites=true', () => {
    const bridge = new CodingCliApprovalBridge({
      bus: createBus(),
      approvalGate: new ApprovalGate(createBus()),
      policy: STRICT_POLICY,
    });
    const verdict = bridge.evaluate(makeRequest('edit', 'src/foo.ts'));
    expect(verdict.decision).toBe('require-human');
  });

  test('unknown scope defaults to require-human (default-deny)', () => {
    const bridge = new CodingCliApprovalBridge({
      bus: createBus(),
      approvalGate: new ApprovalGate(createBus()),
      policy: STRICT_POLICY,
    });
    const verdict = bridge.evaluate(makeRequest('unknown', 'do something'));
    expect(verdict.decision).toBe('require-human');
  });

  test('allowDangerousSkipPermissions overrides everything', () => {
    const bridge = new CodingCliApprovalBridge({
      bus: createBus(),
      approvalGate: new ApprovalGate(createBus()),
      policy: { ...STRICT_POLICY, allowDangerousSkipPermissions: true },
    });
    const verdict = bridge.evaluate(makeRequest('shell', 'rm -rf /tmp/x'));
    expect(verdict.decision).toBe('auto-approve');
  });

  test('compound shell command does not count as read-only', () => {
    const bridge = new CodingCliApprovalBridge({
      bus: createBus(),
      approvalGate: new ApprovalGate(createBus()),
      policy: PERMISSIVE_READ_ONLY_POLICY,
    });
    const verdict = bridge.evaluate(makeRequest('shell', 'ls && rm -rf /'));
    expect(verdict.decision).toBe('require-human');
  });
});

describe('CodingCliApprovalBridge.request (end-to-end)', () => {
  test('auto-approve emits both required and resolved events', async () => {
    const bus = createBus();
    const required: unknown[] = [];
    const resolved: unknown[] = [];
    bus.on('coding-cli:approval_required', (p) => required.push(p));
    bus.on('coding-cli:approval_resolved', (p) => resolved.push(p));
    const bridge = new CodingCliApprovalBridge({
      bus,
      approvalGate: new ApprovalGate(bus),
      policy: PERMISSIVE_READ_ONLY_POLICY,
    });
    const result = await bridge.request(CTX, makeRequest('shell', 'ls'));
    expect(result.decision).toBe('approved');
    expect(result.decidedBy).toBe('policy');
    expect(required).toHaveLength(1);
    expect(resolved).toHaveLength(1);
  });

  test('require-human path resolves when external resolver answers', async () => {
    const bus = createBus();
    const gate = new ApprovalGate(bus, 30_000);
    const bridge = new CodingCliApprovalBridge({
      bus,
      approvalGate: gate,
      policy: STRICT_POLICY,
      humanTimeoutMs: 30_000,
    });
    const promise = bridge.request(CTX, makeRequest('edit', 'src/foo.ts'));
    // Wait one tick so the gate can register the pending approval.
    await new Promise((r) => setTimeout(r, 5));
    expect(gate.getPendingIds().length).toBe(1);
    bridge.resolveExternal(CTX.taskId, 'req-fixed', 'approved');
    // The above won't match because requestId is different; resolve via the
    // gate's full key. Use bridge's listPending to grab the request id.
    const pending = bridge.listPending();
    expect(pending.length).toBe(1);
    bridge.resolveExternal(CTX.taskId, pending[0]!.request.requestId, 'approved');
    const result = await promise;
    expect(result.decision).toBe('approved');
    expect(result.decidedBy).toBe('human');
  });
});
