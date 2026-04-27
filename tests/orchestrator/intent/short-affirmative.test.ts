/**
 * Short-affirmative continuation pre-classifier tests.
 *
 * Behavioral focus (per `behavior-testing` skill): every test calls the
 * function and asserts on the public verdict shape, not on internal state
 * or regex internals.
 */
import { describe, expect, it } from 'bun:test';
import {
  detectRetryContinuation,
  detectShortAffirmativeContinuation,
} from '../../../src/orchestrator/intent/short-affirmative.ts';
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

describe('detectRetryContinuation', () => {
  it('replays the prior user request after a timed-out assistant turn', () => {
    const turns: Turn[] = [
      userTurn(0, 'ช่วยตรวจสอบไฟล์บน ~/Desktop/'),
      assistantTurn(
        1,
        'Task timed out after 151s (budget: 120s) at routing level L2. Try narrowing the request, or raise --max-duration if the task legitimately needs more time.',
      ),
    ];
    const out = detectRetryContinuation({ goal: 'retry', turns });
    expect(out.matched).toBe(true);
    expect(out.reconstructedWorkflowPrompt).toContain('~/Desktop/');
    expect(out.reconstructedFromTurnSeq).toBe(0);
    expect(out.reason).toContain('seq=0');
  });

  it('matches the Thai retry phrase "ลองใหม่"', () => {
    const turns: Turn[] = [
      userTurn(0, 'list files in /tmp'),
      assistantTurn(1, "I'm sorry, I cannot access your local filesystem from here."),
    ];
    const out = detectRetryContinuation({ goal: 'ลองใหม่', turns });
    expect(out.matched).toBe(true);
    expect(out.reconstructedWorkflowPrompt).toContain('/tmp');
  });

  it('matches "อีกครั้ง" and "try again" too', () => {
    const turns: Turn[] = [
      userTurn(0, 'run npm test'),
      assistantTurn(1, 'Error: tool timed out after 30s.'),
    ];
    expect(detectRetryContinuation({ goal: 'อีกครั้ง', turns }).matched).toBe(true);
    expect(detectRetryContinuation({ goal: 'try again', turns }).matched).toBe(true);
    expect(detectRetryContinuation({ goal: 'do it again', turns }).matched).toBe(true);
  });

  it('does NOT match when the prior assistant turn looks successful', () => {
    const turns: Turn[] = [
      userTurn(0, 'what is 2+2'),
      assistantTurn(1, '2 + 2 = 4'),
    ];
    expect(detectRetryContinuation({ goal: 'retry', turns }).matched).toBe(false);
  });

  it('does NOT match when there is no prior assistant turn at all', () => {
    expect(detectRetryContinuation({ goal: 'retry', turns: [] }).matched).toBe(false);
    expect(detectRetryContinuation({ goal: 'retry', turns: undefined }).matched).toBe(false);
  });

  it('does NOT match when the user adds context to retry', () => {
    const turns: Turn[] = [
      userTurn(0, 'list files in /tmp'),
      assistantTurn(1, 'Task timed out after 151s.'),
    ];
    expect(
      detectRetryContinuation({ goal: 'retry but use a different model', turns }).matched,
    ).toBe(false);
  });

  it('skips intermediate retry messages and replays the original request', () => {
    const turns: Turn[] = [
      userTurn(0, 'list files in /tmp'),
      assistantTurn(1, 'Task timed out.'),
      userTurn(2, 'retry'),
      assistantTurn(3, "I'm sorry, I cannot access your local files from here."),
    ];
    const out = detectRetryContinuation({ goal: 'ลองใหม่', turns });
    expect(out.matched).toBe(true);
    expect(out.reconstructedWorkflowPrompt).toContain('/tmp');
    // Prior user request at seq=0, not the seq=2 retry message itself.
    expect(out.reconstructedFromTurnSeq).toBe(0);
  });
});
