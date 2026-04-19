/**
 * StructuralFeatures — structural signal extraction for intent
 * classification (plan commit D2). Pure function; no I/O, no LLM.
 */
import { describe, expect, it } from 'bun:test';
import {
  computeStructuralFeatures,
  renderStructuralFeatures,
} from '../../../src/orchestrator/intent/features.ts';
import type { Turn } from '../../../src/orchestrator/types.ts';

function entry(role: 'user' | 'assistant', content: string): Turn {
  return {
    id: `t-${content}`,
    sessionId: 's',
    seq: 0,
    role,
    blocks: [{ type: 'text', text: content }],
    tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    createdAt: 0,
  };
}

describe('computeStructuralFeatures', () => {
  it('counts goal length after trimming whitespace', () => {
    expect(computeStructuralFeatures('  hello  ').lengthChars).toBe(5);
  });

  it('defaults turnNumber to 1 when no history supplied', () => {
    expect(computeStructuralFeatures('x').turnNumber).toBe(1);
  });

  it('computes turnNumber from paired user/assistant history', () => {
    const history: Turn[] = [
      entry('user', 'q1'),
      entry('assistant', 'a1'),
      entry('user', 'q2'),
      entry('assistant', 'a2'),
    ];
    expect(computeStructuralFeatures('q3', history).turnNumber).toBe(3);
  });

  it('detects ASCII question mark', () => {
    expect(computeStructuralFeatures('what is this?').endsWithQuestion).toBe(true);
  });

  it('detects full-width question mark (？, U+FF1F)', () => {
    expect(computeStructuralFeatures('hello？').endsWithQuestion).toBe(true);
  });

  it('detects Thai question particles', () => {
    expect(computeStructuralFeatures('ใช่ไหม').endsWithQuestion).toBe(true);
    expect(computeStructuralFeatures('มีมั้ย').endsWithQuestion).toBe(true);
    expect(computeStructuralFeatures('หรือเปล่า').endsWithQuestion).toBe(true);
    expect(computeStructuralFeatures('ดีรึเปล่า').endsWithQuestion).toBe(true);
  });

  it('returns endsWithQuestion=false for declarative text', () => {
    expect(computeStructuralFeatures('fix the bug').endsWithQuestion).toBe(false);
  });

  it('tolerates trailing whitespace / punctuation after Thai particle', () => {
    expect(computeStructuralFeatures('ใช่ไหม   ').endsWithQuestion).toBe(true);
    expect(computeStructuralFeatures('ใช่ไหม.').endsWithQuestion).toBe(true);
  });
});

describe('renderStructuralFeatures', () => {
  it('produces the expected deterministic string', () => {
    const rendered = renderStructuralFeatures({
      lengthChars: 12,
      endsWithQuestion: true,
      turnNumber: 3,
    });
    expect(rendered).toBe(
      'Goal metadata (deterministic): length=12 chars; ends with question marker: yes; session turn: #3',
    );
  });

  it('renders endsWithQuestion=false as "no"', () => {
    const rendered = renderStructuralFeatures({
      lengthChars: 5,
      endsWithQuestion: false,
      turnNumber: 1,
    });
    expect(rendered).toContain('ends with question marker: no');
  });
});
