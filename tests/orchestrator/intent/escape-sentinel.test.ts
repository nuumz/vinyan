/**
 * Escape sentinel — protocol parser for the persona-side abort signal.
 *
 * The sentinel is the persona's first-class "I cannot answer here" state
 * (Axiom A2). The parser is a deterministic regex (Axiom A3 — no LLM in
 * routing decisions). These tests pin the wire format so any future tweak
 * to the sentinel string can be caught here before it breaks every persona.
 */
import { describe, expect, it } from 'bun:test';
import {
  ESCAPE_SENTINEL_CLOSE,
  ESCAPE_SENTINEL_OPEN,
  formatEscapeProtocolBlock,
  parseEscapeSentinel,
} from '../../../src/orchestrator/intent/escape-sentinel.ts';

describe('parseEscapeSentinel', () => {
  it('matches a clean sentinel and returns the trimmed reason', () => {
    const out = parseEscapeSentinel('<<NEEDS_AGENTIC_WORKFLOW: user requested 2-chapter bedtime story>>');
    expect(out.matched).toBe(true);
    expect(out.reason).toBe('user requested 2-chapter bedtime story');
    expect(out.strippedAnswer).toBe('');
  });

  it('matches when the sentinel is embedded with surrounding text and strips it', () => {
    const answer = 'รับทราบครับ <<NEEDS_AGENTIC_WORKFLOW: 2-chapter story>> กรุณารอสักครู่';
    const out = parseEscapeSentinel(answer);
    expect(out.matched).toBe(true);
    expect(out.reason).toBe('2-chapter story');
    expect(out.strippedAnswer).toBe('รับทราบครับ  กรุณารอสักครู่');
  });

  it('does NOT match when the payload contains a `>` character', () => {
    // Defensive: the regex excludes `>` in the payload so the close marker is
    // unambiguous. Prevents accidental matches when the LLM writes HTML/JSX.
    const out = parseEscapeSentinel('<<NEEDS_AGENTIC_WORKFLOW: rendering <Button>foo</Button>>>');
    expect(out.matched).toBe(false);
  });

  it('does NOT match an empty payload', () => {
    expect(parseEscapeSentinel('<<NEEDS_AGENTIC_WORKFLOW:  >>').matched).toBe(false);
  });

  it('returns matched=false when the sentinel is absent', () => {
    expect(parseEscapeSentinel('a normal conversational reply').matched).toBe(false);
    expect(parseEscapeSentinel('').matched).toBe(false);
  });

  it('first sentinel wins when two appear (deterministic)', () => {
    const out = parseEscapeSentinel(
      '<<NEEDS_AGENTIC_WORKFLOW: first>><<NEEDS_AGENTIC_WORKFLOW: second>>',
    );
    expect(out.matched).toBe(true);
    expect(out.reason).toBe('first');
  });
});

describe('formatEscapeProtocolBlock', () => {
  it('contains the open + close markers and the example payload', () => {
    const block = formatEscapeProtocolBlock();
    expect(block).toContain(ESCAPE_SENTINEL_OPEN);
    expect(block).toContain(ESCAPE_SENTINEL_CLOSE);
    expect(block).toContain('[ESCAPE PROTOCOL]');
    // Make sure the persona is told NOT to promise to forward / delegate.
    expect(block.toLowerCase()).toContain('do not promise');
  });

  it('the example sentinels in the prompt are themselves parseable', () => {
    const block = formatEscapeProtocolBlock();
    // Reach for the first example line — it must match our own parser so
    // the persona has a guaranteed-correct template to imitate.
    const exampleMatch = /<<NEEDS_AGENTIC_WORKFLOW:[^>]+>>/.exec(block);
    expect(exampleMatch).not.toBeNull();
    const parsed = parseEscapeSentinel(exampleMatch![0]);
    expect(parsed.matched).toBe(true);
    expect(parsed.reason).toBeDefined();
  });
});
