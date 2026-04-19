/**
 * PromptSectionRegistry — volatility ordering invariant (plan commit B).
 *
 * Verifies the compile-time-equivalent runtime check that sections within a
 * target are ordered by volatility (frozen < session < turn) when sorted by
 * priority. The registry throws on violation so misclassification cannot
 * silently burn the cache at runtime.
 */
import { describe, expect, it } from 'bun:test';
import type { SectionContext } from '../../../src/orchestrator/llm/prompt-section-registry.ts';
import {
  createDefaultRegistry,
  createReasoningRegistry,
  PromptSectionRegistry,
} from '../../../src/orchestrator/llm/prompt-section-registry.ts';

function ctx(): SectionContext {
  return {
    goal: 'g',
    perception: {
      taskTarget: { file: 'x', description: 'x' },
      dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
      diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
      verifiedFacts: [],
      runtime: { nodeVersion: '20', os: 'linux', availableTools: [] },
    },
    memory: { failedApproaches: [], activeHypotheses: [], unresolvedUncertainties: [], scopedFacts: [] },
  };
}

describe('validateVolatilityOrdering', () => {
  it('accepts a valid frozen → session → turn ordering', () => {
    const r = new PromptSectionRegistry();
    r.register({
      id: 'a',
      target: 'user',
      cache: 'static',
      volatility: 'frozen',
      priority: 10,
      render: () => 'A',
    });
    r.register({
      id: 'b',
      target: 'user',
      cache: 'session',
      volatility: 'session',
      priority: 110,
      render: () => 'B',
    });
    r.register({
      id: 'c',
      target: 'user',
      cache: 'ephemeral',
      volatility: 'turn',
      priority: 210,
      render: () => 'C',
    });
    expect(() => r.validateVolatilityOrdering()).not.toThrow();
  });

  it('throws when turn appears before session in the same target', () => {
    const r = new PromptSectionRegistry();
    r.register({
      id: 'turn-first',
      target: 'user',
      cache: 'ephemeral',
      volatility: 'turn',
      priority: 10,
      render: () => 'T',
    });
    r.register({
      id: 'session-second',
      target: 'user',
      cache: 'session',
      volatility: 'session',
      priority: 20,
      render: () => 'S',
    });
    expect(() => r.validateVolatilityOrdering()).toThrow(/volatility violation/);
  });

  it('throws when session appears before frozen', () => {
    const r = new PromptSectionRegistry();
    r.register({
      id: 'sess',
      target: 'system',
      cache: 'session',
      volatility: 'session',
      priority: 10,
      render: () => 'S',
    });
    r.register({
      id: 'froz',
      target: 'system',
      cache: 'static',
      volatility: 'frozen',
      priority: 20,
      render: () => 'F',
    });
    expect(() => r.validateVolatilityOrdering()).toThrow(/volatility violation/);
  });

  it('validates each target independently — a violation in user does not affect system', () => {
    const r = new PromptSectionRegistry();
    // user: valid
    r.register({
      id: 'u1',
      target: 'user',
      cache: 'static',
      volatility: 'frozen',
      priority: 10,
      render: () => 'U1',
    });
    r.register({
      id: 'u2',
      target: 'user',
      cache: 'ephemeral',
      volatility: 'turn',
      priority: 210,
      render: () => 'U2',
    });
    // system: violation
    r.register({
      id: 's1',
      target: 'system',
      cache: 'ephemeral',
      volatility: 'turn',
      priority: 10,
      render: () => 'S1',
    });
    r.register({
      id: 's2',
      target: 'system',
      cache: 'static',
      volatility: 'frozen',
      priority: 20,
      render: () => 'S2',
    });
    expect(() => r.validateVolatilityOrdering()).toThrow(/'system'/);
  });

  it('default + reasoning registries both pass validation at construction', () => {
    // createDefaultRegistry / createReasoningRegistry call the validator in
    // their factory body — a violation would throw from these calls.
    expect(() => createDefaultRegistry()).not.toThrow();
    expect(() => createReasoningRegistry()).not.toThrow();
  });
});

describe('renderTargetByTier — per-tier segments + offsets', () => {
  it('separates sections into frozen / session / turn with accurate offsets', () => {
    const r = new PromptSectionRegistry();
    r.register({
      id: 'f',
      target: 'user',
      cache: 'static',
      volatility: 'frozen',
      priority: 10,
      render: () => 'FROZEN',
    });
    r.register({
      id: 's',
      target: 'user',
      cache: 'session',
      volatility: 'session',
      priority: 110,
      render: () => 'SESSION',
    });
    r.register({
      id: 't',
      target: 'user',
      cache: 'ephemeral',
      volatility: 'turn',
      priority: 210,
      render: () => 'TURN',
    });

    const tiers = r.renderTargetByTier('user', ctx());
    expect(tiers.frozen).toBe('FROZEN');
    expect(tiers.session).toBe('SESSION');
    expect(tiers.turn).toBe('TURN');
    expect(tiers.joined).toBe('FROZEN\n\nSESSION\n\nTURN');
    expect(tiers.offsets.frozenEnd).toBe('FROZEN\n\n'.length);
    expect(tiers.offsets.sessionEnd).toBe('FROZEN\n\nSESSION\n\n'.length);
    expect(tiers.offsets.totalEnd).toBe(tiers.joined.length);

    // Slicing by offsets reproduces each tier (plus the trailing separator).
    const frozenSlice = tiers.joined.slice(0, tiers.offsets.frozenEnd);
    const sessionSlice = tiers.joined.slice(tiers.offsets.frozenEnd, tiers.offsets.sessionEnd);
    const turnSlice = tiers.joined.slice(tiers.offsets.sessionEnd);
    expect(frozenSlice).toBe('FROZEN\n\n');
    expect(sessionSlice).toBe('SESSION\n\n');
    expect(turnSlice).toBe('TURN');
  });

  it('handles missing tiers gracefully (frozen-only)', () => {
    const r = new PromptSectionRegistry();
    r.register({
      id: 'f',
      target: 'system',
      cache: 'static',
      volatility: 'frozen',
      priority: 10,
      render: () => 'ONLY_FROZEN',
    });
    const tiers = r.renderTargetByTier('system', ctx());
    expect(tiers.frozen).toBe('ONLY_FROZEN');
    expect(tiers.session).toBe('');
    expect(tiers.turn).toBe('');
    expect(tiers.offsets.frozenEnd).toBe('ONLY_FROZEN'.length);
    expect(tiers.offsets.sessionEnd).toBe('ONLY_FROZEN'.length);
    expect(tiers.offsets.totalEnd).toBe('ONLY_FROZEN'.length);
  });

  it('skips sections that render null', () => {
    const r = new PromptSectionRegistry();
    r.register({
      id: 'f',
      target: 'user',
      cache: 'static',
      volatility: 'frozen',
      priority: 10,
      render: () => 'F',
    });
    r.register({
      id: 's-null',
      target: 'user',
      cache: 'session',
      volatility: 'session',
      priority: 110,
      render: () => null,
    });
    r.register({
      id: 't',
      target: 'user',
      cache: 'ephemeral',
      volatility: 'turn',
      priority: 210,
      render: () => 'T',
    });
    const tiers = r.renderTargetByTier('user', ctx());
    expect(tiers.frozen).toBe('F');
    expect(tiers.session).toBe('');
    expect(tiers.turn).toBe('T');
    expect(tiers.joined).toBe('F\n\nT');
  });
});
