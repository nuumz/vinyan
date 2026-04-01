/**
 * Intent declaration + task preemption tests — Phase H1+H2.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_TTLS, type EcpIntent, IntentManager } from '../../src/a2a/intent.ts';
import { EventBus, type VinyanBusEvents } from '../../src/core/bus.ts';

function makeBus(): EventBus<VinyanBusEvents> {
  return new EventBus<VinyanBusEvents>();
}

function makeManager(instanceId = 'inst-001', bus?: EventBus<VinyanBusEvents>) {
  return new IntentManager({ instanceId, bus });
}

function makeRemoteIntent(overrides: Partial<EcpIntent> = {}): EcpIntent {
  return {
    intent_id: `int-remote-${Date.now()}`,
    instance_id: 'inst-002',
    action: 'modify',
    targets: ['/src/auth.ts'],
    priority: 'normal',
    lease_ttl_ms: 180_000,
    declared_at: Date.now(),
    expires_at: Date.now() + 180_000,
    ...overrides,
  };
}

describe('IntentManager — declare', () => {
  test('creates intent with correct fields', () => {
    const mgr = makeManager();
    const intent = mgr.declare('modify', ['/src/auth.ts'], 'high', {
      description: 'Refactor auth module',
    });

    expect(intent.intent_id).toMatch(/^int-/);
    expect(intent.instance_id).toBe('inst-001');
    expect(intent.action).toBe('modify');
    expect(intent.targets).toEqual(['/src/auth.ts']);
    expect(intent.priority).toBe('high');
    expect(intent.description).toBe('Refactor auth module');
  });

  test('applies default TTL based on priority', () => {
    const mgr = makeManager();
    const critical = mgr.declare('modify', ['/src/a.ts'], 'critical');
    const low = mgr.declare('modify', ['/src/b.ts'], 'low');

    expect(critical.lease_ttl_ms).toBe(DEFAULT_TTLS.critical); // 600s
    expect(low.lease_ttl_ms).toBe(DEFAULT_TTLS.low); // 60s
  });

  test('generates unique IDs', () => {
    const mgr = makeManager();
    const i1 = mgr.declare('modify', ['/src/a.ts'], 'normal');
    const i2 = mgr.declare('modify', ['/src/b.ts'], 'normal');
    expect(i1.intent_id).not.toBe(i2.intent_id);
  });
});

describe('IntentManager — release', () => {
  test('removes intent and returns true', () => {
    const mgr = makeManager();
    const intent = mgr.declare('modify', ['/src/a.ts'], 'normal');
    expect(mgr.release(intent.intent_id)).toBe(true);
    expect(mgr.getIntent(intent.intent_id)).toBeUndefined();
  });

  test('returns false for unknown intent', () => {
    const mgr = makeManager();
    expect(mgr.release('nonexistent')).toBe(false);
  });
});

describe('IntentManager — renew', () => {
  test('extends expiry', () => {
    const mgr = makeManager();
    const intent = mgr.declare('modify', ['/src/a.ts'], 'normal', { ttlMs: 10_000 });
    const beforeRenew = Date.now();

    const ok = mgr.renew(intent.intent_id, 300_000);
    expect(ok).toBe(true);
    expect(mgr.getIntent(intent.intent_id)!.expires_at).toBeGreaterThanOrEqual(beforeRenew + 300_000);
  });

  test('returns false for unknown intent', () => {
    const mgr = makeManager();
    expect(mgr.renew('nonexistent')).toBe(false);
  });

  test('default extension uses original TTL', () => {
    const mgr = makeManager();
    const intent = mgr.declare('modify', ['/src/a.ts'], 'high'); // 300s TTL
    const before = Date.now();

    mgr.renew(intent.intent_id); // no additionalMs
    const newExpiry = mgr.getIntent(intent.intent_id)!.expires_at;
    expect(newExpiry).toBeGreaterThanOrEqual(before + 300_000 - 10);
  });
});

describe('IntentManager — checkConflict', () => {
  test('direct file overlap = mandatory conflict', () => {
    const mgr = makeManager();
    mgr.declare('modify', ['/src/auth.ts', '/src/db.ts'], 'normal');

    const remote = makeRemoteIntent({ targets: ['/src/auth.ts'] });
    const conflicts = mgr.checkConflict(remote);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.conflict_level).toBe('mandatory');
    expect(conflicts[0]!.overlap_files).toContain('/src/auth.ts');
  });

  test('file vs blast radius = negotiate conflict', () => {
    const mgr = makeManager();
    mgr.declare('modify', ['/src/auth.ts'], 'normal');

    const remote = makeRemoteIntent({
      targets: ['/src/routes.ts'],
      blast_radius: ['/src/auth.ts'], // routes.ts blast radius includes auth.ts
    });
    const conflicts = mgr.checkConflict(remote);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.conflict_level).toBe('negotiate');
  });

  test('blast vs blast overlap = advisory conflict', () => {
    const mgr = makeManager();
    mgr.declare('modify', ['/src/auth.ts'], 'normal');
    // Manually add blast radius to local intent
    const localIntents = mgr.getActiveIntents();
    localIntents[0]!.blast_radius = ['/src/utils.ts'];

    const remote = makeRemoteIntent({
      targets: ['/src/routes.ts'],
      blast_radius: ['/src/utils.ts'], // overlapping blast radius
    });
    const conflicts = mgr.checkConflict(remote);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.conflict_level).toBe('advisory');
    expect(conflicts[0]!.recommended_ack).toBe('proceed'); // advisory = proceed
  });

  test('no conflict returns empty array', () => {
    const mgr = makeManager();
    mgr.declare('modify', ['/src/auth.ts'], 'normal');

    const remote = makeRemoteIntent({ targets: ['/src/unrelated.ts'] });
    expect(mgr.checkConflict(remote)).toHaveLength(0);
  });

  test('multiple conflicts from different intents', () => {
    const mgr = makeManager();
    mgr.declare('modify', ['/src/auth.ts'], 'normal');
    mgr.declare('modify', ['/src/db.ts'], 'normal');

    const remote = makeRemoteIntent({
      targets: ['/src/auth.ts', '/src/db.ts'],
    });
    const conflicts = mgr.checkConflict(remote);

    expect(conflicts).toHaveLength(2);
  });
});

describe('IntentManager — handleRemoteIntent', () => {
  test('higher priority incoming gets proceed', () => {
    const mgr = makeManager();
    mgr.declare('modify', ['/src/auth.ts'], 'normal');

    const remote = makeRemoteIntent({
      targets: ['/src/auth.ts'],
      priority: 'critical', // higher than normal
    });
    const ack = mgr.handleRemoteIntent('peer-B', remote);

    expect(ack).toBe('proceed');
  });

  test('lower priority incoming gets yield', () => {
    const mgr = makeManager();
    mgr.declare('modify', ['/src/auth.ts'], 'high');

    const remote = makeRemoteIntent({
      targets: ['/src/auth.ts'],
      priority: 'low', // lower than high
    });
    const ack = mgr.handleRemoteIntent('peer-B', remote);

    expect(ack).toBe('yield');
  });

  test('same priority FCFS — later declared yields', () => {
    const mgr = makeManager();
    const local = mgr.declare('modify', ['/src/auth.ts'], 'normal');

    const remote = makeRemoteIntent({
      targets: ['/src/auth.ts'],
      priority: 'normal',
      declared_at: local.declared_at + 1000, // declared later
    });
    const ack = mgr.handleRemoteIntent('peer-B', remote);

    expect(ack).toBe('yield');
  });

  test('deterministic tiebreak on instance_id', () => {
    const mgr = makeManager('inst-zzz'); // lexicographically later
    const now = Date.now();
    const local = mgr.declare('modify', ['/src/auth.ts'], 'normal');
    // Force same declared_at
    local.declared_at = now;

    const remote = makeRemoteIntent({
      instance_id: 'inst-aaa', // lexicographically earlier — should proceed
      targets: ['/src/auth.ts'],
      priority: 'normal',
      declared_at: now,
    });
    const ack = mgr.handleRemoteIntent('peer-B', remote);

    expect(ack).toBe('proceed');
  });

  test('emits bus events on conflict', () => {
    const bus = makeBus();
    const declared: any[] = [];
    const conflicts: any[] = [];
    bus.on('a2a:intentDeclared', (e) => declared.push(e));
    bus.on('a2a:intentConflict', (e) => conflicts.push(e));

    const mgr = makeManager('inst-001', bus);
    mgr.declare('modify', ['/src/auth.ts'], 'normal');

    mgr.handleRemoteIntent(
      'peer-B',
      makeRemoteIntent({
        targets: ['/src/auth.ts'],
      }),
    );

    expect(declared).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
  });
});

describe('IntentManager — cleanExpiredLeases', () => {
  test('removes expired intents', async () => {
    const mgr = makeManager();
    mgr.declare('modify', ['/src/a.ts'], 'normal', { ttlMs: 10 });
    await new Promise((r) => setTimeout(r, 20));

    const expired = mgr.cleanExpiredLeases();
    expect(expired).toHaveLength(1);
    expect(mgr.getActiveIntents()).toHaveLength(0);
  });

  test('leaves active intents', () => {
    const mgr = makeManager();
    mgr.declare('modify', ['/src/a.ts'], 'normal'); // 180s TTL

    expect(mgr.cleanExpiredLeases()).toHaveLength(0);
    expect(mgr.getActiveIntents()).toHaveLength(1);
  });
});

describe('IntentManager — queries', () => {
  test('getActiveIntents returns all stored intents', () => {
    const mgr = makeManager();
    mgr.declare('modify', ['/src/a.ts'], 'normal');
    mgr.declare('create', ['/src/b.ts'], 'high');

    expect(mgr.getActiveIntents()).toHaveLength(2);
  });

  test('getIntent returns undefined for unknown', () => {
    const mgr = makeManager();
    expect(mgr.getIntent('nonexistent')).toBeUndefined();
  });
});
