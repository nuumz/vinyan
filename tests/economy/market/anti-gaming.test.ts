import { describe, expect, test } from 'bun:test';
import { computeBidSpread, detectCollusion, detectFreeRide } from '../../../src/economy/market/anti-gaming.ts';

describe('computeBidSpread', () => {
  test('returns 1.0 for single bid', () => {
    expect(computeBidSpread([{ estimatedTokens: 1000 }])).toBe(1.0);
  });

  test('computes spread correctly', () => {
    const spread = computeBidSpread([{ estimatedTokens: 1000 }, { estimatedTokens: 2000 }, { estimatedTokens: 3000 }]);
    // (3000 - 1000) / 2000 = 1.0
    expect(spread).toBeCloseTo(1.0, 3);
  });

  test('tight bids produce low spread', () => {
    const spread = computeBidSpread([{ estimatedTokens: 1000 }, { estimatedTokens: 1010 }, { estimatedTokens: 1020 }]);
    expect(spread).toBeLessThan(0.05);
  });
});

describe('detectCollusion', () => {
  test('returns null with insufficient auctions', () => {
    expect(detectCollusion([{ bidSpread: 0.01 }])).toBeNull();
  });

  test('detects collusion when spread consistently tight', () => {
    const auctions = Array.from({ length: 5 }, () => ({ bidSpread: 0.02 }));
    const alert = detectCollusion(auctions);
    expect(alert).not.toBeNull();
    expect(alert!.type).toBe('collusion');
    expect(alert!.severity).toBe('penalty');
  });

  test('no collusion when spread varies', () => {
    const auctions = [
      { bidSpread: 0.01 },
      { bidSpread: 0.5 },
      { bidSpread: 0.02 },
      { bidSpread: 0.8 },
      { bidSpread: 0.03 },
    ];
    expect(detectCollusion(auctions)).toBeNull();
  });
});

describe('detectFreeRide', () => {
  test('no alert when task succeeded', () => {
    expect(detectFreeRide(100, 5000, false)).toBeNull();
  });

  test('detects free-ride when low effort + failure', () => {
    const alert = detectFreeRide(500, 5000, true);
    expect(alert).not.toBeNull();
    expect(alert!.type).toBe('free_ride');
  });

  test('no alert when effort is reasonable', () => {
    expect(detectFreeRide(3000, 5000, true)).toBeNull();
  });
});
