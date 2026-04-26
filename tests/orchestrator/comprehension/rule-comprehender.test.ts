/**
 * Tests for the deterministic stage-1 comprehender.
 *
 * Covers: clarification-answer detection, root-goal anchoring, new-topic vs
 * follow-up, ambiguous-referent flagging, evidence-chain preservation,
 * `type: 'unknown'` on empty input, ECP-envelope validity.
 */

import { describe, expect, test } from 'bun:test';
import { newRuleComprehender } from '../../../src/orchestrator/comprehension/rule-comprehender.ts';
import {
  ComprehendedTaskMessageSchema,
} from '../../../src/orchestrator/comprehension/types.ts';
import type { Turn, TaskInput } from '../../../src/orchestrator/types.ts';

function makeInput(overrides: {
  goal: string;
  sessionId?: string;
  history?: Turn[];
  pendingQuestions?: string[];
  rootGoal?: string | null;
}) {
  const input: TaskInput = {
    id: 't-1',
    source: 'api',
    goal: overrides.goal,
    taskType: 'reasoning',
    sessionId: overrides.sessionId,
    budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 1 },
  };
  return {
    input,
    history: overrides.history ?? [],
    pendingQuestions: overrides.pendingQuestions ?? [],
    rootGoal: overrides.rootGoal ?? null,
  };
}

describe('RuleComprehender', () => {
  test('fresh session with substantial goal → isNewTopic=true, not clarification, deterministic', async () => {
    const eng = newRuleComprehender(() => 1_700_000_000_000);
    const out = await eng.comprehend(
      makeInput({ goal: 'ช่วยแต่งนิยายก่อนนอนให้สักเรื่อง' }),
    );

    // Envelope validates against the Zod schema.
    ComprehendedTaskMessageSchema.parse(out);

    expect(out.params.type).toBe('comprehension');
    expect(out.params.tier).toBe('deterministic');
    expect(out.params.data?.state.isNewTopic).toBe(true);
    expect(out.params.data?.state.isClarificationAnswer).toBe(false);
    expect(out.params.data?.state.isFollowUp).toBe(false);
    expect(out.params.data?.state.hasAmbiguousReferents).toBe(false);
    // Working goal is the literal for a fresh non-anchored turn.
    expect(out.params.data?.resolvedGoal).toBe('ช่วยแต่งนิยายก่อนนอนให้สักเรื่อง');
    // falsifiable_by lists actionable falsifiers.
    expect(out.params.falsifiable_by.length).toBeGreaterThan(0);
  });

  test('clarification-answer preserves rootGoal as resolvedGoal', async () => {
    const eng = newRuleComprehender();
    const history: Turn[] = [
      { id: 't-0-1', sessionId: 's', seq: 0, role: 'user', blocks: [{ type: 'text', text: 'ช่วยแต่งนิยายก่อนนอน' }], tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, createdAt: 1 },
      { id: 't-0-2', sessionId: 's', seq: 0, role: 'assistant', blocks: [{ type: 'text', text: '[INPUT-REQUIRED]\n- แนวอะไร?\n- ยาวแค่ไหน?' }], tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, createdAt: 2 },
    ];
    const out = await eng.comprehend(
      makeInput({
        goal: 'โรแมนติก สั้นๆ',
        sessionId: 's-1',
        history,
        pendingQuestions: ['แนวอะไร?', 'ยาวแค่ไหน?'],
        rootGoal: 'ช่วยแต่งนิยายก่อนนอน',
      }),
    );

    expect(out.params.type).toBe('comprehension');
    expect(out.params.data?.state.isClarificationAnswer).toBe(true);
    expect(out.params.data?.state.isFollowUp).toBe(true);
    // Root-goal anchoring: downstream sees the ORIGINAL task as the goal.
    expect(out.params.data?.resolvedGoal).toBe('ช่วยแต่งนิยายก่อนนอน');
    expect(out.params.data?.literalGoal).toBe('โรแมนติก สั้นๆ');
    expect(out.params.data?.state.pendingQuestions).toEqual([
      'แนวอะไร?',
      'ยาวแค่ไหน?',
    ]);

    // Evidence chain must carry the clarification claim.
    const claims = out.params.evidence_chain.map((e) => e.source);
    expect(claims).toContain('rule:clarification-detector');
    expect(claims).toContain('rule:goal-anchor');
  });

  test('short ack ("ok") with no root goal → heuristic tier + hasAmbiguousReferents', async () => {
    const eng = newRuleComprehender();
    const out = await eng.comprehend(
      makeInput({
        goal: 'ok',
        history: [
          { id: 't-0-1', sessionId: 's', seq: 0, role: 'user', blocks: [{ type: 'text', text: 'please review my code' }], tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, createdAt: 1 },
          { id: 't-0-2', sessionId: 's', seq: 0, role: 'assistant', blocks: [{ type: 'text', text: 'Reviewed. Want me to apply the fixes?' }], tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, createdAt: 2 },
        ],
      }),
    );

    expect(out.params.data?.state.hasAmbiguousReferents).toBe(true);
    expect(out.params.tier).toBe('heuristic');
    expect(out.params.confidence).toBeLessThan(1);
    // resolvedGoal falls back to the literal since no rootGoal supplied.
    expect(out.params.data?.resolvedGoal).toBe('ok');
  });

  test('Thai short ack ("ใช่") is detected as ambiguous', async () => {
    const eng = newRuleComprehender();
    const out = await eng.comprehend(makeInput({ goal: 'ใช่' }));
    expect(out.params.data?.state.hasAmbiguousReferents).toBe(true);
  });

  test('empty goal → type: unknown', async () => {
    const eng = newRuleComprehender();
    const out = await eng.comprehend(makeInput({ goal: '   ' }));
    expect(out.params.type).toBe('unknown');
    expect(out.params.tier).toBe('unknown');
    expect(out.params.confidence).toBe(0);
    // `data` is absent on unknown results — downstream MUST handle this.
    expect(out.params.data).toBeUndefined();
  });

  test('inputHash is stable across calls with identical input', async () => {
    const eng = newRuleComprehender(() => 1_700_000_000_000);
    const args = makeInput({
      goal: 'do the thing',
      history: [
        { id: 't-0-1', sessionId: 's', seq: 0, role: 'user', blocks: [{ type: 'text', text: 'earlier' }], tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, createdAt: 1 },
      ],
    });
    const a = await eng.comprehend(args);
    const b = await eng.comprehend(args);
    expect(a.params.inputHash).toBe(b.params.inputHash);
    expect(a.params.inputHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('inputHash changes when history changes', async () => {
    const eng = newRuleComprehender();
    const base = makeInput({ goal: 'continue', history: [] });
    const a = await eng.comprehend(base);
    const extended = makeInput({
      goal: 'continue',
      history: [
        { id: 't-0-1', sessionId: 's', seq: 0, role: 'user', blocks: [{ type: 'text', text: 'earlier turn' }], tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, createdAt: 1 },
      ],
    });
    const b = await eng.comprehend(extended);
    expect(a.params.inputHash).not.toBe(b.params.inputHash);
  });

  test('follow-up without pending clarification stays non-clarification-answer', async () => {
    const eng = newRuleComprehender();
    const history: Turn[] = [
      { id: 't-0-1', sessionId: 's', seq: 0, role: 'user', blocks: [{ type: 'text', text: 'analyze this code' }], tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, createdAt: 1 },
      { id: 't-0-2', sessionId: 's', seq: 0, role: 'assistant', blocks: [{ type: 'text', text: 'Done — looks fine.' }], tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, createdAt: 2 },
    ];
    const out = await eng.comprehend(
      makeInput({ goal: 'now add unit tests', history }),
    );
    expect(out.params.data?.state.isClarificationAnswer).toBe(false);
    expect(out.params.data?.state.isFollowUp).toBe(true);
    expect(out.params.data?.state.isNewTopic).toBe(false);
  });

  test('evidence chain entries all have confidence in [0,1]', async () => {
    const eng = newRuleComprehender();
    const out = await eng.comprehend(
      makeInput({ goal: 'test', pendingQuestions: ['a?'] }),
    );
    for (const e of out.params.evidence_chain) {
      expect(e.confidence).toBeGreaterThanOrEqual(0);
      expect(e.confidence).toBeLessThanOrEqual(1);
      expect(e.source.length).toBeGreaterThan(0);
      expect(e.claim.length).toBeGreaterThan(0);
    }
  });

  test('rootGoal is surfaced both at envelope.params and inside data.state', async () => {
    const eng = newRuleComprehender();
    const history: Turn[] = [
      { id: 't-0-1', sessionId: 's', seq: 0, role: 'user', blocks: [{ type: 'text', text: 'write a bedtime story' }], tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, createdAt: 1 },
      { id: 't-0-2', sessionId: 's', seq: 0, role: 'assistant', blocks: [{ type: 'text', text: '[INPUT-REQUIRED]\n- genre?' }], tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, createdAt: 2 },
    ];
    const out = await eng.comprehend(
      makeInput({
        goal: 'romance',
        history,
        pendingQuestions: ['genre?'],
        rootGoal: 'write a bedtime story',
      }),
    );
    // A4 audit fix: rootGoal accessible without parsing `data`.
    expect(out.params.rootGoal).toBe('write a bedtime story');
    // Mirror still present inside data.state for backwards compat.
    expect(out.params.data?.state.rootGoal).toBe('write a bedtime story');
  });

  test('rootGoal is null at envelope.params when no anchor exists', async () => {
    const eng = newRuleComprehender();
    const out = await eng.comprehend(makeInput({ goal: 'fresh topic', rootGoal: null }));
    expect(out.params.rootGoal).toBeNull();
  });

  test('priorContextSummary surfaces root goal and clarification intent', async () => {
    const eng = newRuleComprehender();
    const history: Turn[] = [
      { id: 't-0-1', sessionId: 's', seq: 0, role: 'user', blocks: [{ type: 'text', text: 'write a poem' }], tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, createdAt: 1 },
      { id: 't-0-2', sessionId: 's', seq: 0, role: 'assistant', blocks: [{ type: 'text', text: '[INPUT-REQUIRED]\n- what style?' }], tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, createdAt: 2 },
    ];
    const out = await eng.comprehend(
      makeInput({
        goal: 'haiku',
        history,
        pendingQuestions: ['what style?'],
        rootGoal: 'write a poem',
      }),
    );
    const summary = out.params.data?.priorContextSummary ?? '';
    expect(summary).toContain('Root task');
    expect(summary.toLowerCase()).toContain('clarification');
  });
});
