/**
 * Per-phase LLM config resolver tests — G3 interior LLM control.
 */
import { describe, expect, test } from 'bun:test';
import { resolvePhaseConfig } from '../../../src/orchestrator/llm/per-phase-config.ts';
import type { RoutingDecision } from '../../../src/orchestrator/types.ts';

function routing(phaseConfigs?: RoutingDecision['phaseConfigs']): Pick<RoutingDecision, 'phaseConfigs'> {
  return { phaseConfigs };
}

describe('resolvePhaseConfig', () => {
  test('returns empty sampling when no defaults and no overrides', () => {
    const cfg = resolvePhaseConfig('brainstorm', routing(), {});
    expect(cfg.sampling).toEqual({});
    expect(cfg.model).toBeUndefined();
    expect(cfg.reasoningEffort).toBeUndefined();
  });

  test('uses defaults when no override is supplied', () => {
    const cfg = resolvePhaseConfig('brainstorm', routing(), { temperature: 0.7 });
    expect(cfg.sampling.temperature).toBe(0.7);
  });

  test('routing override beats phase default', () => {
    const cfg = resolvePhaseConfig('brainstorm', routing({ brainstorm: { temperature: 0.2 } }), { temperature: 0.7 });
    expect(cfg.sampling.temperature).toBe(0.2);
  });

  test('undefined override field falls back to default (no clobber)', () => {
    // override sets topP but leaves temperature unset → temperature default holds.
    const cfg = resolvePhaseConfig('brainstorm', routing({ brainstorm: { topP: 0.95 } }), { temperature: 0.7 });
    expect(cfg.sampling.temperature).toBe(0.7);
    expect(cfg.sampling.topP).toBe(0.95);
  });

  test('empty stopSequences override is treated as unset (does not clear default)', () => {
    const cfg = resolvePhaseConfig('brainstorm', routing({ brainstorm: { stopSequences: [] } }), {
      stopSequences: ['\n\n'],
    });
    expect(cfg.sampling.stopSequences).toEqual(['\n\n']);
  });

  test('non-empty stopSequences override replaces default', () => {
    const cfg = resolvePhaseConfig('brainstorm', routing({ brainstorm: { stopSequences: ['END'] } }), {
      stopSequences: ['\n\n'],
    });
    expect(cfg.sampling.stopSequences).toEqual(['END']);
  });

  test('per-phase scope: an override on critic does not leak into brainstorm', () => {
    const r = routing({ critic: { temperature: 0.0 }, brainstorm: { temperature: 0.7 } });
    expect(resolvePhaseConfig('critic', r).sampling.temperature).toBe(0.0);
    expect(resolvePhaseConfig('brainstorm', r).sampling.temperature).toBe(0.7);
  });

  test('forwards model override when supplied', () => {
    const cfg = resolvePhaseConfig('critic', routing({ critic: { model: 'claude-haiku-4-5-20251001' } }));
    expect(cfg.model).toBe('claude-haiku-4-5-20251001');
  });

  test('reasoningEffort: override beats default', () => {
    const cfg = resolvePhaseConfig('plan', routing({ plan: { reasoningEffort: 'max' } }), {
      reasoningEffort: 'medium',
    });
    expect(cfg.reasoningEffort).toBe('max');
  });

  test('topK and topP both forwarded when set', () => {
    const cfg = resolvePhaseConfig('verify', routing({ verify: { topP: 0.9, topK: 10 } }));
    expect(cfg.sampling.topP).toBe(0.9);
    expect(cfg.sampling.topK).toBe(10);
  });

  test('routing without phaseConfigs returns defaults only (back-compat)', () => {
    const cfg = resolvePhaseConfig('brainstorm', routing(), { temperature: 0.7 });
    expect(cfg.sampling.temperature).toBe(0.7);
    expect(cfg.sampling.topP).toBeUndefined();
  });

  test('completely missing routing arg also falls back to defaults', () => {
    const cfg = resolvePhaseConfig('brainstorm', undefined, { temperature: 0.7 });
    expect(cfg.sampling.temperature).toBe(0.7);
  });
});
