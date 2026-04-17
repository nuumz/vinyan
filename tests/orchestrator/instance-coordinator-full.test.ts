/**
 * Instance Coordinator Full Tests — PH5.8.
 *
 * Tests all 5 deferred features:
 *   A1: Cross-instance conflict resolution
 *   A2: Event forwarder
 *   A3: WorkerProfile sharing
 *   A4: Fleet coordinator routing
 *   A5: Sandbox manager lifecycle
 *   I17: Full enforcement in oracle runner
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createBus, type VinyanBus } from '../../src/core/bus.ts';
import type { OracleVerdict } from '../../src/core/types.ts';
import type { WorkerStats } from '../../src/orchestrator/types.ts';
import {
  InstanceCoordinator,
  reduceWilsonLB,
  resolveRemoteConflict,
} from '../../src/orchestrator/instance-coordinator.ts';
import { EventForwarder } from '../../src/orchestrator/event-forwarder.ts';
import { FleetCoordinator } from '../../src/orchestrator/fleet/fleet-coordinator.ts';
import { SandboxManager } from '../../src/orchestrator/agent/sandbox.ts';

// ── Helpers ─────────────────────────────────────────────────────

function makeVerdict(overrides: Partial<OracleVerdict> = {}): OracleVerdict {
  return {
    verified: true,
    type: 'known',
    confidence: 0.9,
    evidence: [],
    fileHashes: {},
    durationMs: 100,
    origin: 'local',
    oracleName: 'type-oracle',
    ...overrides,
  };
}

function makeWorkerStats(overrides: Partial<WorkerStats> = {}): WorkerStats {
  return {
    totalTasks: 20,
    successRate: 0.85,
    avgQualityScore: 0.8,
    avgDurationMs: 5000,
    avgTokenCost: 1000,
    taskTypeBreakdown: {
      refactor: { count: 10, successRate: 0.9, avgQuality: 0.85, avgTokens: 1200 },
      fix: { count: 10, successRate: 0.8, avgQuality: 0.75, avgTokens: 800 },
    },
    lastActiveAt: Date.now(),
    ...overrides,
  };
}

// ── A1: Cross-instance conflict resolution ──────────────────────

describe('resolveRemoteConflict', () => {
  const context = {
    taskId: 'task-1',
    localOracleName: 'type-oracle',
    remoteOracleName: 'type-oracle',
  };

  test('Step 1: domain authority — local wins when higher tier and local origin', () => {
    const local = makeVerdict({
      confidence: 0.95,
      origin: 'local',
      oracleName: 'type-oracle',
    });
    const remote = makeVerdict({
      confidence: 0.6,
      origin: 'a2a',
      oracleName: 'dep-oracle',
    });

    const result = resolveRemoteConflict(local, remote, {
      ...context,
      remoteOracleName: 'dep-oracle',
    });

    expect(result.winner).toBe('local');
    expect(result.resolvedAtStep).toBe(1);
    expect(result.explanation).toContain('Domain authority');
  });

  test('Step 2: evidence tier — higher tier wins regardless of origin', () => {
    const local = makeVerdict({
      confidence: 0.5,
      origin: 'local',
      oracleName: 'unknown-oracle',
    });
    const remote = makeVerdict({
      confidence: 0.98,
      origin: 'a2a',
      oracleName: 'type-oracle',
    });

    const result = resolveRemoteConflict(local, remote, context);

    expect(result.winner).toBe('remote');
    expect(result.resolvedAtStep).toBe(2);
    expect(result.explanation).toContain('Evidence tier');
  });

  test('Step 3: recency — newer temporal_context wins', () => {
    const local = makeVerdict({
      confidence: 0.8,
      origin: 'local',
      oracleName: 'dep-oracle',
      temporalContext: { validFrom: 1000, validUntil: 2000, decayModel: 'linear' },
    });
    const remote = makeVerdict({
      confidence: 0.8,
      origin: 'a2a',
      oracleName: 'dep-oracle',
      temporalContext: { validFrom: 2000, validUntil: 3000, decayModel: 'linear' },
    });

    const result = resolveRemoteConflict(local, remote, context);

    expect(result.winner).toBe('remote');
    expect(result.resolvedAtStep).toBe(3);
    expect(result.explanation).toContain('Recency');
  });

  test('Step 4: SL fusion — low conflict K resolves via fused probability', () => {
    const local = makeVerdict({
      confidence: 0.7,
      origin: 'local',
      oracleName: 'dep-oracle',
    });
    const remote = makeVerdict({
      confidence: 0.6,
      origin: 'a2a',
      oracleName: 'dep-oracle',
    });

    const result = resolveRemoteConflict(local, remote, context);

    expect(result.resolvedAtStep).toBe(4);
    expect(result.conflictK).toBeDefined();
    expect(result.conflictK!).toBeLessThanOrEqual(0.5);
    expect(result.fusedProbability).toBeDefined();
  });

  test('Step 5: escalation — high conflict K emits oracle:contradiction', () => {
    const bus = createBus();
    const events: unknown[] = [];
    bus.on('oracle:contradiction', (payload) => events.push(payload));

    // K is computed from SL opinions: fromScalar(0.95) = {b:0.95, d:0.05}
    // fromScalar(0.05) = {b:0.05, d:0.95} — these are genuinely opposing opinions
    const local = makeVerdict({
      verified: true,
      confidence: 0.95,
      origin: 'local',
      oracleName: 'dep-oracle',
    });
    const remote = makeVerdict({
      verified: false,
      confidence: 0.05,
      origin: 'a2a',
      oracleName: 'dep-oracle',
    });

    const result = resolveRemoteConflict(local, remote, context, bus);

    expect(result.resolvedAtStep).toBe(5);
    expect(result.winner).toBe('local'); // Conservative: local wins (I12)
    expect(result.conflictK).toBeDefined();
    expect(result.conflictK!).toBeGreaterThan(0.5);
    expect(result.explanation).toContain('contradiction');
    expect(events.length).toBe(1);
  });

  test('same tier verdicts with no temporal context fall through to SL fusion', () => {
    const local = makeVerdict({
      confidence: 0.8,
      origin: 'local',
      oracleName: 'dep-oracle',
    });
    const remote = makeVerdict({
      confidence: 0.75,
      origin: 'a2a',
      oracleName: 'dep-oracle',
    });

    const result = resolveRemoteConflict(local, remote, context);

    expect(result.resolvedAtStep).toBe(4);
  });
});

describe('InstanceCoordinator.resolveRemoteConflict', () => {
  test('proxies to standalone function', () => {
    const coordinator = new InstanceCoordinator({
      peerUrls: [],
      instanceId: 'local-1',
    });

    const local = makeVerdict({ confidence: 0.95 });
    const remote = makeVerdict({ confidence: 0.4, origin: 'a2a' });

    const result = coordinator.resolveRemoteConflict(local, remote, {
      taskId: 'task-1',
      localOracleName: 'type-oracle',
      remoteOracleName: 'type-oracle',
    });

    expect(result.winner).toBeDefined();
    expect(result.resolvedAtStep).toBeGreaterThanOrEqual(1);
    expect(result.resolvedAtStep).toBeLessThanOrEqual(5);
  });
});

// ── A2: Event Forwarder ─────────────────────────────────────────

describe('EventForwarder', () => {
  let bus: VinyanBus;

  beforeEach(() => {
    bus = createBus();
  });

  test('subscribes to default events on start', () => {
    const forwarder = new EventForwarder({
      bus,
      instanceId: 'local-1',
      getPeers: () => [],
    });

    forwarder.start();

    expect(bus.listenerCount('sleep:cycleComplete')).toBe(1);
    expect(bus.listenerCount('evolution:rulePromoted')).toBe(1);
    expect(bus.listenerCount('skill:outcome')).toBe(1);

    forwarder.stop();
  });

  test('stop removes all subscriptions', () => {
    const forwarder = new EventForwarder({
      bus,
      instanceId: 'local-1',
      getPeers: () => [],
    });

    forwarder.start();
    forwarder.stop();

    expect(bus.listenerCount('sleep:cycleComplete')).toBe(0);
    expect(bus.listenerCount('evolution:rulePromoted')).toBe(0);
    expect(bus.listenerCount('skill:outcome')).toBe(0);
  });

  test('respects custom event list', () => {
    const forwarder = new EventForwarder({
      bus,
      instanceId: 'local-1',
      getPeers: () => [],
      forwardEvents: ['task:complete'],
    });

    forwarder.start();

    expect(bus.listenerCount('task:complete')).toBe(1);
    expect(bus.listenerCount('sleep:cycleComplete')).toBe(0);

    forwarder.stop();
  });

  test('getForwardedEvents returns configured events', () => {
    const forwarder = new EventForwarder({
      bus,
      instanceId: 'local-1',
      getPeers: () => [],
    });

    const events = forwarder.getForwardedEvents();
    expect(events).toEqual(['sleep:cycleComplete', 'evolution:rulePromoted', 'skill:outcome']);
  });

  test('emits instance:eventForwarded on forward attempt', async () => {
    const forwarded: unknown[] = [];
    bus.on('instance:eventForwarded', (payload) => forwarded.push(payload));

    const forwarder = new EventForwarder({
      bus,
      instanceId: 'local-1',
      getPeers: () => [{
        url: 'http://peer-1:3928',
        card: { name: 'peer', url: 'http://peer-1:3928', version: '1.0' } as any,
        ecpExtension: null,
        isVinyanPeer: true,
        discoveredAt: Date.now(),
      }],
      forwardTimeoutMs: 100,
    });

    forwarder.forward('test-event', { data: 'hello' });

    // Wait for async operations to settle
    await new Promise(resolve => setTimeout(resolve, 200));

    expect(forwarded.length).toBeGreaterThanOrEqual(1);
    expect((forwarded[0] as any).event).toBe('test-event');
    expect((forwarded[0] as any).peerId).toBe('http://peer-1:3928');
  });
});

// ── A3: WorkerProfile Sharing ───────────────────────────────────

describe('reduceWilsonLB', () => {
  test('reduces successRate by 50% by default', () => {
    const stats = makeWorkerStats({ successRate: 0.9 });
    const reduced = reduceWilsonLB(stats);

    expect(reduced.successRate).toBeCloseTo(0.45);
  });

  test('reduces avgQualityScore by factor', () => {
    const stats = makeWorkerStats({ avgQualityScore: 0.8 });
    const reduced = reduceWilsonLB(stats, 0.5);

    expect(reduced.avgQualityScore).toBeCloseTo(0.4);
  });

  test('reduces taskTypeBreakdown scores', () => {
    const stats = makeWorkerStats();
    const reduced = reduceWilsonLB(stats, 0.5);

    expect(reduced.taskTypeBreakdown['refactor']!.successRate).toBeCloseTo(0.45);
    expect(reduced.taskTypeBreakdown['refactor']!.avgQuality).toBeCloseTo(0.425);
  });

  test('preserves non-rate fields', () => {
    const stats = makeWorkerStats();
    const reduced = reduceWilsonLB(stats);

    expect(reduced.totalTasks).toBe(stats.totalTasks);
    expect(reduced.avgDurationMs).toBe(stats.avgDurationMs);
    expect(reduced.avgTokenCost).toBe(stats.avgTokenCost);
    expect(reduced.lastActiveAt).toBe(stats.lastActiveAt);
  });

  test('custom reduction factor', () => {
    const stats = makeWorkerStats({ successRate: 1.0 });
    const reduced = reduceWilsonLB(stats, 0.3);

    expect(reduced.successRate).toBeCloseTo(0.3);
  });
});

describe('InstanceCoordinator.shareWorkerProfiles', () => {
  test('returns empty when no workerStore configured', () => {
    const coordinator = new InstanceCoordinator({
      peerUrls: [],
      instanceId: 'local-1',
    });

    const shared = coordinator.shareWorkerProfiles();
    expect(shared).toEqual([]);
  });
});

describe('InstanceCoordinator.importWorkerProfiles', () => {
  test('returns 0 when no workerStore configured', () => {
    const coordinator = new InstanceCoordinator({
      peerUrls: [],
      instanceId: 'local-1',
    });

    const count = coordinator.importWorkerProfiles([], 'remote-1');
    expect(count).toBe(0);
  });
});

// ── A4: Fleet Coordinator ───────────────────────────────────────

describe('FleetCoordinator', () => {
  test('updatePeerCapacity stores capacity', () => {
    const fleet = new FleetCoordinator({ instanceId: 'local-1' });

    fleet.updatePeerCapacity('peer-1', 5, 10);
    const caps = fleet.getPeerCapacities();

    expect(caps.length).toBe(1);
    expect(caps[0]!.instanceId).toBe('peer-1');
    expect(caps[0]!.availableSlots).toBe(5);
    expect(caps[0]!.totalSlots).toBe(10);
  });

  test('updatePeerCapacity emits fleet:capacityUpdate', () => {
    const bus = createBus();
    const events: unknown[] = [];
    bus.on('fleet:capacityUpdate', (p) => events.push(p));

    const fleet = new FleetCoordinator({ instanceId: 'local-1', bus });
    fleet.updatePeerCapacity('peer-1', 5, 10);

    expect(events.length).toBe(1);
    expect((events[0] as any).instanceId).toBe('peer-1');
  });

  test('recordDelegationResult tracks success and failure', () => {
    const fleet = new FleetCoordinator({ instanceId: 'local-1' });

    fleet.recordDelegationResult('peer-1', 'refactor', true, 5000);
    fleet.recordDelegationResult('peer-1', 'refactor', true, 3000);
    fleet.recordDelegationResult('peer-1', 'refactor', false, 10000);

    const specs = fleet.getSpecializations('peer-1');
    expect(specs.length).toBe(1);
    expect(specs[0]!.successCount).toBe(2);
    expect(specs[0]!.failureCount).toBe(1);
  });

  test('recommendDelegation returns null when local has capacity', () => {
    const fleet = new FleetCoordinator({ instanceId: 'local-1' });
    fleet.updatePeerCapacity('peer-1', 5, 10);

    const result = fleet.recommendDelegation(
      { actionVerb: 'refactor', fileExtensions: ['.ts'], blastRadiusBucket: 'small' },
      { instanceId: 'local-1', availableSlots: 5, totalSlots: 10, lastUpdatedAt: Date.now() },
    );

    expect(result).toBeNull();
  });

  test('recommendDelegation returns peer when local is overloaded', () => {
    const fleet = new FleetCoordinator({ instanceId: 'local-1' });
    fleet.updatePeerCapacity('peer-1', 5, 10);

    const result = fleet.recommendDelegation(
      { actionVerb: 'refactor', fileExtensions: ['.ts'], blastRadiusBucket: 'small' },
      { instanceId: 'local-1', availableSlots: 0, totalSlots: 10, lastUpdatedAt: Date.now() },
    );

    expect(result).not.toBeNull();
    expect(result!.targetInstanceId).toBe('peer-1');
  });

  test('recommendDelegation prefers specialized peers', () => {
    const fleet = new FleetCoordinator({ instanceId: 'local-1' });

    fleet.updatePeerCapacity('peer-1', 5, 10);
    fleet.updatePeerCapacity('peer-2', 5, 10);

    // peer-2 specializes in refactoring
    for (let i = 0; i < 5; i++) {
      fleet.recordDelegationResult('peer-2', 'refactor', true, 3000);
    }

    const result = fleet.recommendDelegation(
      { actionVerb: 'refactor', fileExtensions: ['.ts'], blastRadiusBucket: 'small' },
      { instanceId: 'local-1', availableSlots: 0, totalSlots: 10, lastUpdatedAt: Date.now() },
    );

    expect(result).not.toBeNull();
    expect(result!.targetInstanceId).toBe('peer-2');
    expect(result!.score).toBeGreaterThan(0);
  });

  test('recommendDelegation filters stale capacity data', () => {
    const fleet = new FleetCoordinator({
      instanceId: 'local-1',
      capacityStalenessMs: 1000,
    });

    fleet.updatePeerCapacity('peer-1', 5, 10);
    const caps = fleet.getPeerCapacities();

    const result = fleet.recommendDelegation(
      { actionVerb: 'fix', fileExtensions: ['.ts'], blastRadiusBucket: 'small' },
      { instanceId: 'local-1', availableSlots: 0, totalSlots: 10, lastUpdatedAt: Date.now() },
      [{ ...caps[0]!, lastUpdatedAt: Date.now() - 5000 }],
    );

    expect(result).toBeNull();
  });

  test('recommendDelegation returns null when no peers available', () => {
    const fleet = new FleetCoordinator({ instanceId: 'local-1' });

    const result = fleet.recommendDelegation(
      { actionVerb: 'fix', fileExtensions: ['.ts'], blastRadiusBucket: 'small' },
      { instanceId: 'local-1', availableSlots: 0, totalSlots: 10, lastUpdatedAt: Date.now() },
    );

    expect(result).toBeNull();
  });

  test('recommendDelegation emits fleet:taskRouted', () => {
    const bus = createBus();
    const events: unknown[] = [];
    bus.on('fleet:taskRouted', (p) => events.push(p));

    const fleet = new FleetCoordinator({ instanceId: 'local-1', bus });
    fleet.updatePeerCapacity('peer-1', 8, 10);

    fleet.recommendDelegation(
      { actionVerb: 'fix', fileExtensions: ['.ts'], blastRadiusBucket: 'small' },
      { instanceId: 'local-1', availableSlots: 0, totalSlots: 10, lastUpdatedAt: Date.now() },
    );

    expect(events.length).toBe(1);
    expect((events[0] as any).targetPeerId).toBe('peer-1');
  });
});

// ── A5: Sandbox Manager ─────────────────────────────────────────

describe('SandboxManager', () => {
  test('execute builds correct docker arguments', async () => {
    let capturedArgs: string[] = [];
    const mockProc = {
      exited: Promise.resolve(0),
      stdout: new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('ok')); controller.close(); },
      }),
      stderr: new ReadableStream({
        start(controller) { controller.close(); },
      }),
      pid: 12345,
      kill: () => {},
    };

    const spawnFn = ((args: string[]) => {
      capturedArgs = args;
      return mockProc;
    }) as any;

    const sandbox = new SandboxManager({
      workspacePath: '/tmp/workspace',
      spawnFn,
    });

    await sandbox.execute('task-1', ['bun', 'run', 'test']);

    expect(capturedArgs).toContain('docker');
    expect(capturedArgs).toContain('run');
    expect(capturedArgs).toContain('--rm');
    expect(capturedArgs).toContain('--cap-drop');
    expect(capturedArgs).toContain('ALL');
    expect(capturedArgs).toContain('--network');
    expect(capturedArgs).toContain('none');
    expect(capturedArgs).toContain('--user');
    expect(capturedArgs).toContain('1000:1000');
    expect(capturedArgs).toContain('--security-opt');
    expect(capturedArgs).toContain('no-new-privileges');
    expect(capturedArgs).toContain('bun');
    expect(capturedArgs).toContain('test');
  });

  test('execute returns stdout and exit code on success', async () => {
    const mockProc = {
      exited: Promise.resolve(0),
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('test output'));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) { controller.close(); },
      }),
      pid: 12345,
      kill: () => {},
    };

    const sandbox = new SandboxManager({
      workspacePath: '/tmp/workspace',
      spawnFn: (() => mockProc) as any,
    });

    const result = await sandbox.execute('task-1', ['echo', 'hello']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('test output');
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('execute handles timeout', async () => {
    const mockProc = {
      exited: new Promise<number>(() => {}), // Never resolves
      stdout: new ReadableStream({ start(c) { c.close(); } }),
      stderr: new ReadableStream({ start(c) { c.close(); } }),
      pid: 12345,
      kill: () => {},
    };

    const spawnFn = ((args: string[]) => {
      if (args[0] === 'docker' && args[1] === 'kill') {
        return {
          exited: Promise.resolve(0),
          stdout: new ReadableStream({ start(c) { c.close(); } }),
          stderr: new ReadableStream({ start(c) { c.close(); } }),
          pid: 99,
          kill: () => {},
        };
      }
      return mockProc;
    }) as any;

    const sandbox = new SandboxManager({
      workspacePath: '/tmp/workspace',
      timeoutMs: 50,
      spawnFn,
    });

    const result = await sandbox.execute('task-timeout', ['sleep', '999']);

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('timed out');
  });

  test('execute emits sandbox lifecycle events', async () => {
    const bus = createBus();
    const created: unknown[] = [];
    const completed: unknown[] = [];
    bus.on('sandbox:created', (p) => created.push(p));
    bus.on('sandbox:completed', (p) => completed.push(p));

    const mockProc = {
      exited: Promise.resolve(0),
      stdout: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('')); c.close(); } }),
      stderr: new ReadableStream({ start(c) { c.close(); } }),
      pid: 12345,
      kill: () => {},
    };

    const sandbox = new SandboxManager({
      workspacePath: '/tmp/workspace',
      bus,
      spawnFn: (() => mockProc) as any,
    });

    await sandbox.execute('task-events', ['echo']);

    expect(created.length).toBe(1);
    expect((created[0] as any).taskId).toBe('task-events');
    expect(completed.length).toBe(1);
    expect((completed[0] as any).taskId).toBe('task-events');
    expect((completed[0] as any).exitCode).toBe(0);
  });

  test('execute handles spawn errors', async () => {
    const bus = createBus();
    const errors: unknown[] = [];
    bus.on('sandbox:error', (p) => errors.push(p));

    const spawnFn = (() => {
      throw new Error('Docker not found');
    }) as any;

    const sandbox = new SandboxManager({
      workspacePath: '/tmp/workspace',
      bus,
      spawnFn,
    });

    const result = await sandbox.execute('task-error', ['echo']);

    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('Docker not found');
    expect(errors.length).toBe(1);
  });

  test('custom image and resource limits', async () => {
    let capturedArgs: string[] = [];
    const mockProc = {
      exited: Promise.resolve(0),
      stdout: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('')); c.close(); } }),
      stderr: new ReadableStream({ start(c) { c.close(); } }),
      pid: 12345,
      kill: () => {},
    };

    const sandbox = new SandboxManager({
      workspacePath: '/tmp/workspace',
      image: 'custom-sandbox:v2',
      memoryLimit: '1g',
      pidsLimit: 200,
      spawnFn: ((args: string[]) => { capturedArgs = args; return mockProc; }) as any,
    });

    await sandbox.execute('task-custom', ['ls']);

    expect(capturedArgs).toContain('custom-sandbox:v2');
    expect(capturedArgs).toContain('1g');
    expect(capturedArgs).toContain('200');
  });
});

// ── I17: Full enforcement ───────────────────────────────────────

describe('I17 enforcement in runner', () => {
  test('speculative oracle at L0 should be rejected', async () => {
    const { runOracle } = await import('../../src/oracle/runner.ts');
    const { registerOracle, unregisterOracle } = await import('../../src/oracle/registry.ts');

    registerOracle('test-speculative', {
      path: '/nonexistent/oracle.ts',
      tier: 'speculative',
    });

    const violations: unknown[] = [];
    const mockBus = {
      emit: (event: string, payload: unknown) => {
        violations.push({ event, payload });
      },
    };

    try {
      const verdict = await runOracle('test-speculative', {
        target: 'test',
        pattern: 'test',
        workspace: '/tmp',
      }, {
        routingLevel: 0,
        bus: mockBus,
      });

      expect(verdict.verified).toBe(false);
      expect(verdict.errorCode).toBe('GUARDRAIL_BLOCKED');
      expect(verdict.reason).toContain('I17');
      expect(violations.length).toBe(1);
      expect((violations[0] as any).event).toBe('guardrail:violation');
      expect((violations[0] as any).payload.severity).toBe('error');
    } finally {
      unregisterOracle('test-speculative');
    }
  });

  test('speculative oracle at L1 should be rejected', async () => {
    const { runOracle } = await import('../../src/oracle/runner.ts');
    const { registerOracle, unregisterOracle } = await import('../../src/oracle/registry.ts');

    registerOracle('test-speculative-l1', {
      path: '/nonexistent/oracle.ts',
      tier: 'speculative',
    });

    try {
      const verdict = await runOracle('test-speculative-l1', {
        target: 'test',
        pattern: 'test',
        workspace: '/tmp',
      }, {
        routingLevel: 1,
      });

      expect(verdict.verified).toBe(false);
      expect(verdict.errorCode).toBe('GUARDRAIL_BLOCKED');
    } finally {
      unregisterOracle('test-speculative-l1');
    }
  });

  test('speculative oracle at L2 should proceed (not blocked)', async () => {
    const { runOracle } = await import('../../src/oracle/runner.ts');
    const { registerOracle, unregisterOracle } = await import('../../src/oracle/registry.ts');

    registerOracle('test-speculative-l2', {
      path: '/nonexistent/oracle.ts',
      tier: 'speculative',
    });

    try {
      const verdict = await runOracle('test-speculative-l2', {
        target: 'test',
        pattern: 'test',
        workspace: '/tmp',
      }, {
        routingLevel: 2,
      });

      // Should NOT be GUARDRAIL_BLOCKED — it passed the I17 check
      expect(verdict.errorCode).not.toBe('GUARDRAIL_BLOCKED');
    } finally {
      unregisterOracle('test-speculative-l2');
    }
  });

  test('non-speculative oracle at L0 should proceed', async () => {
    const { runOracle } = await import('../../src/oracle/runner.ts');
    const { registerOracle, unregisterOracle } = await import('../../src/oracle/registry.ts');

    registerOracle('test-heuristic', {
      path: '/nonexistent/oracle.ts',
      tier: 'heuristic',
    });

    try {
      const verdict = await runOracle('test-heuristic', {
        target: 'test',
        pattern: 'test',
        workspace: '/tmp',
      }, {
        routingLevel: 0,
      });

      // Should NOT be blocked by I17
      expect(verdict.errorCode).not.toBe('GUARDRAIL_BLOCKED');
    } finally {
      unregisterOracle('test-heuristic');
    }
  });
});
