/**
 * Tests for K2.2 Engine Selector — trust-weighted engine selection.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
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
