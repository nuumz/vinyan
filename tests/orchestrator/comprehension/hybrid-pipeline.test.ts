/**
 * Tests the A5 merge in isolation on the engine+oracle level — simulates
 * the pipeline stage-2 decision logic without the full core-loop harness.
 *
 * What's locked:
 *   - Stage 2 runs only when rule stage 1 flagged ambiguous referents.
 *   - Merged envelope carries the LOWER tier (probabilistic).
 *   - State flags (isClarificationAnswer etc.) remain the rule engine's.
 *   - Stage 2 fail-open — parse error / unknown preserves stage 1 result.
 */

import { describe, expect, test } from 'bun:test';
import { newLlmComprehender } from '../../../src/orchestrator/comprehension/llm-comprehender.ts';
import { mergeComprehensions } from '../../../src/orchestrator/comprehension/merge.ts';
import { newRuleComprehender } from '../../../src/orchestrator/comprehension/rule-comprehender.ts';
import type { ComprehensionInput } from '../../../src/orchestrator/comprehension/types.ts';
import { verifyComprehension } from '../../../src/oracle/comprehension/index.ts';
import type { LLMProvider, TaskInput } from '../../../src/orchestrator/types.ts';

function provider(content: string): LLMProvider {
  return {
    id: 'mock',
    tier: 'balanced',
    async generate() {
      return {
        content,
        toolCalls: [],
        tokensUsed: { input: 50, output: 25 },
        model: 'mock',
        stopReason: 'end_turn',
      };
    },
  };
}

function makeInput(overrides: {
  goal: string;
  rootGoal?: string | null;
  pending?: string[];
  history?: ComprehensionInput['history'];
}): ComprehensionInput {
  const task: TaskInput = {
    id: 't',
    source: 'api',
    goal: overrides.goal,
    taskType: 'reasoning',
    sessionId: 's',
    budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 1 },
  };
  return {
    input: task,
    history: overrides.history ?? [],
    pendingQuestions: overrides.pending ?? [],
    rootGoal: overrides.rootGoal ?? null,
  };
}

describe('hybrid pipeline — stage 1 + stage 2 merge', () => {
  test('ambiguous user reply: rule flags ambiguity, LLM enriches resolvedGoal', async () => {
    const s1Engine = newRuleComprehender();
    const input = makeInput({
      goal: 'ok',
      history: [
        {
          role: 'user',
          content: 'write a bedtime story',
          taskId: 't-0',
          timestamp: 1,
          tokenEstimate: 4,
        },
      ],
    });
    const s1 = await s1Engine.comprehend(input);
    // Rule engine flags "ok" as ambiguous → stage 2 should run.
    expect(s1.params.data?.state.hasAmbiguousReferents).toBe(true);

    const llm = newLlmComprehender({
      provider: provider(
        JSON.stringify({
          resolvedGoal: 'write a bedtime story',
          priorContextSummary: 'The user confirmed they want the bedtime story from earlier.',
          confidence: 0.6,
          reasoning: 'Short "ok" anchors to prior request.',
        }),
      ),
    });
    const s2 = await llm.comprehend(input);
    const s2Verdict = verifyComprehension({
      message: s2,
      history: input.history,
      pendingQuestions: input.pendingQuestions,
      engineType: 'llm',
    });
    expect(s2Verdict.verified).toBe(true);

    const merged = mergeComprehensions(s1, s2);
    expect(merged.s2Contributed).toBe(true);
    // A5: conservative tier wins.
    expect(merged.envelope.params.tier).toBe('probabilistic');
    // Stage-1 state flag preserved.
    expect(merged.envelope.params.data?.state.hasAmbiguousReferents).toBe(true);
    // Enrichment: resolvedGoal got the LLM's anchoring (s1 couldn't anchor on plain "ok").
    expect(merged.envelope.params.data?.resolvedGoal).toBe('write a bedtime story');
    // priorContextSummary enriched with LLM prose.
    expect(merged.envelope.params.data?.priorContextSummary.length).toBeGreaterThan(40);
  });

  test('LLM returns unknown → merge keeps stage-1 alone', async () => {
    const s1Engine = newRuleComprehender();
    const input = makeInput({ goal: 'ok' });
    const s1 = await s1Engine.comprehend(input);

    const llm = newLlmComprehender({ provider: provider('unparseable garbage') });
    const s2 = await llm.comprehend(input);
    expect(s2.params.type).toBe('unknown');

    const merged = mergeComprehensions(s1, s2);
    expect(merged.s2Contributed).toBe(false);
    expect(merged.declineReason).toBe('s2-unknown');
    expect(merged.envelope).toBe(s1);
  });

  test('stage 1 succeeds with no ambiguity → hybrid would skip stage 2 entirely', async () => {
    const s1Engine = newRuleComprehender();
    const input = makeInput({ goal: 'write a detailed essay about climate change' });
    const s1 = await s1Engine.comprehend(input);
    // Substantive goal → no ambiguity → stage 2 wouldn't run in the pipeline.
    expect(s1.params.data?.state.hasAmbiguousReferents).toBe(false);
    expect(s1.params.tier).toBe('deterministic');
  });

  test('stage-2 LLM claiming deterministic tier is rejected by oracle (AXM#1 + P2.C)', async () => {
    const input = makeInput({
      goal: 'ok',
      history: [
        {
          role: 'user',
          content: 'please write a bedtime story for my niece',
          taskId: 't-0',
          timestamp: 1,
          tokenEstimate: 7,
        },
      ],
    });
    // LLM returns a grounded resolvedGoal (appears in history).
    const llm = newLlmComprehender({
      provider: provider(
        JSON.stringify({
          resolvedGoal: 'write a bedtime story for my niece',
          priorContextSummary: 'prior bedtime story request',
          confidence: 0.99,
          reasoning: 'anchors to the earlier bedtime-story request',
        }),
      ),
    });
    const env = await llm.comprehend(input);
    // The engine honestly declares probabilistic — groundedness check passes.
    const okVerdict = verifyComprehension({
      message: env,
      history: input.history,
      pendingQuestions: input.pendingQuestions,
      engineType: 'llm',
    });
    expect(okVerdict.verified).toBe(true);

    // Tamper: simulate a compromised engine that reports deterministic.
    const tampered = {
      ...env,
      params: { ...env.params, tier: 'deterministic' as const, confidence: 1 },
    };
    const rejectVerdict = verifyComprehension({
      message: tampered,
      history: input.history,
      pendingQuestions: input.pendingQuestions,
      engineType: 'llm',
    });
    expect(rejectVerdict.verified).toBe(false);
    expect(rejectVerdict.rejectReason).toContain('llm');
  });
});
