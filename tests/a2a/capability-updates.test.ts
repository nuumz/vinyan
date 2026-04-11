/**
 * Dynamic capability updates tests — Phase J1.
 */
import { describe, expect, test } from 'bun:test';
import { CapabilityManager, type CapabilityUpdate } from '../../src/a2a/capability-updates.ts';
import { EventBus, type VinyanBusEvents } from '../../src/core/bus.ts';

function makeBus(): EventBus<VinyanBusEvents> {
  return new EventBus<VinyanBusEvents>();
}

function makeManager(bus?: EventBus<VinyanBusEvents>) {
  return new CapabilityManager({
    instanceId: 'inst-001',
    peerUrls: [],
    bus,
  });
}

describe('CapabilityManager — broadcastUpdate', () => {
  test('increments capability version', () => {
    const mgr = makeManager();
    const u1 = mgr.broadcastUpdate('oracle_added', { oracle_name: 'ast', action: 'added' });
    const u2 = mgr.broadcastUpdate('oracle_removed', { oracle_name: 'lint', action: 'removed' });

    expect(u1.capability_version).toBe(1);
    expect(u2.capability_version).toBe(2);
  });

  test('builds correct update structure', () => {
    const mgr = makeManager();
    const update = mgr.broadcastUpdate('oracle_added', {
      oracle_name: 'ast',
      action: 'added',
      details: { tier: 'deterministic', languages: ['typescript'] },
    });

    expect(update.instance_id).toBe('inst-001');
    expect(update.update_type).toBe('oracle_added');
    expect(update.delta!.oracle_name).toBe('ast');
    expect(update.timestamp).toBeGreaterThan(0);
  });

  test('sends to peers via A2A', async () => {
    let received = false;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        received = true;
        const body = (await req.json()) as Record<string, any>;
        return Response.json({ jsonrpc: '2.0', id: body.id, result: {} });
      },
    });

    try {
      const mgr = new CapabilityManager({
        instanceId: 'inst-001',
        peerUrls: [`http://localhost:${server.port}`],
      });

      mgr.broadcastUpdate('full_snapshot', undefined, { oracles: ['ast', 'type'] });
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(received).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});

describe('CapabilityManager — handleUpdate', () => {
  test('stores remote capability', () => {
    const mgr = makeManager();
    const update: CapabilityUpdate = {
      instance_id: 'inst-002',
      capability_version: 1,
      update_type: 'oracle_added',
      delta: { oracle_name: 'ast', action: 'added' },
      timestamp: Date.now(),
    };

    expect(mgr.handleUpdate('peer-A', update)).toBe(true);
    const remote = mgr.getRemoteCapability('peer-A');
    expect(remote).toBeDefined();
    expect(remote!.capabilityVersion).toBe(1);
  });

  test('rejects stale version', () => {
    const mgr = makeManager();
    mgr.handleUpdate('peer-A', {
      instance_id: 'inst-002',
      capability_version: 5,
      update_type: 'full_snapshot',
      timestamp: Date.now(),
    });

    const stale = mgr.handleUpdate('peer-A', {
      instance_id: 'inst-002',
      capability_version: 3,
      update_type: 'oracle_metrics',
      timestamp: Date.now(),
    });

    expect(stale).toBe(false);
    expect(mgr.getRemoteCapability('peer-A')!.capabilityVersion).toBe(5);
  });

  test('emits a2a:capabilityUpdated bus event', () => {
    const bus = makeBus();
    const events: any[] = [];
    bus.on('a2a:capabilityUpdated', (e) => events.push(e));

    const mgr = makeManager(bus);
    mgr.handleUpdate('peer-A', {
      instance_id: 'inst-002',
      capability_version: 1,
      update_type: 'oracle_added',
      timestamp: Date.now(),
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.capabilityVersion).toBe(1);
  });

  test('preserves existing snapshot on delta update', () => {
    const mgr = makeManager();
    mgr.handleUpdate('peer-A', {
      instance_id: 'inst-002',
      capability_version: 1,
      update_type: 'full_snapshot',
      snapshot: { oracles: ['ast'] },
      timestamp: Date.now(),
    });

    mgr.handleUpdate('peer-A', {
      instance_id: 'inst-002',
      capability_version: 2,
      update_type: 'oracle_added',
      delta: { oracle_name: 'type', action: 'added' },
      timestamp: Date.now(),
    });

    const remote = mgr.getRemoteCapability('peer-A');
    expect(remote!.snapshot).toEqual({ oracles: ['ast'] });
  });
});

describe('CapabilityManager — queries', () => {
  test('getRemoteCapabilities returns all', () => {
    const mgr = makeManager();
    mgr.handleUpdate('peer-A', {
      instance_id: 'inst-002',
      capability_version: 1,
      update_type: 'full_snapshot',
      timestamp: Date.now(),
    });
    mgr.handleUpdate('peer-B', {
      instance_id: 'inst-003',
      capability_version: 1,
      update_type: 'full_snapshot',
      timestamp: Date.now(),
    });

    expect(mgr.getRemoteCapabilities()).toHaveLength(2);
  });

  test('getRemoteCapability returns undefined for unknown peer', () => {
    const mgr = makeManager();
    expect(mgr.getRemoteCapability('unknown')).toBeUndefined();
  });

  test('getCurrentVersion reflects broadcast count', () => {
    const mgr = makeManager();
    expect(mgr.getCurrentVersion()).toBe(0);
    mgr.broadcastUpdate('oracle_added', { oracle_name: 'ast', action: 'added' });
    expect(mgr.getCurrentVersion()).toBe(1);
  });
});
