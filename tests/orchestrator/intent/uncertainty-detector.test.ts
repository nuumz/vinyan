/**
 * Uncertainty detector tests — pins the trigger conditions for the
 * second-stage verifier escalation.
 */
import { describe, expect, it } from 'bun:test';
import {
  CHEAPEST_CLASS_LENGTH_THRESHOLD,
  evaluateUncertainty,
  hasDeliverableSignal,
  UNCERTAINTY_CONFIDENCE_FLOOR,
} from '../../../src/orchestrator/intent/uncertainty-detector.ts';
import type {
  ExecutionStrategy,
  IntentDeterministicCandidate,
  IntentResolution,
} from '../../../src/orchestrator/types.ts';
import type { IntentResponse } from '../../../src/orchestrator/intent/parser.ts';

function merged(strategy: ExecutionStrategy, confidence: number): IntentResolution {
  return {
    strategy,
    refinedGoal: 'g',
    confidence,
    reasoning: 'r',
  };
}

function llm(strategy: ExecutionStrategy, confidence?: number): IntentResponse {
  return {
    strategy,
    refinedGoal: 'g',
    reasoning: 'r',
    confidence,
  };
}

function detCandidate(over: Partial<IntentDeterministicCandidate> = {}): IntentDeterministicCandidate {
  return {
    strategy: 'conversational',
    confidence: 0.55,
    source: 'mapUnderstandingToStrategy',
    ambiguous: true,
    ...over,
  };
}

describe('hasDeliverableSignal', () => {
  it('matches Thai chapter quantifier', () => {
    expect(hasDeliverableSignal('เขียนนิยายให้สัก 2 บท')).toBe(true);
  });

  it('matches English authoring verb + noun', () => {
    expect(hasDeliverableSignal('write me a chapter about cats')).toBe(true);
  });

  it('does NOT match a plain greeting', () => {
    expect(hasDeliverableSignal('สวัสดี')).toBe(false);
    expect(hasDeliverableSignal('hello there')).toBe(false);
  });

  it('does NOT match a factual definition request', () => {
    expect(hasDeliverableSignal('นิยายเว็บตูนคืออะไร')).toBe(false);
  });
});

describe('evaluateUncertainty', () => {
  const longBedtimeGoal = 'ช่วยเขียนนิยายก่อนนอน สำหรับกล่อมลูกนอนให้สัก2บท';

  it('fires for the bedtime-story bug case (conversational + deliverable signal + length)', () => {
    expect(longBedtimeGoal.length).toBeGreaterThan(CHEAPEST_CLASS_LENGTH_THRESHOLD);
    const verdict = evaluateUncertainty({
      merged: merged('conversational', 0.55),
      llm: llm('conversational', 0.55),
      deterministicCandidate: detCandidate({ ambiguous: true }),
      goal: longBedtimeGoal,
    });
    expect(verdict.uncertain).toBe(true);
    expect(verdict.suspectedTarget).toBe('agentic-workflow');
    expect(verdict.reasons).toContain('deliverable-signal-regex');
    expect(verdict.reasons).toContain('cheapest-class-with-deliverable-signal');
  });

  it('does NOT fire when merged strategy is already agentic-workflow', () => {
    // The verifier is for under-classification; correct verdicts are not re-litigated.
    const verdict = evaluateUncertainty({
      merged: merged('agentic-workflow', 0.5),
      llm: llm('agentic-workflow'),
      deterministicCandidate: detCandidate({ ambiguous: true }),
      goal: longBedtimeGoal,
    });
    expect(verdict.uncertain).toBe(false);
  });

  it('does NOT fire on greetings (no deliverable signal, no ambiguity flag)', () => {
    const verdict = evaluateUncertainty({
      merged: merged('conversational', 0.4),
      llm: llm('conversational', 0.4),
      deterministicCandidate: { strategy: 'conversational', confidence: 0.95, source: 'mapUnderstandingToStrategy', ambiguous: false },
      goal: 'สวัสดีครับ',
    });
    expect(verdict.uncertain).toBe(false);
  });

  it('fires on deterministic ambiguity even at high merged confidence', () => {
    const verdict = evaluateUncertainty({
      merged: merged('conversational', 0.9),
      llm: llm('conversational', 0.9),
      deterministicCandidate: detCandidate({ ambiguous: true }),
      goal: 'a vague-ish request that mentions เขียนนิยาย',
    });
    expect(verdict.uncertain).toBe(true);
    expect(verdict.reasons).toContain('deterministic-ambiguous');
  });

  it('low-confidence alone is NOT enough to fire (cost-justifying signal required)', () => {
    // Pure low-confidence on plain Q&A should not always escalate to a
    // verifier LLM call — wasteful and noisy.
    expect(UNCERTAINTY_CONFIDENCE_FLOOR).toBeGreaterThan(0);
    const verdict = evaluateUncertainty({
      merged: merged('conversational', 0.4),
      llm: llm('conversational', 0.4),
      deterministicCandidate: { strategy: 'conversational', confidence: 0.6, source: 'mapUnderstandingToStrategy', ambiguous: false },
      goal: 'what is X',
    });
    expect(verdict.uncertain).toBe(false);
  });
});
