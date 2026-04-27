/**
 * Secretary persona — soul behavior contract.
 *
 * Pins the load-bearing constraints in the soul prompt that prevent the
 * "fake delegation" failure mode. The bedtime-story bug occurred because
 * the prior soul did not explicitly forbid promising hand-offs to other
 * agents — combined with the conversational shortcircuit's lack of a
 * dispatch mechanism, the persona generated text like "I'll forward to
 * novelist" that was structurally a lie.
 *
 * These tests are intentionally string-level — the soul IS a string fed
 * into the LLM, so its content is the contract.
 */
import { describe, expect, it } from 'bun:test';
import { secretary } from '../../../../src/orchestrator/agents/builtin/secretary.ts';

describe('secretary persona soul', () => {
  it('explicitly forbids fake delegation phrases', () => {
    const soul = secretary.soul ?? '';
    expect(soul).toMatch(/never claim/i);
    expect(soul.toLowerCase()).toMatch(/forward|hand[\s-]?off|delegate/);
    // Must reference the escape protocol so the persona has a sanctioned
    // exit path when a request truly exceeds its capability.
    expect(soul.toLowerCase()).toContain('escape protocol');
  });

  it('declares short-form creative writing as in-scope', () => {
    // Without this, the persona would refuse legitimate short creative
    // requests (poems, paragraphs, brief stories) and either fake-delegate
    // or punt unnecessarily.
    const soul = secretary.soul ?? '';
    expect(soul.toLowerCase()).toMatch(/short[-\s]?form\s+creative|brief\s+story|poem|paragraph/);
  });

  it('still routes code work elsewhere', () => {
    const soul = secretary.soul ?? '';
    expect(soul.toLowerCase()).toContain('ts-coder');
    expect(soul.toLowerCase()).toMatch(/never\s+attempt\s+code\s+mutations/);
  });
});
