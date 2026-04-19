/**
 * Turn-importance classifier (Turn-aware) — mirror of
 * `tests/api/turn-importance.test.ts` for the `src/memory/turn-importance.ts`
 * port. Pins that the Turn-shape wrapper preserves exactly the same
 * classification semantics as feature/main's duck-typed classifier.
 *
 * Pure unit tests — no DB, no LLM, no filesystem.
 */

import { describe, expect, test } from 'bun:test';
import { classifyTurn } from '../../src/memory/turn-importance.ts';
import type { ContentBlock, Turn } from '../../src/orchestrator/types.ts';

let seq = 0;
function turn(role: 'user' | 'assistant', blocks: ContentBlock[]): Turn {
  return {
    id: `t-${seq++}`,
    sessionId: 's',
    seq: seq,
    role,
    blocks,
    tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    createdAt: 0,
  };
}

function userText(text: string): Turn {
  return turn('user', [{ type: 'text', text }]);
}

function assistantText(text: string, extras: ContentBlock[] = []): Turn {
  return turn('assistant', [{ type: 'text', text }, ...extras]);
}

// ── Baseline + precedence ───────────────────────────────────────────

describe('classifyTurn — baseline + precedence', () => {
  test('tool_result beats everything when tool_use block present', () => {
    const t = assistantText("I'll use Option A", [
      { type: 'tool_use', id: 'tu-1', name: 'read_file', input: { path: '/tmp/a' } },
    ]);
    expect(classifyTurn(t)).toBe('tool_result');
  });

  test('tool_result beats everything when tool_result block present', () => {
    const t = turn('user', [
      { type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' },
    ]);
    expect(classifyTurn(t)).toBe('tool_result');
  });

  test('tool_result beats everything when thinking block present', () => {
    const t = assistantText("I'll use Option A", [
      { type: 'thinking', thinking: 'reasoning here' },
    ]);
    expect(classifyTurn(t)).toBe('tool_result');
  });

  test('clarification dominates decision when both signals present', () => {
    const t = assistantText("I'll go with Option A\n[INPUT-REQUIRED]\n- which branch?");
    expect(classifyTurn(t)).toBe('clarification');
  });

  test('empty text → normal', () => {
    expect(classifyTurn(userText(''))).toBe('normal');
  });

  test('turn with only empty text block → normal', () => {
    expect(classifyTurn(turn('user', [{ type: 'text', text: '' }]))).toBe('normal');
  });

  test('turn with zero blocks → normal', () => {
    expect(classifyTurn(turn('user', []))).toBe('normal');
  });
});

// ── Decision signals — EN ───────────────────────────────────────────

describe('classifyTurn — EN decision signals', () => {
  test("assistant plan preamble `I'll` → decision (+2)", () => {
    expect(classifyTurn(assistantText("I'll refactor the auth module"))).toBe('decision');
  });

  test("assistant plan preamble `Let me` → decision (+2)", () => {
    expect(classifyTurn(assistantText('Let me run the tests first'))).toBe('decision');
  });

  test("assistant plan preamble `Plan:` → decision (+2)", () => {
    expect(classifyTurn(assistantText('Plan: extract helper, add tests, push'))).toBe('decision');
  });

  test("assistant plan preamble `Going to` → decision (+2)", () => {
    expect(classifyTurn(assistantText('Going to merge the conflicts now'))).toBe('decision');
  });

  test('user "use X" alone does NOT fire (score=1)', () => {
    // Single verb hit without negation/TH companion stays below threshold.
    expect(classifyTurn(userText('use Postgres'))).toBe('normal');
  });

  test('negation + alternative fires decision (score=2)', () => {
    expect(classifyTurn(userText("not use MySQL, use Postgres instead"))).toBe('decision');
  });

  test('user EN verb alone without negation/TH stays normal (score=1)', () => {
    // `regex.match` returns a single occurrence — "actually" and "use" in
    // the same text still contribute only +1 (one EN-verb hit), so without
    // a companion signal (negation+alternative, or Thai co-occurrence) the
    // turn stays below the decision threshold. This matches feature/main.
    expect(classifyTurn(userText("actually, let's use Postgres"))).toBe('normal');
  });
});

// ── Decision signals — TH ───────────────────────────────────────────

describe('classifyTurn — TH decision signals', () => {
  test('pure Thai ไม่ใช่ + ใช้ alternative fires decision', () => {
    expect(classifyTurn(userText('ไม่ใช่ MySQL ใช้ Postgres แทน'))).toBe('decision');
  });

  test('pure Thai ไม่เอา + เอา alternative fires decision', () => {
    expect(classifyTurn(userText('ไม่เอาของเดิม เอาของใหม่'))).toBe('decision');
  });

  test('Thai "เลือก X" alone stays normal (score=1)', () => {
    expect(classifyTurn(userText('เลือก Postgres'))).toBe('normal');
  });

  test('mixed EN+TH: "actually ใช้ Postgres" fires decision', () => {
    expect(classifyTurn(userText('actually ใช้ Postgres'))).toBe('decision');
  });

  test('Thai decision verb at position 0 still matches (no word-boundary bug)', () => {
    // Regression guard: if \b were applied to Thai chars the match would fail
    expect(classifyTurn(userText('ใช้ Postgres instead of MySQL'))).toBe('decision');
  });
});

// ── Adversarial suppressors ────────────────────────────────────────

describe('classifyTurn — false-positive guards', () => {
  test('"use case" does NOT fire decision', () => {
    expect(classifyTurn(userText('main use case is auth'))).toBe('normal');
    expect(classifyTurn(userText('the use cases are: a, b, c'))).toBe('normal');
  });

  test('doc quote (leading `> `) suppresses decision', () => {
    expect(classifyTurn(userText("> I'll use Postgres (quoted spec)"))).toBe('normal');
  });

  test('fenced code block (leading ```) suppresses decision', () => {
    expect(classifyTurn(userText("```\nI'll use Postgres\n```"))).toBe('normal');
  });

  test('"user" noun substring does NOT trip decision verb match', () => {
    expect(classifyTurn(userText('the user wants to pick one'))).toBe('normal');
  });

  test('out-of-scope decision verbs past 120 chars do NOT fire', () => {
    const filler = 'x'.repeat(125);
    expect(classifyTurn(userText(`${filler} use Postgres`))).toBe('normal');
  });
});

// ── Clarification signals ─────────────────────────────────────────

describe('classifyTurn — clarification signals', () => {
  test('[INPUT-REQUIRED] tag → clarification', () => {
    expect(classifyTurn(assistantText('[INPUT-REQUIRED]\n- which DB?'))).toBe('clarification');
  });

  test('needsUserInput JSON → clarification', () => {
    expect(classifyTurn(userText('{"needsUserInput": true, "reason": "x"}'))).toBe('clarification');
  });

  test('plain prose without tags → not clarification', () => {
    expect(classifyTurn(userText('what do you think we should do?'))).toBe('normal');
  });
});

// ── precededByInputRequired shortcut ───────────────────────────────

describe('classifyTurn — precededByInputRequired hint', () => {
  test('user reply to IR → decision via zero-regex shortcut', () => {
    expect(
      classifyTurn(userText('Postgres'), { precededByInputRequired: true }),
    ).toBe('decision');
  });

  test('assistant reply with hint does NOT trip (role gate)', () => {
    // The hint only elevates user turns; an assistant following an IR block
    // is not a decision by construction.
    expect(
      classifyTurn(assistantText('hmm'), { precededByInputRequired: true }),
    ).toBe('normal');
  });

  test('hint does not override tool_result precedence', () => {
    const t = turn('user', [
      { type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' },
    ]);
    expect(classifyTurn(t, { precededByInputRequired: true })).toBe('tool_result');
  });

  test('hint does not override clarification precedence', () => {
    expect(
      classifyTurn(userText('[INPUT-REQUIRED]'), { precededByInputRequired: true }),
    ).toBe('clarification');
  });
});

// ── Flattening multi-block turns ──────────────────────────────────

describe('classifyTurn — block-flatten semantics', () => {
  test('multi-text-block turn flattens visible text for regex matching', () => {
    // First block short + second block starts within the first-120-char
    // head. The Thai negation+alternative match requires signals within
    // one line (regex `.` excludes \n), so each block is matched
    // independently — this test verifies flatten happens, not that
    // signals compose across blocks.
    const t = turn('user', [
      { type: 'text', text: 'short lead.' },
      { type: 'text', text: 'ไม่ใช่ MySQL ใช้ Postgres' },
    ]);
    // `ไม่ใช่` + `.{0,30}` + `ใช้` all fire on the second block alone,
    // giving +1 from the TH verb and +1 from negation-alt → decision.
    expect(classifyTurn(t)).toBe('decision');
  });

  test('thinking-only turn classifies as tool_result', () => {
    const t = turn('assistant', [{ type: 'thinking', thinking: 'planning' }]);
    expect(classifyTurn(t)).toBe('tool_result');
  });
});

// ── Determinism ───────────────────────────────────────────────────

describe('classifyTurn — determinism', () => {
  test('same input yields same output across 50 invocations', () => {
    const t = assistantText("I'll go with Postgres");
    const first = classifyTurn(t);
    for (let i = 0; i < 49; i++) {
      expect(classifyTurn(t)).toBe(first);
    }
  });

  test('input is not mutated', () => {
    const t = userText('actually, use Postgres');
    const originalBlocks = [...t.blocks];
    classifyTurn(t);
    expect(t.blocks).toEqual(originalBlocks);
  });
});
