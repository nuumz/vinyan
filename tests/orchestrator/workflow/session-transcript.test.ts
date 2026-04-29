/**
 * Session transcript formatter tests — public-API behavior only.
 */
import { describe, expect, it } from 'bun:test';
import { formatSessionTranscript } from '../../../src/orchestrator/workflow/session-transcript.ts';
import type { Turn } from '../../../src/orchestrator/types.ts';

function turn(seq: number, role: 'user' | 'assistant', text: string): Turn {
  return {
    id: `t${seq}`,
    sessionId: 's1',
    seq,
    role,
    blocks: [{ type: 'text', text }],
    tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    createdAt: Date.now() + seq,
  };
}

describe('formatSessionTranscript', () => {
  it('returns empty string when no turns', () => {
    expect(formatSessionTranscript(undefined)).toBe('');
    expect(formatSessionTranscript([])).toBe('');
  });

  it('renders user/assistant pairs with seq labels', () => {
    const turns: Turn[] = [turn(0, 'user', 'hello'), turn(1, 'assistant', 'hi')];
    const out = formatSessionTranscript(turns);
    expect(out).toContain('[User · turn 0]');
    expect(out).toContain('hello');
    expect(out).toContain('[Assistant · turn 1]');
    expect(out).toContain('hi');
  });

  it('takes only the tail when there are more turns than maxTurns', () => {
    const turns: Turn[] = [];
    for (let i = 0; i < 10; i++) turns.push(turn(i, i % 2 === 0 ? 'user' : 'assistant', `msg-${i}`));
    const out = formatSessionTranscript(turns, { maxTurns: 4 });
    // Should NOT contain the earliest turns
    expect(out).not.toContain('msg-0');
    expect(out).not.toContain('msg-5');
    // Should contain the last 4 turns
    expect(out).toContain('msg-6');
    expect(out).toContain('msg-9');
  });

  it('truncates a single turn that exceeds the per-turn cap', () => {
    const long = 'x'.repeat(2000);
    const turns: Turn[] = [turn(0, 'user', long)];
    const out = formatSessionTranscript(turns, { maxCharsPerTurn: 100 });
    expect(out).toContain('[truncated]');
    // Plus header / role marker overhead, so just sanity-check the body
    expect(out.length).toBeLessThan(300);
  });

  it('skips turns with no inspectable text rather than emitting a blank section', () => {
    const empty: Turn = {
      ...turn(0, 'user', ''),
      blocks: [], // no text blocks at all
    };
    const turns: Turn[] = [empty, turn(1, 'assistant', 'real reply')];
    const out = formatSessionTranscript(turns);
    expect(out).toContain('real reply');
    expect(out).not.toContain('turn 0');
  });

  it('drops earlier sections from the head when total budget is exhausted', () => {
    // Three 1500-char turns — exceeds the 4000-char total cap, so the
    // earliest one should fall off.
    const big = 'a'.repeat(1500);
    const med = 'b'.repeat(1500);
    const small = 'c'.repeat(1500);
    const turns: Turn[] = [
      turn(0, 'user', big),
      turn(1, 'assistant', med),
      turn(2, 'user', small),
    ];
    const out = formatSessionTranscript(turns, { maxCharsPerTurn: 1500, maxTotalChars: 4000 });
    expect(out).toContain('turn 2'); // newest survives
    expect(out.length).toBeLessThanOrEqual(4000 + 200); // some header overhead OK
  });
});
