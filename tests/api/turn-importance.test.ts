/**
 * Turn-importance classifier tests — Phase 1 (long-session memory).
 *
 * Covers:
 *  - signal-scoring determinism (same input → same output),
 *  - EN + TH decision verbs,
 *  - adversarial false-positive suppressors ("use case", doc quotes,
 *    fenced code),
 *  - assistant-plan prefix detection,
 *  - clarification + tool_result dominance,
 *  - zero-regex shortcut via the `precededByInputRequired` hint.
 *
 * These are pure unit tests over a regex/heuristic module — no DB, no LLM,
 * no filesystem. Each case is small so failures point at one signal.
 */

import { describe, expect, test } from 'bun:test';
import { type ClassifiableTurn, classifyTurn } from '../../src/api/turn-importance.ts';

function user(content: string): ClassifiableTurn {
  return { role: 'user', content };
}

function assistant(content: string, extras: Partial<ClassifiableTurn> = {}): ClassifiableTurn {
  return { role: 'assistant', content, ...extras };
}

describe('classifyTurn — baseline + precedence', () => {
  test('tool_result beats everything when toolsUsed present', () => {
    const entry = assistant("I'll use Option A", { toolsUsed: ['file_read'] });
    // Would otherwise be a decision; tools_used forces tool_result.
    expect(classifyTurn(entry)).toBe('tool_result');
  });

  test('tool_result beats everything when thinking present', () => {
    const entry = assistant('ok', { thinking: 'internal reflection body…' });
    expect(classifyTurn(entry)).toBe('tool_result');
  });

  test('empty toolsUsed array does NOT flag tool_result', () => {
    const entry = assistant('hello', { toolsUsed: [] });
    expect(classifyTurn(entry)).toBe('normal');
  });

  test('null thinking does NOT flag tool_result', () => {
    const entry = assistant('hello', { thinking: null });
    expect(classifyTurn(entry)).toBe('normal');
  });

  test('clarification trumps decision when [INPUT-REQUIRED] tag is present', () => {
    const entry = assistant("I'll use Option A\n[INPUT-REQUIRED]\n- confirm?");
    expect(classifyTurn(entry)).toBe('clarification');
  });

  test('clarification detected by needsUserInput:true JSON snippet', () => {
    const entry = assistant('{"needsUserInput":true,"q":"…"}');
    expect(classifyTurn(entry)).toBe('clarification');
  });

  test('empty content is normal', () => {
    expect(classifyTurn(user(''))).toBe('normal');
  });

  test('missing content (undefined) is normal and does not throw', () => {
    const entry = { role: 'user' } as unknown as ClassifiableTurn;
    expect(classifyTurn(entry)).toBe('normal');
  });
});

describe('classifyTurn — EN decision signals', () => {
  test("assistant plan preamble 'I'll' alone earns 2 points → decision", () => {
    expect(classifyTurn(assistant("I'll refactor the db layer to use prepared statements"))).toBe('decision');
  });

  test("assistant plan preamble 'Let me' alone earns 2 points → decision", () => {
    expect(classifyTurn(assistant('Let me start by reading the config file'))).toBe('decision');
  });

  test("assistant plan preamble 'Plan:' alone earns 2 points → decision", () => {
    expect(classifyTurn(assistant('Plan: phase 1 scaffolding, phase 2 wiring'))).toBe('decision');
  });

  test("assistant plan preamble 'Going to' alone earns 2 points → decision", () => {
    expect(classifyTurn(assistant('Going to split this into two commits'))).toBe('decision');
  });

  test("user 'use X' alone is only 1 point → still normal", () => {
    // Single-signal user turns don't qualify as a decision unless paired
    // with negation+alternative or a hint flag.
    expect(classifyTurn(user('use postgres for the store'))).toBe('normal');
  });

  test("user 'not … use X' (negation + alt) earns 2 points → decision", () => {
    expect(classifyTurn(user('not redis, use postgres for the store'))).toBe('decision');
  });

  test("'scratch that … not X, use Y' (verb + negation) → decision", () => {
    expect(classifyTurn(user('scratch that — not json, use yaml'))).toBe('decision');
  });

  test("single EN verb (even multi-word 'switch to') still 1 pt → normal", () => {
    // Regex only awards 1 pt per alternation match regardless of alternative
    // phrases present. `actually, switch to vitest` → only the EN verb axis
    // fires (1 pt).
    expect(classifyTurn(user('actually, switch to vitest'))).toBe('normal');
  });

  test("'let's use X' single signal → normal (expected behaviour)", () => {
    expect(classifyTurn(user("let's use tsc strict"))).toBe('normal');
  });

  test("'choose' verb single signal → normal", () => {
    expect(classifyTurn(user('choose the second option'))).toBe('normal');
  });
});

describe('classifyTurn — TH decision signals', () => {
  test("TH verb 'ใช้' (use) alone is 1 point → normal", () => {
    expect(classifyTurn(user('ใช้ postgres ดีกว่า'))).toBe('normal');
  });

  test("TH verb 'ใช้' with EN 'not' negation earns 2 points → decision", () => {
    // Mixed-language negation is the most common real-world case and must
    // score. NEGATION_ALT's regex has `\bnot\b` on the EN alternative, and
    // allows the Thai verb to land anywhere in the 30-char tail.
    expect(classifyTurn(user('not redis, ใช้ postgres แทน'))).toBe('decision');
  });

  test("pure-TH 'ไม่ใช่ X ใช้ Y' negation+alternative → decision", () => {
    // Regression guard for the Thai word-boundary bug — pre-fix, `\b(ไม่ใช่)`
    // failed because Thai chars aren't JS word chars, so pure-TH negations
    // never scored. Post-fix, Thai alternatives are matched without leading
    // `\b` and the TH verb closes the pattern.
    expect(classifyTurn(user('ไม่ใช่ redis ใช้ postgres'))).toBe('decision');
  });

  test("pure-TH 'ไม่เอา X เอา Y' negation+alternative → decision", () => {
    // Same regression guard with the 'เอา' verb, to make sure the fix
    // applies uniformly to the Thai alternative set.
    expect(classifyTurn(user('ไม่เอา mysql เอา postgres แทน'))).toBe('decision');
  });

  test("TH 'เปลี่ยนเป็น' alone is 1 point → normal", () => {
    expect(classifyTurn(user('เปลี่ยนเป็น bun แทน'))).toBe('normal');
  });

  test('TH + EN combined (ใช้ + use) → still 1 pt per axis: EN(1) + TH(1) = 2 → decision', () => {
    // One point from EN axis, one from TH axis.
    expect(classifyTurn(user('ใช้ postgres, use the pool option'))).toBe('decision');
  });
});

describe('classifyTurn — adversarial suppressors', () => {
  test("'use case' does NOT fire the /use/ signal", () => {
    // If nothing else triggers, the output must be normal.
    expect(classifyTurn(user('can you describe the use case for this module'))).toBe('normal');
  });

  test("'use cases' (plural) does NOT fire the /use/ signal", () => {
    expect(classifyTurn(user('what are the primary use cases we need to cover'))).toBe('normal');
  });

  test('leading `> ` markdown quote suppresses decision verbs', () => {
    expect(classifyTurn(user('> use postgres for store'))).toBe('normal');
  });

  test('fenced code block suppresses decision verbs', () => {
    expect(classifyTurn(user('```\nuse strict;\n```'))).toBe('normal');
  });

  test("doc-quote 'I'll go with …' inside a `> ` quote is normal (not decision)", () => {
    // Plan preamble normally scores 2, but leading quote suppressor returns
    // early before scoring.
    expect(classifyTurn(assistant("> I'll go with option A, said the doc"))).toBe('normal');
  });

  test("word 'user' (not a verb) does NOT fire /use/ signal", () => {
    expect(classifyTurn(user('the user requested this feature'))).toBe('normal');
  });

  test('verbs outside the first 120 chars do NOT fire', () => {
    const padding = 'x'.repeat(130);
    expect(classifyTurn(user(`${padding} use postgres`))).toBe('normal');
  });
});

describe('classifyTurn — assistant plan patterns', () => {
  test("/^I'll/ preamble → decision", () => {
    expect(classifyTurn(assistant("I'll implement this as three commits"))).toBe('decision');
  });

  test("user with 'I'll' preamble: NOT treated as assistant plan (role gate)", () => {
    // The plan-preamble signal only counts for role='assistant'. A user echoing
    // the same prefix shouldn't auto-qualify.
    expect(classifyTurn(user("I'll think about it tonight"))).toBe('normal');
  });

  test('plan preamble mid-sentence does not trigger plan axis', () => {
    // `"Actually I'll …"` has 1 pt from EN verb axis ("actually") but the
    // plan preamble regex requires prefix anchor `^` — "I'll" is not at
    // position 0. Total = 1 pt → normal.
    expect(classifyTurn(assistant("Actually I'll do that tomorrow"))).toBe('normal');
    expect(classifyTurn(assistant('Looking at this, actually'))).toBe('normal');
  });
});

describe('classifyTurn — precededByInputRequired hint', () => {
  test('user turn after IR → decision (zero-regex shortcut)', () => {
    // Content would NOT flag on its own.
    expect(classifyTurn(user('postgres please'), { precededByInputRequired: true })).toBe('decision');
  });

  test('assistant turn with hint flag does NOT get the shortcut', () => {
    // Hint is user-only by construction.
    expect(classifyTurn(assistant('ok'), { precededByInputRequired: true })).toBe('normal');
  });

  test('hint is ignored when content is clarification itself', () => {
    const entry = user('[INPUT-REQUIRED]\n- confirm?');
    expect(classifyTurn(entry, { precededByInputRequired: true })).toBe('clarification');
  });

  test('hint unset falls back to regex scoring (user "postgres" alone → normal)', () => {
    expect(classifyTurn(user('postgres'), { precededByInputRequired: false })).toBe('normal');
  });
});

describe('classifyTurn — determinism / idempotency', () => {
  test('same input → same output across many invocations', () => {
    const inputs: ClassifiableTurn[] = [
      user('not redis, use postgres'),
      assistant("I'll implement this"),
      user('ใช้ postgres'),
      assistant('[INPUT-REQUIRED]\n- which db?'),
      user('normal chat turn with no signals at all'),
      assistant('ok', { toolsUsed: ['file_write'] }),
    ];
    for (const entry of inputs) {
      const first = classifyTurn(entry);
      for (let i = 0; i < 50; i++) {
        expect(classifyTurn(entry)).toBe(first);
      }
    }
  });

  test('classification does not mutate input', () => {
    const entry: ClassifiableTurn = {
      role: 'user',
      content: 'not redis, use postgres',
      toolsUsed: ['preserved'],
    };
    const snapshot = JSON.stringify(entry);
    classifyTurn(entry);
    expect(JSON.stringify(entry)).toBe(snapshot);
  });
});
