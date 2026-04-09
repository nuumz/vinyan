import { describe, expect, test } from 'bun:test';
import { PeerPricingManager } from '../../src/economy/peer-pricing.ts';

describe('PeerPricingManager', () => {
  test('set and get local pricing', () => {
    const mgr = new PeerPricingManager();
    mgr.setLocalPricing('code-mutation', {
      taskType: 'code-mutation',
      price_per_token_input: 0.003,
      price_per_token_output: 0.015,
      min_charge_usd: 0.01,
    });
    const price = mgr.getLocalPricing('code-mutation');
    expect(price).not.toBeNull();
    expect(price!.price_per_token_input).toBe(0.003);
  });

  test('returns null for unknown task type', () => {
    const mgr = new PeerPricingManager();
    expect(mgr.getLocalPricing('unknown')).toBeNull();
  });

  test('evaluatePrice accepts within tolerance', () => {
    const mgr = new PeerPricingManager();
    expect(mgr.evaluatePrice(1.0, 1.0)).toBe('accept');
    expect(mgr.evaluatePrice(1.05, 1.0)).toBe('accept'); // within 10%
    expect(mgr.evaluatePrice(1.3, 1.0)).toBe('counter'); // negotiable
    expect(mgr.evaluatePrice(2.0, 1.0)).toBe('reject'); // too expensive
  });

  test('computeCounterOffer is midpoint', () => {
    const mgr = new PeerPricingManager();
    expect(mgr.computeCounterOffer(1.0, 0.5)).toBeCloseTo(0.75, 5);
  });

  test('records and queries peer pricing', () => {
    const mgr = new PeerPricingManager();
    mgr.recordPeerPricing('peer-1', {
      instanceId: 'peer-1',
      taskType: 'code-mutation',
      price_per_token_input: 0.005,
      price_per_token_output: 0.02,
      min_charge_usd: 0.02,
      valid_until: Date.now() + 60000,
    });

    const prices = mgr.getPeerPricesForType('code-mutation');
    expect(prices).toHaveLength(1);
    expect(prices[0]!.peerId).toBe('peer-1');
  });

  test('expired peer prices are excluded', () => {
    const mgr = new PeerPricingManager();
    mgr.recordPeerPricing('peer-1', {
      instanceId: 'peer-1',
      taskType: 'code-mutation',
      price_per_token_input: 0.005,
      price_per_token_output: 0.02,
      min_charge_usd: 0.02,
      valid_until: Date.now() - 1000, // expired
    });

    expect(mgr.getPeerPricesForType('code-mutation')).toHaveLength(0);
  });
});
