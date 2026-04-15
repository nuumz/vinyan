/**
 * Tests for K2.2 Engine Selector — trust-weighted engine selection.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { ProviderTrustStore } from '../../src/db/provider-trust-store.ts';
import { DefaultEngineSelector } from '../../src/orchestrator/engine-selector.ts';
import type { RoutingLevel } from '../../src/orchestrator/types.ts';

function makeSelector(seedFn?: (store: ProviderTrustStore) => void) {
  const db = new Database(':memory:');
  const trustStore = new ProviderTrustStore(db);
  if (seedFn) seedFn(trustStore);
  const selector = new DefaultEngineSelector({ trustStore });
  return { selector, trustStore };
}

describe('DefaultEngineSelector', () => {
  test('G9: higher-trust engine wins selection', () => {
    const { selector } = makeSelector((store) => {
      // High trust provider: 18/20 success
      for (let i = 0; i < 18; i++) store.recordOutcome('trusted-engine', true);
      for (let i = 0; i < 2; i++) store.recordOutcome('trusted-engine', false);
      // Low trust provider: 5/20 success
      for (let i = 0; i < 5; i++) store.recordOutcome('low-trust-engine', true);
      for (let i = 0; i < 15; i++) store.recordOutcome('low-trust-engine', false);
    });

    const result = selector.select(1 as RoutingLevel, 'test-task');
    expect(result.provider).toBe('trusted-engine');
    expect(result.trustScore).toBeGreaterThan(0.5);
    expect(result.selectionReason).toContain('wilson-lb');
  });

  test('cold start returns default model from LEVEL_CONFIG', () => {
    const { selector } = makeSelector();

    const l1 = selector.select(1 as RoutingLevel, 'test');
    expect(l1.provider).toBe('claude-haiku');
    expect(l1.selectionReason).toBe('cold-start-default');

    const l2 = selector.select(2 as RoutingLevel, 'test');
    expect(l2.provider).toBe('claude-sonnet');

    const l3 = selector.select(3 as RoutingLevel, 'test');
    expect(l3.provider).toBe('claude-opus');
  });

  test('L0 returns null model (reflex level)', () => {
    const { selector } = makeSelector();
    const result = selector.select(0 as RoutingLevel, 'test');
    // L0 has null model in LEVEL_CONFIG → falls back to 'unknown'
    expect(result.provider).toBeDefined();
  });

  test('trust-below-threshold falls back to default', () => {
    const { selector } = makeSelector((store) => {
      // Provider with low trust: 2/10 success → Wilson LB ≈ 0.06
      for (let i = 0; i < 2; i++) store.recordOutcome('weak-engine', true);
      for (let i = 0; i < 8; i++) store.recordOutcome('weak-engine', false);
    });

    // L3 requires trust ≥ 0.7 — weak-engine won't qualify
    const result = selector.select(3 as RoutingLevel, 'test');
    expect(result.selectionReason).toContain('trust-below-threshold');
    expect(result.provider).toBe('claude-opus'); // default for L3
  });

  test('capability-specific selection uses relevant trust data', () => {
    const { selector } = makeSelector((store) => {
      // Engine A: great at code-gen, bad at review
      for (let i = 0; i < 15; i++) store.recordOutcome('engine-a', true, 'code-gen');
      store.recordOutcome('engine-a', false, 'code-gen');
      store.recordOutcome('engine-a', true, 'review');
      for (let i = 0; i < 15; i++) store.recordOutcome('engine-a', false, 'review');

      // Engine B: great at review, bad at code-gen
      store.recordOutcome('engine-b', true, 'code-gen');
      for (let i = 0; i < 15; i++) store.recordOutcome('engine-b', false, 'code-gen');
      for (let i = 0; i < 15; i++) store.recordOutcome('engine-b', true, 'review');
      store.recordOutcome('engine-b', false, 'review');
    });

    const codeGenResult = selector.select(1 as RoutingLevel, 'test', ['code-gen']);
    expect(codeGenResult.provider).toBe('engine-a');

    const reviewResult = selector.select(1 as RoutingLevel, 'test', ['review']);
    expect(reviewResult.provider).toBe('engine-b');
  });

  test('L1 minimum trust threshold filters appropriately', () => {
    const { selector } = makeSelector((store) => {
      // Provider with borderline trust: 4/10 → Wilson LB ~0.16 (below 0.3 threshold)
      for (let i = 0; i < 4; i++) store.recordOutcome('borderline', true);
      for (let i = 0; i < 6; i++) store.recordOutcome('borderline', false);
      // Provider with adequate trust: 7/10 → Wilson LB ~0.39 (above 0.3 threshold)
      for (let i = 0; i < 7; i++) store.recordOutcome('adequate', true);
      for (let i = 0; i < 3; i++) store.recordOutcome('adequate', false);
    });

    const result = selector.select(1 as RoutingLevel, 'test');
    expect(result.provider).toBe('adequate');
  });
});

// ── Wave 4.2: role-hint tier biasing ─────────────────────────────────

describe('DefaultEngineSelector — Wave 4.2 role-hint biasing', () => {
  function makeSelectorWithTiers(
    tiers: Record<string, 'fast' | 'balanced' | 'powerful' | 'tool-uses'>,
    seedFn?: (store: ProviderTrustStore) => void,
  ) {
    const db = new Database(':memory:');
    const trustStore = new ProviderTrustStore(db);
    if (seedFn) seedFn(trustStore);
    const selector = new DefaultEngineSelector({
      trustStore,
      getProviderTier: (id) => tiers[id],
    });
    return { selector };
  }

  test("roleHint='read' picks a fast-tier provider when available", () => {
    const { selector } = makeSelectorWithTiers(
      {
        'claude-haiku': 'fast',
        'claude-sonnet': 'balanced',
        'claude-opus': 'powerful',
      },
      (store) => {
        for (const p of ['claude-haiku', 'claude-sonnet', 'claude-opus']) {
          for (let i = 0; i < 10; i++) store.recordOutcome(p, true);
        }
      },
    );

    const result = selector.select(2 as RoutingLevel, 'task', undefined, 'read');
    expect(result.provider).toBe('claude-haiku');
    expect(result.selectionReason).toContain('role-hint:read→fast');
  });

  test("roleHint='implement' picks a balanced-tier provider when available", () => {
    const { selector } = makeSelectorWithTiers(
      {
        'claude-haiku': 'fast',
        'claude-sonnet': 'balanced',
      },
      (store) => {
        for (const p of ['claude-haiku', 'claude-sonnet']) {
          for (let i = 0; i < 10; i++) store.recordOutcome(p, true);
        }
      },
    );

    const result = selector.select(2 as RoutingLevel, 'task', undefined, 'implement');
    expect(result.provider).toBe('claude-sonnet');
    expect(result.selectionReason).toContain('role-hint:implement→balanced');
  });

  test("roleHint='debate' picks a powerful-tier provider", () => {
    const { selector } = makeSelectorWithTiers(
      {
        'claude-haiku': 'fast',
        'claude-opus': 'powerful',
      },
      (store) => {
        for (const p of ['claude-haiku', 'claude-opus']) {
          for (let i = 0; i < 10; i++) store.recordOutcome(p, true);
        }
      },
    );

    const result = selector.select(3 as RoutingLevel, 'task', undefined, 'debate');
    expect(result.provider).toBe('claude-opus');
    expect(result.selectionReason).toContain('role-hint:debate→powerful');
  });

  test('roleHint falls through when preferred tier is unavailable', () => {
    // Only a balanced provider is registered, but caller asks for 'read' (fast).
    // Selection must fall through to normal Wilson-LB selection, not fail.
    const { selector } = makeSelectorWithTiers(
      {
        'claude-sonnet': 'balanced',
      },
      (store) => {
        for (let i = 0; i < 10; i++) store.recordOutcome('claude-sonnet', true);
      },
    );

    const result = selector.select(2 as RoutingLevel, 'task', undefined, 'read');
    // Not a role-hint match reason
    expect(result.selectionReason).not.toContain('role-hint');
    // But a valid provider was still returned
    expect(result.provider).toBeDefined();
  });

  test('no roleHint preserves existing selection behavior', () => {
    const { selector } = makeSelectorWithTiers(
      {
        'claude-haiku': 'fast',
        'claude-sonnet': 'balanced',
      },
      (store) => {
        // haiku has much better trust
        for (let i = 0; i < 20; i++) store.recordOutcome('claude-haiku', true);
        for (let i = 0; i < 2; i++) store.recordOutcome('claude-sonnet', true);
        for (let i = 0; i < 8; i++) store.recordOutcome('claude-sonnet', false);
      },
    );

    const result = selector.select(1 as RoutingLevel, 'task');
    // Without a hint, highest-Wilson-LB provider wins
    expect(result.provider).toBe('claude-haiku');
    expect(result.selectionReason).toContain('wilson-lb');
  });

  test('roleHint without getProviderTier callback is a no-op', () => {
    const db = new Database(':memory:');
    const trustStore = new ProviderTrustStore(db);
    for (let i = 0; i < 10; i++) trustStore.recordOutcome('claude-sonnet', true);
    const selector = new DefaultEngineSelector({ trustStore });

    // Passing a hint without the tier lookup should fall through silently.
    const result = selector.select(2 as RoutingLevel, 'task', undefined, 'debate');
    expect(result.provider).toBeDefined();
    expect(result.selectionReason).not.toContain('role-hint');
  });
});
