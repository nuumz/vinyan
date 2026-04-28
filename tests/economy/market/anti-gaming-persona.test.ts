/**
 * Tests for Phase-3 anti-collusion personaId precondition (risk H7).
 *
 * Pre-Phase-3: 5 consecutive auctions with bid spread <5% → collusion alert.
 * Post-Phase-3: collusion alert requires ≥2 distinct personas in each
 *   counted auction. Auctions where every bid carries the same persona id
 *   are providers running an identical persona/skill loadout — tight bid
 *   spread is expected (estimating identical work), not collusion.
 */
import { describe, expect, test } from 'bun:test';
import { detectCollusion } from '../../../src/economy/market/anti-gaming.ts';

describe('detectCollusion — Phase-3 personaId precondition', () => {
  test('legacy path (no distinctPersonaCount) — tight spread fires alert', () => {
    const recent = Array.from({ length: 5 }, () => ({ bidSpread: 0.01 }));
    const alert = detectCollusion(recent);
    expect(alert).not.toBeNull();
    expect(alert!.type).toBe('collusion');
  });

  test('all auctions have a single persona — no collusion alert (false-positive prevented)', () => {
    const recent = Array.from({ length: 5 }, () => ({ bidSpread: 0.01, distinctPersonaCount: 1 }));
    expect(detectCollusion(recent)).toBeNull();
  });

  test('mixed personas across consecutive tight auctions — alert fires', () => {
    const recent = Array.from({ length: 5 }, () => ({ bidSpread: 0.01, distinctPersonaCount: 2 }));
    expect(detectCollusion(recent)).not.toBeNull();
  });

  test('partial coverage: some auctions are single-persona, some are multi — alert only counts multi', () => {
    // 5 multi-persona auctions interleaved with single-persona ones
    const recent = [
      { bidSpread: 0.01, distinctPersonaCount: 1 }, // skipped
      { bidSpread: 0.01, distinctPersonaCount: 2 }, // counted
      { bidSpread: 0.01, distinctPersonaCount: 1 }, // skipped
      { bidSpread: 0.01, distinctPersonaCount: 2 }, // counted
      { bidSpread: 0.01, distinctPersonaCount: 2 }, // counted
      { bidSpread: 0.01, distinctPersonaCount: 1 }, // skipped
      { bidSpread: 0.01, distinctPersonaCount: 2 }, // counted
      { bidSpread: 0.01, distinctPersonaCount: 2 }, // counted — 5 multi total → fire
    ];
    expect(detectCollusion(recent)).not.toBeNull();
  });

  test('window too short (after filtering) → no alert', () => {
    const recent = [
      { bidSpread: 0.01, distinctPersonaCount: 2 },
      { bidSpread: 0.01, distinctPersonaCount: 2 },
      { bidSpread: 0.01, distinctPersonaCount: 1 }, // skipped
      { bidSpread: 0.01, distinctPersonaCount: 1 }, // skipped
      { bidSpread: 0.01, distinctPersonaCount: 1 }, // skipped
    ];
    // Only 2 eligible auctions, threshold is 5
    expect(detectCollusion(recent)).toBeNull();
  });

  test('any auction with wide spread breaks the streak', () => {
    const recent = [
      { bidSpread: 0.01, distinctPersonaCount: 2 },
      { bidSpread: 0.01, distinctPersonaCount: 2 },
      { bidSpread: 0.5, distinctPersonaCount: 2 }, // wide spread breaks
      { bidSpread: 0.01, distinctPersonaCount: 2 },
      { bidSpread: 0.01, distinctPersonaCount: 2 },
    ];
    expect(detectCollusion(recent)).toBeNull();
  });
});
