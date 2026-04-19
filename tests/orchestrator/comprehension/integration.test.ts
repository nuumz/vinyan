/**
 * E2E integration: engine → oracle → core-loop wiring → intent-resolver
 * consumes the comprehension output.
 *
 * The goal is not to re-test each component (those have their own unit
 * suites); it is to prove the TRIAD (generate / verify / commit) reaches
 * downstream consumers correctly — including the fallback path on oracle
 * rejection and the fallbackStrategy's context-aware routing when the LLM
 * is unavailable.
 */

import { describe, expect, test } from 'bun:test';
import { newRuleComprehender } from '../../../src/orchestrator/comprehension/rule-comprehender.ts';
import type {
  ComprehendedTaskMessage,
  ComprehensionInput,
} from '../../../src/orchestrator/comprehension/types.ts';
import { verifyComprehension } from '../../../src/oracle/comprehension/index.ts';
import { fallbackStrategy } from '../../../src/orchestrator/intent-resolver.ts';
import type { Turn, TaskInput } from '../../../src/orchestrator/types.ts';

function makeInput(overrides: {
  goal: string;
  history?: Turn[];
  pendingQuestions?: string[];
  rootGoal?: string | null;
}): ComprehensionInput {
  const input: TaskInput = {
    id: 'int-1',
    source: 'api',
    goal: overrides.goal,
    taskType: 'reasoning',
    budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 1 },
  };
  return {
    input,
    history: overrides.history ?? [],
    pendingQuestions: overrides.pendingQuestions ?? [],
    rootGoal: overrides.rootGoal ?? null,
  };
}

describe('Comprehension triad integration', () => {
  test('generate → verify → commit produces usable comprehension for a simple turn', async () => {
    const engine = newRuleComprehender();
    const args = makeInput({ goal: 'write a short poem' });

    const msg = await engine.comprehend(args);
    expect(msg.params.type).toBe('comprehension');

    const verdict = verifyComprehension({
      message: msg,
      history: args.history,
      pendingQuestions: args.pendingQuestions,
    });
    expect(verdict.verified).toBe(true);
    expect(verdict.type).toBe('known');
  });

  test('clarification-answer flow preserves root goal through triad', async () => {
    const engine = newRuleComprehender();
    const history: Turn[] = [
      { id: 't-0-1', sessionId: 's', seq: 0, role: 'user', blocks: [{ type: 'text', text: 'write me a bedtime story' }], tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, createdAt: 1 },
      { id: 't-0-2', sessionId: 's', seq: 0, role: 'assistant', blocks: [{ type: 'text', text: '[INPUT-REQUIRED]\n- what genre?\n- how long?' }], tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, createdAt: 2 },
    ];
    const args = makeInput({
      goal: 'romance, short',
      history,
      pendingQuestions: ['what genre?', 'how long?'],
      rootGoal: 'write me a bedtime story',
    });

    const msg = await engine.comprehend(args);
    const verdict = verifyComprehension({
      message: msg,
      history,
      pendingQuestions: args.pendingQuestions,
    });

    expect(verdict.verified).toBe(true);
    expect(msg.params.data?.state.isClarificationAnswer).toBe(true);
    // Root-goal anchoring: downstream should see the original task.
    expect(msg.params.data?.resolvedGoal).toBe('write me a bedtime story');
  });

  test('fallbackStrategy: clarification-answer preserves agentic-workflow even without LLM', () => {
    // Simulate an oracle-verified comprehension envelope that marks this turn
    // as a clarification answer.
    const msg: ComprehendedTaskMessage = {
      jsonrpc: '2.0',
      method: 'comprehension.result',
      params: {
        type: 'comprehension',
        confidence: 1,
        tier: 'deterministic',
        evidence_chain: [
          { source: 'rule:clarification-detector', claim: 'answering 2 Qs', confidence: 1 },
        ],
        falsifiable_by: [],
        temporal_context: { as_of: Date.now() },
        inputHash: 'abc',
        rootGoal: 'write me a bedtime story',
        data: {
          literalGoal: 'romance, short',
          resolvedGoal: 'write me a bedtime story',
          state: {
            isNewTopic: false,
            isClarificationAnswer: true,
            isFollowUp: true,
            hasAmbiguousReferents: false,
            pendingQuestions: ['what genre?', 'how long?'],
            rootGoal: 'write me a bedtime story',
          },
          priorContextSummary: 'Root task: write me a bedtime story',
          memoryLaneRelevance: {},
        },
      },
    };

    // Without comprehension, the short literal reply "romance, short" would
    // be classified as general-reasoning / inquire → conversational.
    const naive = fallbackStrategy('general-reasoning', 'inquire', 'none');
    expect(naive).toBe('conversational');

    // WITH comprehension, the fallback recognizes clarification-answer and
    // preserves agentic-workflow (the creative-writing thread continues).
    const contextAware = fallbackStrategy('general-reasoning', 'inquire', 'none', msg);
    expect(contextAware).toBe('agentic-workflow');
  });

  test('fallbackStrategy: non-clarification turn uses normal heuristic', () => {
    const msg: ComprehendedTaskMessage = {
      jsonrpc: '2.0',
      method: 'comprehension.result',
      params: {
        type: 'comprehension',
        confidence: 1,
        tier: 'deterministic',
        evidence_chain: [
          { source: 'rule:session-history', claim: 'no prior turns', confidence: 1 },
        ],
        falsifiable_by: [],
        temporal_context: { as_of: Date.now() },
        inputHash: 'xyz',
        rootGoal: null,
        data: {
          literalGoal: 'what is 2+2',
          resolvedGoal: 'what is 2+2',
          state: {
            isNewTopic: true,
            isClarificationAnswer: false,
            isFollowUp: false,
            hasAmbiguousReferents: false,
            pendingQuestions: [],
            rootGoal: null,
          },
          priorContextSummary: 'New conversation — no prior context.',
          memoryLaneRelevance: {},
        },
      },
    };
    // General-reasoning inquire stays conversational for fresh Q&A.
    expect(fallbackStrategy('general-reasoning', 'inquire', 'none', msg)).toBe(
      'conversational',
    );
  });

  test('unknown-type envelope is accepted by oracle (engine was honest)', async () => {
    const engine = newRuleComprehender();
    const args = makeInput({ goal: '' });
    const msg = await engine.comprehend(args);
    expect(msg.params.type).toBe('unknown');

    const verdict = verifyComprehension({
      message: msg,
      history: args.history,
      pendingQuestions: args.pendingQuestions,
    });
    expect(verdict.verified).toBe(true);
    expect(verdict.tier).toBe('unknown');
  });

  test('ECP round-trip: envelope survives JSON serialization + re-validation', async () => {
    // Audit recommendation: the envelope is marketed as ECP-compliant but
    // today never crosses a wire. This test proves the shape is stable
    // under JSON.parse(JSON.stringify(...)) and re-validates with the same
    // Zod schema — so when Phase 5 A2A delegates comprehension to a peer
    // instance, the wire format is already exercised.
    const { ComprehendedTaskMessageSchema } = await import(
      '../../../src/orchestrator/comprehension/types.ts'
    );
    const engine = newRuleComprehender();
    const original = await engine.comprehend(
      makeInput({
        goal: 'write a bedtime story',
        pendingQuestions: ['genre?', 'length?'],
        rootGoal: 'write a bedtime story',
        history: [
          { id: 't-0-1', sessionId: 's', seq: 0, role: 'user', blocks: [{ type: 'text', text: 'write a bedtime story' }], tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, createdAt: 1 },
          { id: 't-0-2', sessionId: 's', seq: 0, role: 'assistant', blocks: [{ type: 'text', text: '[INPUT-REQUIRED]\n- genre?\n- length?' }], tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, createdAt: 2 },
        ],
      }),
    );
    // Wire serialization.
    const wire = JSON.stringify(original);
    const rehydrated = JSON.parse(wire);
    // Receiving side re-validates.
    const reparsed = ComprehendedTaskMessageSchema.parse(rehydrated);
    expect(reparsed).toEqual(original);
    // The content-addressed inputHash survives unchanged (A4).
    expect(reparsed.params.inputHash).toBe(original.params.inputHash);
  });

  test('inputHash changes across turns → intent cache (keyed on hash) would invalidate', async () => {
    const engine = newRuleComprehender();

    const turn1 = await engine.comprehend(
      makeInput({ goal: 'write a poem', history: [] }),
    );

    const turn2 = await engine.comprehend(
      makeInput({
        goal: 'do it',
        history: [
          { id: 't-0-1', sessionId: 's', seq: 0, role: 'user', blocks: [{ type: 'text', text: 'write a poem' }], tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, createdAt: 1 },
        ],
      }),
    );

    // Different session state → different inputHash → intent cache (keyed on
    // `cmp::<hash>` in buildCacheKey) would NOT collide. This is the A4
    // invariant the cache-key change was designed to enforce.
    expect(turn1.params.inputHash).not.toBe(turn2.params.inputHash);
  });
});
