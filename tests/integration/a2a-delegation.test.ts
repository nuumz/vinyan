/**
 * K2.3 — A2A cross-instance delegation integration test.
 *
 * Tests that two A2AManager instances can exchange ECP messages
 * through the routeECPMessage protocol. This verifies the delegation
 * path at the manager level (protocol-level, not full E2E with API server).
 *
 * Axioms: A2 (first-class uncertainty), A6 (zero-trust execution)
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createA2AManager, type A2AManagerImpl } from '../../src/a2a/a2a-manager.ts';
import type { ECPDataPart } from '../../src/a2a/ecp-data-part.ts';
import { EventBus, type VinyanBusEvents } from '../../src/core/bus.ts';
import type { VinyanConfig } from '../../src/config/schema.ts';

const WORKSPACE_A = join(import.meta.dir, '../../.test-workspace-a2a-integ-a');
const WORKSPACE_B = join(import.meta.dir, '../../.test-workspace-a2a-integ-b');

function makeBus(): EventBus<VinyanBusEvents> {
  return new EventBus<VinyanBusEvents>();
}

function makeNetwork(
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

function makeECPPart(messageType: string, payload: Record<string, unknown> = {}): ECPDataPart {
  return {
    ecp_version: 1,
    message_type: messageType as ECPDataPart['message_type'],
    epistemic_type: 'known',
    confidence: 1,
    confidence_reported: true,
    payload,
  };
}

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const vinyanDir = join(dir, '.vinyan');
  if (!existsSync(vinyanDir)) mkdirSync(vinyanDir, { recursive: true });
}

describe('K2.3 — A2A Cross-Instance Delegation', () => {
  let managerA: A2AManagerImpl;
  let managerB: A2AManagerImpl;

  beforeEach(() => {
    ensureDir(WORKSPACE_A);
    ensureDir(WORKSPACE_B);
    managerA = createA2AManager({ workspace: WORKSPACE_A, bus: makeBus(), network: makeNetwork() });
    managerB = createA2AManager({ workspace: WORKSPACE_B, bus: makeBus(), network: makeNetwork() });
  });

  afterEach(() => {
    managerA.stop();
    managerB.stop();
    rmSync(WORKSPACE_A, { recursive: true, force: true });
    rmSync(WORKSPACE_B, { recursive: true, force: true });
  });

  test('two instances have distinct identity', () => {
    expect(managerA.identity.instanceId).toBeTruthy();
    expect(managerB.identity.instanceId).toBeTruthy();
    expect(managerA.identity.instanceId).not.toBe(managerB.identity.instanceId);
  });

  test('instance A can route heartbeat message to B', () => {
    const result = managerB.routeECPMessage(managerA.identity.instanceId, makeECPPart('heartbeat'));
    expect(result.handled).toBe(true);
    expect(result.type).toBe('heartbeat_ack');
  });

  test('instance A can send feedback to B', () => {
    const feedback = makeECPPart('feedback', {
      task_id: 'test-task-1',
      feedback_type: 'correction',
      content: 'test correction from A to B',
    });
    const result = managerB.routeECPMessage(managerA.identity.instanceId, feedback);
    expect(result.handled).toBe(true);
    expect(result.type).toBe('feedback_received');
  });

  test('instance B can send capability update to A', () => {
    const capUpdate = makeECPPart('capability_update', {
      capabilities: ['code-mutation', 'test-generation'],
    });
    const result = managerA.routeECPMessage(managerB.identity.instanceId, capUpdate);
    expect(result.handled).toBe(true);
  });

  test('unknown message type returns handled: false', () => {
    const unknown = makeECPPart('nonexistent_type' as any, {});
    const result = managerA.routeECPMessage('unknown-peer', unknown);
    expect(result.handled).toBe(false);
  });

  test('bidirectional message exchange', () => {
    // A → B: heartbeat
    const r1 = managerB.routeECPMessage(managerA.identity.instanceId, makeECPPart('heartbeat'));
    expect(r1.handled).toBe(true);

    // B → A: heartbeat
    const r2 = managerA.routeECPMessage(managerB.identity.instanceId, makeECPPart('heartbeat'));
    expect(r2.handled).toBe(true);

    // A → B: feedback
    const r3 = managerB.routeECPMessage(managerA.identity.instanceId, makeECPPart('feedback', {
      task_id: 'task-1',
      feedback_type: 'confirmation',
      content: 'result accepted',
    }));
    expect(r3.handled).toBe(true);
  });
});
