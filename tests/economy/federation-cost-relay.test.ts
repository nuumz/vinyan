import { describe, expect, test } from 'bun:test';
import { FederationCostRelay, type FederationCostSignal } from '../../src/economy/federation-cost-relay.ts';

function makeSignal(overrides?: Partial<FederationCostSignal>): FederationCostSignal {
  return {
    instanceId: 'peer-1',
    taskId: 'task-1',
    computed_usd: 0.5,
    rate_card_id: 'claude-sonnet',
    cost_tier: 'billing',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('FederationCostRelay', () => {
  test('tracks peer costs', () => {
    const relay = new FederationCostRelay();
    relay.handlePeerCost('peer-1', makeSignal({ computed_usd: 1.0 }));
    relay.handlePeerCost('peer-1', makeSignal({ computed_usd: 0.5 }));
    expect(relay.getPeerTotalCost('peer-1')).toBeCloseTo(1.5, 5);
  });

  test('returns 0 for unknown peer', () => {
    const relay = new FederationCostRelay();
    expect(relay.getPeerTotalCost('unknown')).toBe(0);
  });

  test('tracks multiple peers', () => {
    const relay = new FederationCostRelay();
    relay.handlePeerCost('peer-1', makeSignal({ computed_usd: 1.0 }));
    relay.handlePeerCost('peer-2', makeSignal({ computed_usd: 2.0 }));
    expect(relay.getTrackedPeers()).toHaveLength(2);
  });

  test('emits event on cost received', () => {
    const events: unknown[] = [];
    const bus = { emit: (_: string, p: unknown) => events.push(p) } as any;
    const relay = new FederationCostRelay(bus);
    relay.handlePeerCost('peer-1', makeSignal());
    expect(events).toHaveLength(1);
  });
});
