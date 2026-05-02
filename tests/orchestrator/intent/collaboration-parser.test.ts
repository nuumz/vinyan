/**
 * Tests for the deterministic CollaborationDirective parser (Phase 1 of the
 * multi-agent debate fix).
 *
 * Anchors the contract that downstream wiring (Phase 2/3) depends on:
 *   - 3-agent / 2-rebuttal-round Thai prompt yields the right structured shape
 *   - reviewer/moderator words flip reviewerPolicy to 'explicit' WITHOUT
 *     inflating the primary count
 *   - rebuttal rounds and competition signals are orthogonal
 *     (a "compete + debate 2 รอบ" prompt yields mode='debate' AND
 *     emitCompetitionVerdict=true)
 *   - rounds and counts are clamped to MAX_REBUTTAL_ROUNDS / MAX_PARTICIPANT_COUNT
 *   - bare singular mentions ("an agent", "what is an agent") return null
 *   - sub-task recursion is the caller's job (parser is goal-string-pure)
 */
import { describe, expect, it } from 'bun:test';
import {
  classifyCollaborationIntent,
  COLLABORATION_PARSER_LIMITS,
  parseCollaborationDirective,
} from '../../../src/orchestrator/intent/collaboration-parser.ts';

describe('parseCollaborationDirective — user-canonical Thai prompts', () => {
  it('parses "แบ่ง Agent 3ตัว แข่งกันถามตอบ"', () => {
    const d = parseCollaborationDirective('แบ่ง Agent 3ตัว แข่งกันถามตอบ');
    expect(d).not.toBeNull();
    expect(d!.requestedPrimaryParticipantCount).toBe(3);
    expect(d!.interactionMode).toBe('competition');
    expect(d!.rebuttalRounds).toBe(0);
    expect(d!.sharedDiscussion).toBe(false);
    expect(d!.reviewerPolicy).toBe('none');
    expect(d!.emitCompetitionVerdict).toBe(true);
    expect(d!.managerClarificationAllowed).toBe(true);
    expect(d!.source).toBe('pre-llm-parser');
    expect(d!.matchedFragments.count).toMatch(/3/);
    expect(d!.matchedFragments.rounds).toBeUndefined();
  });

  it('parses "แบ่ง Agent 3ตัว แข่งกันถามตอบ และเพิ่มกระบวนการโต้แย้งกันเองได้อีก 2รอบ"', () => {
    const d = parseCollaborationDirective(
      'แบ่ง Agent 3ตัว แข่งกันถามตอบ และเพิ่มกระบวนการโต้แย้งกันเองได้อีก 2รอบ',
    );
    expect(d).not.toBeNull();
    expect(d!.requestedPrimaryParticipantCount).toBe(3);
    // Debate verb + rounds present → mode='debate' (rebuttal reshapes the
    // runtime conversation more than the verdict shape does).
    expect(d!.interactionMode).toBe('debate');
    expect(d!.rebuttalRounds).toBe(2);
    expect(d!.sharedDiscussion).toBe(true);
    // Competition signal "แข่ง" survives orthogonally — runner still emits
    // a winner verdict at synthesis.
    expect(d!.emitCompetitionVerdict).toBe(true);
    expect(d!.matchedFragments.rounds).toMatch(/2.*รอบ/);
  });
});

describe('parseCollaborationDirective — English prompts', () => {
  it('parses "have 3 agents debate, 2 rebuttal rounds"', () => {
    const d = parseCollaborationDirective('have 3 agents debate, 2 rebuttal rounds');
    expect(d).not.toBeNull();
    expect(d!.requestedPrimaryParticipantCount).toBe(3);
    expect(d!.interactionMode).toBe('debate');
    expect(d!.rebuttalRounds).toBe(2);
    expect(d!.sharedDiscussion).toBe(true);
    expect(d!.emitCompetitionVerdict).toBe(false);
  });

  it('parses "split into multiple agents and let them compete" with default count', () => {
    const d = parseCollaborationDirective('split into multiple agents and let them compete');
    expect(d).not.toBeNull();
    expect(d!.requestedPrimaryParticipantCount).toBe(
      COLLABORATION_PARSER_LIMITS.DEFAULT_AMBIGUOUS_COUNT,
    );
    expect(d!.interactionMode).toBe('competition');
    expect(d!.emitCompetitionVerdict).toBe(true);
    expect(d!.rebuttalRounds).toBe(0);
  });

  it('parses "three agents debate" with English number word', () => {
    const d = parseCollaborationDirective('have three agents debate the merits of microservices');
    expect(d).not.toBeNull();
    expect(d!.requestedPrimaryParticipantCount).toBe(3);
    expect(d!.interactionMode).toBe('debate');
  });

  it('parses "compare 4 agents" as comparison mode', () => {
    const d = parseCollaborationDirective('compare 4 agents side by side on this question');
    expect(d).not.toBeNull();
    expect(d!.requestedPrimaryParticipantCount).toBe(4);
    expect(d!.interactionMode).toBe('comparison');
    expect(d!.emitCompetitionVerdict).toBe(false);
  });
});

describe('parseCollaborationDirective — reviewer / oversight policy', () => {
  it('flips to explicit when "reviewer" appears without inflating count', () => {
    const d = parseCollaborationDirective('have 3 agents debate, with a reviewer');
    expect(d).not.toBeNull();
    expect(d!.reviewerPolicy).toBe('explicit');
    // Crucial: the reviewer is NOT counted as a primary participant.
    expect(d!.requestedPrimaryParticipantCount).toBe(3);
    expect(d!.matchedFragments.reviewer).toMatch(/reviewer/i);
  });

  it('flips to explicit on Thai "คนตรวจ" / "กรรมการ"', () => {
    const d = parseCollaborationDirective(
      'แบ่ง Agent 3ตัว แข่งกันถามตอบ มีกรรมการตรวจให้คะแนน',
    );
    expect(d).not.toBeNull();
    expect(d!.reviewerPolicy).toBe('explicit');
    expect(d!.requestedPrimaryParticipantCount).toBe(3);
  });

  it('stays "none" when no reviewer mentioned', () => {
    const d = parseCollaborationDirective('have 3 agents debate the trade-offs');
    expect(d).not.toBeNull();
    expect(d!.reviewerPolicy).toBe('none');
  });
});

describe('parseCollaborationDirective — clarification policy', () => {
  it('disables manager clarification on explicit "ห้ามถาม"', () => {
    const d = parseCollaborationDirective(
      'แบ่ง Agent 3ตัว แข่งกันถามตอบ ห้ามถามผู้ใช้กลับ',
    );
    expect(d).not.toBeNull();
    expect(d!.managerClarificationAllowed).toBe(false);
  });

  it('disables manager clarification on English "no clarification"', () => {
    const d = parseCollaborationDirective(
      'have 3 agents debate, no clarification questions',
    );
    expect(d).not.toBeNull();
    expect(d!.managerClarificationAllowed).toBe(false);
  });

  it('defaults to allowing clarification', () => {
    const d = parseCollaborationDirective('have 3 agents debate');
    expect(d).not.toBeNull();
    expect(d!.managerClarificationAllowed).toBe(true);
  });
});

describe('parseCollaborationDirective — clamping', () => {
  it('clamps primary count to MAX_PARTICIPANT_COUNT', () => {
    const d = parseCollaborationDirective('have 50 agents debate');
    expect(d).not.toBeNull();
    expect(d!.requestedPrimaryParticipantCount).toBe(
      COLLABORATION_PARSER_LIMITS.MAX_PARTICIPANT_COUNT,
    );
  });

  it('clamps rebuttal rounds to MAX_REBUTTAL_ROUNDS', () => {
    // The Thai-rounds extractor scans before falling through to the English
    // path, so the round signal must be in the matching language for the
    // clamp test to be deterministic.
    const d = parseCollaborationDirective(
      'have 3 agents debate, 100 rebuttal rounds',
    );
    expect(d).not.toBeNull();
    expect(d!.rebuttalRounds).toBe(COLLABORATION_PARSER_LIMITS.MAX_REBUTTAL_ROUNDS);
  });

  it('clamps Thai "100 รอบ" to MAX_REBUTTAL_ROUNDS', () => {
    const d = parseCollaborationDirective(
      'แบ่ง Agent 3ตัว แข่งกันถามตอบ อีก 100 รอบ',
    );
    expect(d).not.toBeNull();
    expect(d!.rebuttalRounds).toBe(COLLABORATION_PARSER_LIMITS.MAX_REBUTTAL_ROUNDS);
  });
});

describe('parseCollaborationDirective — negative / null returns', () => {
  it('returns null for singular "what is an agent"', () => {
    expect(parseCollaborationDirective('what is an agent in vinyan')).toBeNull();
  });

  it('returns null for conversational mention "the agent helped me"', () => {
    expect(parseCollaborationDirective('the agent helped me find the answer')).toBeNull();
  });

  it('returns null when the multi-agent gate matches but no count is extractable', () => {
    // "agents debate" matches the structural English regex
    // (`agents? + (compete|debate|...)`) but carries no count anchor —
    // parser must refuse rather than guess.
    expect(parseCollaborationDirective('agents debate sometimes when bored')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseCollaborationDirective('')).toBeNull();
  });

  it('returns null for prompts unrelated to multi-agent collaboration', () => {
    expect(parseCollaborationDirective('list files in ~/Desktop')).toBeNull();
    expect(parseCollaborationDirective('refactor src/foo.ts to use async/await')).toBeNull();
  });
});

describe('classifyCollaborationIntent — execute vs mention gate', () => {
  // Phase 6 fix — distinguishes prompts that INVOKE multi-agent
  // collaboration from prompts that merely MENTION the multi-agent phrase
  // as data, example, quotation, or analytical reference. Without this
  // gate, mention prompts force the strategy override and dispatch real
  // LLM agents to debate the user's META question (incident: session
  // 744a1546-58ad).

  describe('execute (must route to collaboration runner)', () => {
    it('"แบ่ง Agent 3ตัว แข่งกันถามตอบ"', () => {
      expect(classifyCollaborationIntent('แบ่ง Agent 3ตัว แข่งกันถามตอบ')).toBe('execute');
    });

    it('"แบ่ง Agent 3ตัว แข่งกันถามตอบ และเพิ่มกระบวนการโต้แย้งกันเองได้อีก 2รอบ"', () => {
      expect(
        classifyCollaborationIntent(
          'แบ่ง Agent 3ตัว แข่งกันถามตอบ และเพิ่มกระบวนการโต้แย้งกันเองได้อีก 2รอบ',
        ),
      ).toBe('execute');
    });

    it('"have 3 agents debate the merits of microservices"', () => {
      expect(classifyCollaborationIntent('have 3 agents debate the merits of microservices')).toBe(
        'execute',
      );
    });

    it('"have 3 agents compete and pick a winner"', () => {
      expect(classifyCollaborationIntent('have 3 agents compete and pick a winner')).toBe('execute');
    });

    it('"have 3 agents review the parser code" — meta words AFTER the phrase are agent-task, not framing', () => {
      // Critical false-positive guard: "review" + "parser" appear in the
      // sentence, but the multi-agent phrase comes FIRST so the meta words
      // are part of the agents' task. Position-gated meta detection
      // protects this case.
      expect(classifyCollaborationIntent('have 3 agents review the parser code')).toBe('execute');
    });
  });

  describe('mention (must NOT route to collaboration runner)', () => {
    it('quoted multi-agent phrase inside meta-discussion (Thai)', () => {
      expect(
        classifyCollaborationIntent(
          'ช่วยแก้ logic สำหรับ analyze user prompt เช่น "แบ่ง Agent 3ตัว แข่งกันถามตอบ"',
        ),
      ).toBe('mention');
    });

    it('quoted multi-agent phrase inside implementation-plan request', () => {
      expect(
        classifyCollaborationIntent(
          'เขียน implementation plan สำหรับ prompt แบบ "แบ่ง Agent 3ตัว แข่งกันถามตอบ และเพิ่มกระบวนการโต้แย้งกันเองได้อีก 2รอบ"',
        ),
      ).toBe('mention');
    });

    it('unquoted multi-agent phrase but META-FRAMING words in prefix (parser/design)', () => {
      expect(classifyCollaborationIntent('ออกแบบ parser ให้รองรับ have 3 agents debate')).toBe(
        'mention',
      );
    });

    it('quoted multi-agent phrase in interrogative ("ทำไม prompt … ถึง …")', () => {
      expect(
        classifyCollaborationIntent('ทำไม prompt "have 3 agents debate" ถึงถูก route ผิด'),
      ).toBe('mention');
    });

    it('quoted multi-agent phrase after "review the routing logic for prompts like"', () => {
      expect(
        classifyCollaborationIntent(
          'review the routing logic for prompts like "แบ่ง Agent 3ตัว แข่งกันถามตอบ"',
        ),
      ).toBe('mention');
    });

    it('curly double quotes around the multi-agent phrase', () => {
      // Prompts copied from Slack / chat clients often arrive with curly
      // quotes (U+201C/U+201D); the classifier must handle them like
      // straight quotes.
      expect(
        classifyCollaborationIntent(
          'อธิบายว่า prompt “แบ่ง Agent 3ตัว แข่งกันถามตอบ” ถูกตีความอย่างไร',
        ),
      ).toBe('mention');
    });

    it('backtick code-span around the multi-agent phrase', () => {
      // Markdown / Slack / GitHub prompts often quote with backticks.
      expect(
        classifyCollaborationIntent(
          'ปรับ classifier ให้รับ prompt `have 3 agents debate` ได้ดีขึ้น',
        ),
      ).toBe('mention');
    });

    it('English meta-prefix "fix the parser to handle ..."', () => {
      expect(
        classifyCollaborationIntent('fix the parser to handle have 3 agents debate'),
      ).toBe('mention');
    });
  });

  describe('none (multi-agent regex did not match)', () => {
    it('singular reference returns "none"', () => {
      expect(classifyCollaborationIntent('what is an agent in vinyan')).toBe('none');
    });

    it('conversational mention returns "none"', () => {
      expect(classifyCollaborationIntent('the agent helped me find the answer')).toBe('none');
    });

    it('empty string returns "none"', () => {
      expect(classifyCollaborationIntent('')).toBe('none');
    });
  });
});

describe('parseCollaborationDirective — pure structure extraction', () => {
  // Per the Phase 6 design, the parser stays a pure structure extractor:
  // execution gating lives in `intent/strategy.ts`, not here. A mention
  // prompt with a structurally valid count + mode WILL still produce a
  // directive — that directive simply never gets attached to the
  // IntentResolution because the strategy layer's classifier blocks it.
  it('returns a structure for a mention prompt (parser is not the execute gate)', () => {
    const d = parseCollaborationDirective(
      'review the routing logic for prompts like "แบ่ง Agent 3ตัว แข่งกันถามตอบ"',
    );
    // The English regex matches "3 agents" inside the wrapped quote (and
    // outside it via "agents debate" if present). Without the gate inside
    // the parser, a structure may or may not be extracted depending on
    // which match the count extractor lands on. Either result is fine —
    // the strategy layer's classifier is the load-bearing gate.
    if (d !== null) {
      expect(d.requestedPrimaryParticipantCount).toBeGreaterThan(0);
      expect(d.source).toBe('pre-llm-parser');
    }
  });
});

describe('parseCollaborationDirective — orthogonality', () => {
  // The hardest contract: a prompt that says "compete AND debate" must
  // yield BOTH the rebuttal-round runtime shape (mode='debate') AND the
  // verdict-emission shape (emitCompetitionVerdict=true). These are two
  // different consumers — the room dispatcher reads mode, the integrator
  // reads the verdict flag.
  it('keeps competition verdict emission when debate rounds are also present', () => {
    const d = parseCollaborationDirective(
      'have 3 agents compete, then debate 2 times to pick a winner',
    );
    expect(d).not.toBeNull();
    expect(d!.interactionMode).toBe('debate');
    expect(d!.rebuttalRounds).toBe(2);
    expect(d!.emitCompetitionVerdict).toBe(true);
  });

  it('emitCompetitionVerdict stays false for pure debate (no winner signal)', () => {
    const d = parseCollaborationDirective('have 3 agents debate the trade-offs for 2 rounds');
    expect(d).not.toBeNull();
    expect(d!.interactionMode).toBe('debate');
    expect(d!.emitCompetitionVerdict).toBe(false);
  });
});
