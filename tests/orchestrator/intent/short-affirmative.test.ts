/**
 * Short-affirmative continuation pre-classifier tests.
 *
 * Behavioral focus (per `behavior-testing` skill): every test calls the
 * function and asserts on the public verdict shape, not on internal state
 * or regex internals.
 */
import { describe, expect, it } from 'bun:test';
import { detectShortAffirmativeContinuation } from '../../../src/orchestrator/intent/short-affirmative.ts';
import type { Turn } from '../../../src/orchestrator/types.ts';

function userTurn(seq: number, text: string): Turn {
  return {
    id: `u${seq}`,
    sessionId: 's1',
    seq,
    role: 'user',
    blocks: [{ type: 'text', text }],
    tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    createdAt: Date.now(),
  };
}

function assistantTurn(seq: number, text: string): Turn {
  return {
    id: `a${seq}`,
    sessionId: 's1',
    seq,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    createdAt: Date.now(),
  };
}

const PROMISE_TEXT =
  'รับทราบครับ ผมจะส่งต่อให้ novelist เขียนนิทานก่อนนอนที่แสนอบอุ่นให้ทันทีครับ';

describe('detectShortAffirmativeContinuation', () => {
  it('matches the bedtime-story bug case end-to-end', () => {
    const turns: Turn[] = [
      userTurn(0, 'ช่วยเขียนนิยายก่อนนอน สำหรับกล่อมลูกนอนให้สัก2บท'),
      assistantTurn(1, PROMISE_TEXT),
    ];
    const out = detectShortAffirmativeContinuation({ goal: 'จัดการให้เลย', turns });
    expect(out.matched).toBe(true);
    expect(out.reconstructedWorkflowPrompt).toContain('นิยายก่อนนอน');
    expect(out.reconstructedFromTurnSeq).toBe(1);
    expect(out.reason).toContain('seq=1');
  });

  it('matches English short affirmatives too', () => {
    const turns: Turn[] = [
      userTurn(0, 'write me a 2-chapter story for my kid'),
      assistantTurn(1, "Got it — I'll forward this to novelist who will write the chapters for you."),
    ];
    const out = detectShortAffirmativeContinuation({ goal: 'go', turns });
    expect(out.matched).toBe(true);
    expect(out.reconstructedWorkflowPrompt).toMatch(/2-chapter|story/);
  });

  it('does NOT match when the affirmative carries extra context', () => {
    const turns: Turn[] = [
      userTurn(0, 'write a story'),
      assistantTurn(1, 'I will forward to novelist for a story.'),
    ];
    const out = detectShortAffirmativeContinuation({
      goal: 'ok let me think about it more',
      turns,
    });
    expect(out.matched).toBe(false);
  });

  it('does NOT match when no prior assistant promise exists', () => {
    const turns: Turn[] = [
      userTurn(0, 'hi'),
      assistantTurn(1, 'Hello! How can I help you today?'),
    ];
    const out = detectShortAffirmativeContinuation({ goal: 'go', turns });
    expect(out.matched).toBe(false);
  });

  it('does NOT match when the assistant turn already produced the deliverable (code block hint)', () => {
    // Code fence in the prior turn = work already happened. The affirmative
    // means something else (continue / accept), not "do the proposed thing".
    const turns: Turn[] = [
      userTurn(0, 'write a story'),
      assistantTurn(1, 'Here is the story:\n```\nOnce upon a time...\n```'),
    ];
    const out = detectShortAffirmativeContinuation({ goal: 'go', turns });
    expect(out.matched).toBe(false);
  });

  it('returns matched=false when turns array is empty or undefined', () => {
    expect(detectShortAffirmativeContinuation({ goal: 'go', turns: [] }).matched).toBe(false);
    expect(detectShortAffirmativeContinuation({ goal: 'go', turns: undefined }).matched).toBe(false);
  });

  it('does NOT match when the prior assistant turn lacks deliverable noun', () => {
    const turns: Turn[] = [
      userTurn(0, 'how are you'),
      assistantTurn(1, "I'll forward to my friend later."),
    ];
    expect(
      detectShortAffirmativeContinuation({ goal: 'do it', turns }).matched,
    ).toBe(false);
  });
});
