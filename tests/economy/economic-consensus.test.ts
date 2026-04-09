import { describe, expect, test } from 'bun:test';
import { resolveEconomicDispute } from '../../src/economy/economic-consensus.ts';

describe('resolveEconomicDispute', () => {
  test('R1: both billing → trust lower value', () => {
    const result = resolveEconomicDispute(
      'd-1',
      'cost_mismatch',
      { usd: 1.0, tier: 'billing' },
      { usd: 1.5, tier: 'billing' },
      'established',
    );
    expect(result.resolved_usd).toBe(1.0);
    expect(result.resolution).toBe('accept_local');
    expect(result.deterministic_rule).toContain('R1');
  });

  test('R1: remote is lower when both billing', () => {
    const result = resolveEconomicDispute(
      'd-2',
      'cost_mismatch',
      { usd: 2.0, tier: 'billing' },
      { usd: 1.0, tier: 'billing' },
      'established',
    );
    expect(result.resolved_usd).toBe(1.0);
    expect(result.resolution).toBe('accept_remote');
  });

  test('R2: billing beats estimated (local billing)', () => {
    const result = resolveEconomicDispute(
      'd-3',
      'cost_mismatch',
      { usd: 1.0, tier: 'billing' },
      { usd: 0.5, tier: 'estimated' },
      'established',
    );
    expect(result.resolved_usd).toBe(1.0);
    expect(result.resolution).toBe('accept_local');
    expect(result.deterministic_rule).toContain('R2');
  });

  test('R2: billing beats estimated (remote billing)', () => {
    const result = resolveEconomicDispute(
      'd-4',
      'cost_mismatch',
      { usd: 0.5, tier: 'estimated' },
      { usd: 1.0, tier: 'billing' },
      'established',
    );
    expect(result.resolved_usd).toBe(1.0);
    expect(result.resolution).toBe('accept_remote');
  });

  test('R3: same tier + low trust → trust local', () => {
    const result = resolveEconomicDispute(
      'd-5',
      'cost_mismatch',
      { usd: 1.0, tier: 'estimated' },
      { usd: 0.5, tier: 'estimated' },
      'provisional',
    );
    expect(result.resolved_usd).toBe(1.0);
    expect(result.resolution).toBe('accept_local');
    expect(result.deterministic_rule).toContain('R3');
  });

  test('R4: same tier + high trust → split difference', () => {
    const result = resolveEconomicDispute(
      'd-6',
      'cost_mismatch',
      { usd: 1.0, tier: 'estimated' },
      { usd: 2.0, tier: 'estimated' },
      'established',
    );
    expect(result.resolved_usd).toBeCloseTo(1.5, 5);
    expect(result.resolution).toBe('split_difference');
    expect(result.deterministic_rule).toContain('R4');
  });

  test('R4: trusted peer → split difference', () => {
    const result = resolveEconomicDispute(
      'd-7',
      'budget_violation',
      { usd: 3.0, tier: 'estimated' },
      { usd: 5.0, tier: 'estimated' },
      'trusted',
    );
    expect(result.resolved_usd).toBeCloseTo(4.0, 5);
    expect(result.resolution).toBe('split_difference');
  });

  test('deterministic: same inputs → same output', () => {
    const r1 = resolveEconomicDispute(
      'd-8',
      'cost_mismatch',
      { usd: 1.0, tier: 'billing' },
      { usd: 2.0, tier: 'billing' },
      'established',
    );
    const r2 = resolveEconomicDispute(
      'd-8',
      'cost_mismatch',
      { usd: 1.0, tier: 'billing' },
      { usd: 2.0, tier: 'billing' },
      'established',
    );
    expect(r1.resolved_usd).toBe(r2.resolved_usd);
    expect(r1.resolution).toBe(r2.resolution);
  });
});
