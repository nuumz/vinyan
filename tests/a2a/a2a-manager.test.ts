/**
 * A2AManager coordinator tests — integration wiring.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { A2AManagerImpl, createA2AManager } from '../../src/a2a/a2a-manager.ts';
import { ECP_MIME_TYPE, type ECPDataPart } from '../../src/a2a/ecp-data-part.ts';
import { EventBus, type VinyanBusEvents } from '../../src/core/bus.ts';
import type { VinyanConfig } from '../../src/config/schema.ts';

// ── Helpers ───────────────────────────────────────────────────────────

const TEST_WORKSPACE = join(import.meta.dir, '../../.test-workspace-a2a-mgr');

function makeBus(): EventBus<VinyanBusEvents> {
  return new EventBus<VinyanBusEvents>();
}

function makePhase5(
  overrides: Partial<NonNullable<VinyanConfig['network']>> = {},
): NonNullable<VinyanConfig['network']> {
  return {
    instances: { enabled: false, peers: [], listen_port: 3928, heartbeat_interval_ms: 15000, heartbeat_timeout_ms: 45000 },
    knowledge_sharing: { enabled: false, file_invalidation_enabled: true, batch_exchange_enabled: true, max_probation_queue: 100, gossip_enabled: false, gossip_fanout: 3, gossip_max_hops: 6, gossip_dampening_window_ms: 10000 },
    trust: { promotion_untrusted_lb: 0.6, promotion_provisional_lb: 0.7, promotion_established_lb: 0.8, promotion_min_interactions: 10, demotion_on_consecutive_failures: 5, inactivity_decay_days: 7, trust_sharing_enabled: false, max_remote_trust: 0.4, attestation_min_interactions: 20, attestation_max_attesters: 3 },
    coordination: { intent_declaration_enabled: false, negotiation_enabled: false, commitment_tracking_enabled: false },
    tracing: { distributed_enabled: false, w3c_trace_context_enabled: true, sample_rate: 0.1 },
    ...overrides,
  };
}

function makeECPDataPart(messageType: string, payload: Record<string, unknown> = {}): ECPDataPart {
  return {
    ecp_version: 1,
    message_type: messageType as any,
    epistemic_type: 'known',
    confidence: 1,
    confidence_reported: true,
    payload,
  };
}

beforeEach(() => {
  if (!existsSync(TEST_WORKSPACE)) {
    mkdirSync(join(TEST_WORKSPACE, '.vinyan'), { recursive: true });
  }
});

afterEach(() => {
  if (existsSync(TEST_WORKSPACE)) {
    rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  }
});

// ── Construction ──────────────────────────────────────────────────────

describe('A2AManager — construction', () => {
  test('creates with minimal config (all disabled)', () => {
    const mgr = createA2AManager({
      workspace: TEST_WORKSPACE,
      bus: makeBus(),
      network: makePhase5(),
    });

    // Group 1 always created
    expect(mgr.peerTrustManager).toBeDefined();
    expect(mgr.costTracker).toBeDefined();
    expect(mgr.retractionManager).toBeDefined();

    // Group 2+3 not created
    expect(mgr.peerHealthMonitor).toBeUndefined();
    expect(mgr.remoteBusAdapter).toBeUndefined();
    expect(mgr.capabilityManager).toBeUndefined();
    expect(mgr.calibrationExchange).toBeUndefined();
    expect(mgr.fileInvalidationRelay).toBeUndefined();
    expect(mgr.knowledgeExchangeManager).toBeUndefined();
    expect(mgr.gossipManager).toBeUndefined();
    expect(mgr.feedbackManager).toBeUndefined();
    expect(mgr.trustAttestationManager).toBeUndefined();
    expect(mgr.negotiationManager).toBeUndefined();
    expect(mgr.commitmentTracker).toBeUndefined();
    expect(mgr.intentManager).toBeUndefined();
    expect(mgr.distributedTracer).toBeUndefined();
  });

  test('creates with instances.enabled', () => {
    const mgr = createA2AManager({
      workspace: TEST_WORKSPACE,
      bus: makeBus(),
      network: makePhase5({
        instances: {
          enabled: true,
          peers: [{ url: 'http://peer1:3928', trust_level: 'untrusted' }],
          listen_port: 3928,
          heartbeat_interval_ms: 15000,
          heartbeat_timeout_ms: 45000,
        },
      }),
    });

    expect(mgr.peerHealthMonitor).toBeDefined();
    expect(mgr.remoteBusAdapter).toBeDefined();
    expect(mgr.capabilityManager).toBeDefined();
    expect(mgr.calibrationExchange).toBeDefined();
  });

  test('creates coordination managers when flags enabled', () => {
    const mgr = createA2AManager({
      workspace: TEST_WORKSPACE,
      bus: makeBus(),
      network: makePhase5({
        coordination: {
          intent_declaration_enabled: true,
          negotiation_enabled: true,
          commitment_tracking_enabled: true,
        },
      }),
    });

    expect(mgr.negotiationManager).toBeDefined();
    expect(mgr.commitmentTracker).toBeDefined();
    expect(mgr.intentManager).toBeDefined();
  });

  test('creates knowledge managers when knowledge_sharing.enabled', () => {
    const mgr = createA2AManager({
      workspace: TEST_WORKSPACE,
      bus: makeBus(),
      network: makePhase5({
        instances: {
          enabled: true,
          peers: [{ url: 'http://peer1:3928', trust_level: 'untrusted' }],
          listen_port: 3928,
          heartbeat_interval_ms: 15000,
          heartbeat_timeout_ms: 45000,
        },
        knowledge_sharing: {
          enabled: true,
          file_invalidation_enabled: true,
          batch_exchange_enabled: true,
          max_probation_queue: 100,
          gossip_enabled: true,
          gossip_fanout: 3,
          gossip_max_hops: 6,
          gossip_dampening_window_ms: 10000,
        },
      }),
    });

    expect(mgr.fileInvalidationRelay).toBeDefined();
    expect(mgr.knowledgeExchangeManager).toBeDefined();
    expect(mgr.gossipManager).toBeDefined();
    expect(mgr.feedbackManager).toBeDefined();
  });

  test('creates trust attestation when trust_sharing_enabled', () => {
    const mgr = createA2AManager({
      workspace: TEST_WORKSPACE,
      bus: makeBus(),
      network: makePhase5({
        trust: {
          promotion_untrusted_lb: 0.6,
          promotion_provisional_lb: 0.7,
          promotion_established_lb: 0.8,
          promotion_min_interactions: 10,
          demotion_on_consecutive_failures: 5,
          inactivity_decay_days: 7,
          trust_sharing_enabled: true,
          max_remote_trust: 0.4,
          attestation_min_interactions: 20,
          attestation_max_attesters: 3,
        },
      }),
    });

    expect(mgr.trustAttestationManager).toBeDefined();
  });

  test('creates distributed tracer when tracing.distributed_enabled', () => {
    const mgr = createA2AManager({
      workspace: TEST_WORKSPACE,
      bus: makeBus(),
      network: makePhase5({
        tracing: { distributed_enabled: true, w3c_trace_context_enabled: true, sample_rate: 0.1 },
      }),
    });

    expect(mgr.distributedTracer).toBeDefined();
  });

  test('generates stable instanceId across constructions', () => {
    const bus = makeBus();
    const network = makePhase5();

    const mgr1 = createA2AManager({ workspace: TEST_WORKSPACE, bus, network });
    const mgr2 = createA2AManager({ workspace: TEST_WORKSPACE, bus, network });

    expect(mgr1.identity.instanceId).toBe(mgr2.identity.instanceId);
    expect(mgr1.identity.instanceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test('persists instanceId to .vinyan/instance-id', () => {
    const mgr = createA2AManager({ workspace: TEST_WORKSPACE, bus: makeBus(), network: makePhase5() });
    const idPath = join(TEST_WORKSPACE, '.vinyan', 'instance-id');

    expect(existsSync(idPath)).toBe(true);
    const stored = Bun.file(idPath).text();
    expect(stored).resolves.toBe(mgr.identity.instanceId);
  });
});

// ── ECP Message Routing ───────────────────────────────────────────────

describe('A2AManager — routeECPMessage', () => {
  function makeFullManager(): A2AManagerImpl {
    return createA2AManager({
      workspace: TEST_WORKSPACE,
      bus: makeBus(),
      network: makePhase5({
        instances: {
          enabled: true,
          peers: [{ url: 'http://peer1:3928', trust_level: 'untrusted' }],
          listen_port: 3928,
          heartbeat_interval_ms: 15000,
          heartbeat_timeout_ms: 45000,
        },
        knowledge_sharing: {
          enabled: true,
          file_invalidation_enabled: true,
          batch_exchange_enabled: true,
          max_probation_queue: 100,
          gossip_enabled: true,
          gossip_fanout: 3,
          gossip_max_hops: 6,
          gossip_dampening_window_ms: 10000,
        },
        coordination: {
          intent_declaration_enabled: true,
          negotiation_enabled: true,
          commitment_tracking_enabled: true,
        },
        trust: {
          promotion_untrusted_lb: 0.6,
          promotion_provisional_lb: 0.7,
          promotion_established_lb: 0.8,
          promotion_min_interactions: 10,
          demotion_on_consecutive_failures: 5,
          inactivity_decay_days: 7,
          trust_sharing_enabled: true,
          max_remote_trust: 0.4,
          attestation_min_interactions: 20,
          attestation_max_attesters: 3,
        },
        tracing: { distributed_enabled: true, w3c_trace_context_enabled: true, sample_rate: 0.1 },
      }),
    });
  }

  test('routes heartbeat — handled', () => {
    const mgr = makeFullManager();
    const result = mgr.routeECPMessage('peer-A', makeECPDataPart('heartbeat'));

    expect(result.handled).toBe(true);
    expect(result.type).toBe('heartbeat_ack');
  });

  test('routes propose to NegotiationManager', () => {
    const mgr = makeFullManager();
    const proposal = {
      proposal_id: 'prop-001',
      proposal_type: 'task_split',
      proposer_instance_id: 'inst-002',
      terms: { files: ['a.ts'] },
      expires_at: Date.now() + 60_000,
      max_rounds: 3,
      round: 1,
    };

    const result = mgr.routeECPMessage('peer-A', makeECPDataPart('propose', proposal));
    expect(result.handled).toBe(true);
    expect(result.type).toBe('proposal_received');

    // Verify proposal was stored
    expect(mgr.negotiationManager!.getProposal('prop-001')).toBeDefined();
  });

  test('routes retract to RetractionManager', () => {
    const mgr = makeFullManager();
    const retraction = {
      retraction_id: 'ret-001',
      target_type: 'verdict',
      target_id: 'v-001',
      severity: 'advisory',
      reason: 'manual',
      timestamp: Date.now(),
      peer_id: 'peer-A',
    };

    const result = mgr.routeECPMessage('peer-A', makeECPDataPart('retract', retraction));
    expect(result.handled).toBe(true);
    expect(result.type).toBe('retraction_received');
    expect(mgr.retractionManager.isRetracted('v-001')).toBe(true);
  });

  test('routes feedback to FeedbackManager', () => {
    const mgr = makeFullManager();
    const feedback = {
      feedback_id: 'fb-001',
      target_type: 'verdict',
      target_id: 'v-001',
      outcome: 'accurate',
      sender_instance_id: 'inst-002',
      timestamp: Date.now(),
    };

    const result = mgr.routeECPMessage('peer-A', makeECPDataPart('feedback', feedback));
    expect(result.handled).toBe(true);
    expect(result.type).toBe('feedback_received');
  });

  test('routes intent_declare to IntentManager', () => {
    const mgr = makeFullManager();
    const intent = {
      intent_id: 'int-001',
      instance_id: 'inst-002',
      action: 'modify',
      targets: ['/src/auth.ts'],
      priority: 'normal',
      lease_ttl_ms: 180_000,
      declared_at: Date.now(),
      expires_at: Date.now() + 180_000,
    };

    const result = mgr.routeECPMessage('peer-A', makeECPDataPart('intent_declare', intent));
    expect(result.handled).toBe(true);
    expect(result.type).toBe('intent_ack');
  });

  test('routes capability_update — handled', () => {
    const mgr = makeFullManager();
    const update = {
      instance_id: 'inst-002',
      capability_version: 2,
      update_type: 'full_snapshot',
    };

    const result = mgr.routeECPMessage('peer-A', makeECPDataPart('capability_update', update));
    expect(result.handled).toBe(true);
    expect(result.type).toBe('capability_updated');
  });

  test('routes trust_attestation — handled', () => {
    const mgr = makeFullManager();
    const attestation = {
      subject_instance_id: 'inst-003',
      attester_instance_id: 'inst-002',
      interactions: 25,
      accurate: 20,
      wilson_lb: 0.65,
      attestation_age_ms: 1000,
      hop_count: 0,
      signature: '',
    };

    const result = mgr.routeECPMessage('peer-A', makeECPDataPart('trust_attestation', attestation));
    expect(result.handled).toBe(true);
    expect(result.type).toBe('attestation_integrated');
  });

  test('routes knowledge_transfer — handled', () => {
    const mgr = makeFullManager();
    const result = mgr.routeECPMessage('peer-A', makeECPDataPart('knowledge_transfer', { type: 'batch' }));
    expect(result.handled).toBe(true);
    expect(result.type).toBe('knowledge_transfer_received');
  });

  test('routes streaming events — handled', () => {
    const mgr = makeFullManager();

    const progress = mgr.routeECPMessage('peer-A', makeECPDataPart('progress'));
    expect(progress.handled).toBe(true);
    expect(progress.type).toBe('streaming_event');

    const partial = mgr.routeECPMessage('peer-A', makeECPDataPart('partial_verdict'));
    expect(partial.handled).toBe(true);
  });

  test('falls through for request/respond message_types', () => {
    const mgr = makeFullManager();

    const request = mgr.routeECPMessage('peer-A', makeECPDataPart('request'));
    expect(request.handled).toBe(false);

    const respond = mgr.routeECPMessage('peer-A', makeECPDataPart('respond'));
    expect(respond.handled).toBe(false);

    const assert_ = mgr.routeECPMessage('peer-A', makeECPDataPart('assert'));
    expect(assert_.handled).toBe(false);
  });

  test('handles gracefully when target manager is disabled', () => {
    const mgr = createA2AManager({
      workspace: TEST_WORKSPACE,
      bus: makeBus(),
      network: makePhase5(), // all disabled
    });

    // These should not throw even though managers are undefined
    const propose = mgr.routeECPMessage('peer-A', makeECPDataPart('propose'));
    expect(propose.handled).toBe(true); // still handled, just no-op

    const intent = mgr.routeECPMessage('peer-A', makeECPDataPart('intent_declare'));
    expect(intent.handled).toBe(true);

    const feedback = mgr.routeECPMessage('peer-A', makeECPDataPart('feedback'));
    expect(feedback.handled).toBe(true);
  });
});

// ── Lifecycle ─────────────────────────────────────────────────────────

describe('A2AManager — lifecycle', () => {
  test('start and stop are idempotent', async () => {
    const mgr = createA2AManager({
      workspace: TEST_WORKSPACE,
      bus: makeBus(),
      network: makePhase5(),
    });

    // Multiple starts should not throw
    await mgr.start();
    await mgr.start();

    // Multiple stops should not throw
    await mgr.stop();
    await mgr.stop();
  });

  test('stop clears periodic intervals', async () => {
    const mgr = createA2AManager({
      workspace: TEST_WORKSPACE,
      bus: makeBus(),
      network: makePhase5({
        coordination: {
          intent_declaration_enabled: true,
          negotiation_enabled: true,
          commitment_tracking_enabled: true,
        },
      }),
    });

    await mgr.start();
    // After start, intervals should be set up internally
    await mgr.stop();
    // After stop, we can verify by starting/stopping again without issues
    await mgr.start();
    await mgr.stop();
  });
});
