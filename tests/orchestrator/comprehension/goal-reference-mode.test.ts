/**
 * goalReferenceMode classification tests.
 *
 * Pins the deterministic surface-structure signal added in Phase 1 of the
 * pre-rule false-activation fix. The classifier lives inside
 * `src/orchestrator/comprehension/rule-comprehender.ts` and is a generic
 * "is the user instructing this or referring to it?" predicate consumed by
 * EVERY surface-pattern pre-rule in `composeDeterministicCandidate`.
 *
 * Why the tests live in `tests/orchestrator/comprehension/` and not in
 * `intent/`: the field is published on the comprehension envelope and
 * verified by the comprehension oracle. Pre-rule consumers only READ it.
 *
 * The contract:
 *   - 'direct'   — the prompt is an instruction; pre-rules fire normally
 *   - 'meta'     — the prompt discusses / quotes / frames system behaviour;
 *                  pre-rules MUST yield to STU classification
 *   - 'unknown'  — mixed signals; pre-rules fire at reduced confidence so
 *                  the LLM advisor gets a vote via the merge layer
 */

import { describe, expect, test } from 'bun:test';
import {
  classifyGoalReferenceMode,
  newRuleComprehender,
} from '../../../src/orchestrator/comprehension/rule-comprehender.ts';
import { ComprehendedTaskMessageSchema } from '../../../src/orchestrator/comprehension/types.ts';
import type { TaskInput } from '../../../src/orchestrator/types.ts';

function makeInput(goal: string) {
  const input: TaskInput = {
    id: 't-1',
    source: 'api',
    goal,
    taskType: 'reasoning',
    budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 1 },
  };
  return { input, history: [], pendingQuestions: [], rootGoal: null };
}

describe('classifyGoalReferenceMode — direct execution prompts', () => {
  // These prompts are the canonical execution requests. The pre-rules
  // (multi-agent delegation, creative-deliverable) MUST keep firing on
  // them — anything else regresses the green path the user explicitly
  // called out as "must keep working".

  test.each([
    'แบ่ง Agent 3ตัว แข่งกันถามตอบ',
    'แบ่ง Agent 3ตัว แข่งกันถามตอบ และเพิ่มกระบวนการโต้แย้งกันเองได้อีก 2รอบ',
    'have 3 agents debate the merits of microservices',
    'have 3 agents compete and pick a winner',
    'เขียนนิยายสัก 2 บท',
    'write me a 2-chapter bedtime story',
    'have 3 agents review the parser code', // critical false-positive guard
    'split this into multiple agents and let them compete',
  ])('classifies "%s" as direct', (goal) => {
    expect(classifyGoalReferenceMode(goal)).toBe('direct');
  });
});

describe('classifyGoalReferenceMode — meta / reference prompts', () => {
  // These prompts STRUCTURALLY cannot be execution requests. The pre-rules
  // MUST fall through to STU classification — otherwise `composeDeterministicCandidate`
  // forces agentic-workflow + (for multi-agent) attaches a CollaborationDirective,
  // and the collaboration runner dispatches LLM agents to debate the user's
  // META question. That is the live-session bug class this signal closes.

  describe('quoted spans (strongest mention signal)', () => {
    test.each([
      'ช่วยแก้ logic สำหรับ analyze user prompt เช่น "แบ่ง Agent 3ตัว แข่งกันถามตอบ"',
      'เขียน implementation plan สำหรับ prompt แบบ "แบ่ง Agent 3ตัว แข่งกันถามตอบ และเพิ่มกระบวนการโต้แย้งกันเองได้อีก 2รอบ"',
      'ทำไม prompt "have 3 agents debate" ถึงถูก route ผิด',
      'review the routing logic for prompts like "แบ่ง Agent 3ตัว แข่งกันถามตอบ"',
      // Curly double quotes (often pasted from Slack / chat)
      'อธิบายว่า prompt “แบ่ง Agent 3ตัว แข่งกันถามตอบ” ถูกตีความอย่างไร',
      // Backtick code-span
      'ปรับ classifier ให้รับ prompt `have 3 agents debate` ได้ดีขึ้น',
      // CJK corner brackets
      'อธิบาย prompt 「เขียนนิยายสัก 2 บท」 ที่ classifier ตีความผิด',
    ])('classifies "%s" as meta', (goal) => {
      expect(classifyGoalReferenceMode(goal)).toBe('meta');
    });

    test('ignores apostrophes inside contractions ("don\'t")', () => {
      // The substantive-quote threshold (≥3 chars) prevents single-quote
      // apostrophes from triggering a false meta classification on natural
      // English prose.
      expect(classifyGoalReferenceMode("don't write a chapter")).toBe('direct');
    });
  });

  describe('example-framing vocabulary in prompt', () => {
    test.each([
      'create a creative writing prompt, for example have 3 agents debate microservices',
      'fix prompts such as เขียนนิยายสัก 2 บท',
      'classifier should handle prompt แบบ have 3 agents debate',
      'router แต่ละแบบ เช่น แบ่ง Agent 3ตัว',
    ])('classifies "%s" as meta', (goal) => {
      expect(classifyGoalReferenceMode(goal)).toBe('meta');
    });
  });

  describe('meta-verb + system-noun in prefix', () => {
    test.each([
      'ออกแบบ parser ให้รองรับ have 3 agents debate',
      'fix the parser to handle have 3 agents debate',
      'review the routing logic for the multi-agent path',
      'แก้ logic สำหรับ analyze user prompt',
      'design the classifier so it splits multi-agent properly',
    ])('classifies "%s" as meta', (goal) => {
      expect(classifyGoalReferenceMode(goal)).toBe('meta');
    });
  });
});

describe('classifyGoalReferenceMode — unknown (mixed signals)', () => {
  // 'unknown' is reserved for prompts that mention system internals
  // without a strong meta-verb anchor — the user might be reporting an
  // issue, asking for help, or just describing context. Pre-rules still
  // fire but at reduced confidence so the LLM advisor weighs in.
  test.each([
    'parser is broken',
    'routing เพี้ยน',
    'classifier behavior',
  ])('classifies "%s" as unknown', (goal) => {
    expect(classifyGoalReferenceMode(goal)).toBe('unknown');
  });

  test('empty / whitespace-only goal is unknown', () => {
    expect(classifyGoalReferenceMode('')).toBe('unknown');
    expect(classifyGoalReferenceMode('   ')).toBe('unknown');
  });
});

describe('classifyGoalReferenceMode — position-gated meta detection', () => {
  // The hardest contract: the SAME meta vocabulary is meta in the prefix
  // but is part of the agents' task when it follows the execution verb.
  // Without position-gating, the gate misfires on legitimate code-review
  // delegations.

  test('meta verb AFTER execution verb stays direct', () => {
    expect(classifyGoalReferenceMode('have 3 agents review the parser code')).toBe('direct');
    expect(classifyGoalReferenceMode('let agents review the routing logic')).toBe('direct');
    expect(classifyGoalReferenceMode('write a chapter analyzing the parser')).toBe('direct');
  });

  test('meta verb BEFORE execution verb is meta', () => {
    expect(classifyGoalReferenceMode('review the parser; have 3 agents debate')).toBe('meta');
    expect(classifyGoalReferenceMode('design the routing and have 3 agents test it')).toBe('meta');
  });
});

describe('rule-comprehender — emits goalReferenceMode on the envelope', () => {
  test('direct goal → state.goalReferenceMode === "direct"', async () => {
    const eng = newRuleComprehender(() => 1_700_000_000_000);
    const out = await eng.comprehend(makeInput('แบ่ง Agent 3ตัว แข่งกันถามตอบ'));

    ComprehendedTaskMessageSchema.parse(out);
    expect(out.params.data?.state.goalReferenceMode).toBe('direct');
  });

  test('meta goal → state.goalReferenceMode === "meta" + evidence entry', async () => {
    const eng = newRuleComprehender();
    const out = await eng.comprehend(
      makeInput(
        'ช่วยแก้ logic สำหรับ analyze user prompt เช่น "แบ่ง Agent 3ตัว แข่งกันถามตอบ"',
      ),
    );

    ComprehendedTaskMessageSchema.parse(out);
    expect(out.params.data?.state.goalReferenceMode).toBe('meta');
    const sources = out.params.evidence_chain.map((e) => e.source);
    expect(sources).toContain('rule:goal-reference-mode');
  });

  test('unknown goal → state.goalReferenceMode === "unknown" + evidence entry', async () => {
    const eng = newRuleComprehender();
    const out = await eng.comprehend(makeInput('parser is broken'));

    ComprehendedTaskMessageSchema.parse(out);
    expect(out.params.data?.state.goalReferenceMode).toBe('unknown');
    const sources = out.params.evidence_chain.map((e) => e.source);
    expect(sources).toContain('rule:goal-reference-mode');
  });

  test('direct goal does NOT emit a goal-reference-mode evidence entry', () => {
    // We only emit evidence when the classification is non-default. Direct
    // is the green path — adding a noise evidence entry on every prompt
    // would dominate the chain.
    const eng = newRuleComprehender();
    return eng.comprehend(makeInput('have 3 agents debate microservices')).then((out) => {
      const sources = out.params.evidence_chain.map((e) => e.source);
      expect(sources).not.toContain('rule:goal-reference-mode');
    });
  });
});
