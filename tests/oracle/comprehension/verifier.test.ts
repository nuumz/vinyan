/**
 * Tests for the ComprehensionOracle — A1 verification of engine-proposed
 * ComprehendedTaskMessage before downstream consumption.
 */

import { describe, expect, test } from 'bun:test';
import { newRuleComprehender } from '../../../src/orchestrator/comprehension/rule-comprehender.ts';
import type {
  ComprehendedTaskMessage,
  ComprehensionInput,
} from '../../../src/orchestrator/comprehension/types.ts';
import { verifyComprehension } from '../../../src/oracle/comprehension/index.ts';
import type { Turn, TaskInput } from '../../../src/orchestrator/types.ts';

function makeInput(overrides: {
  goal: string;
  history?: Turn[];
  pendingQuestions?: string[];
  rootGoal?: string | null;
}): ComprehensionInput {
  const input: TaskInput = {
    id: 't-1',
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

async function comprehendAndVerify(args: ComprehensionInput) {
  const eng = newRuleComprehender();
  const msg = await eng.comprehend(args);
  const verdict = verifyComprehension({
    message: msg,
    history: args.history,
    pendingQuestions: args.pendingQuestions,
  });
  return { msg, verdict };
}

describe('ComprehensionOracle', () => {
  test('accepts a well-formed deterministic comprehension', async () => {
    const { verdict } = await comprehendAndVerify(
      makeInput({ goal: 'write a short poem about a river' }),
    );
    expect(verdict.verified).toBe(true);
    expect(verdict.type).toBe('known');
    expect(verdict.tier).toBe('deterministic');
    expect(verdict.rejectReason).toBeUndefined();
  });

  test('passes through type=unknown (engine honest about inability)', async () => {
    const { verdict } = await comprehendAndVerify(makeInput({ goal: '' }));
    expect(verdict.verified).toBe(true);
    expect(verdict.type).toBe('unknown');
    expect(verdict.tier).toBe('unknown');
  });

  test('accepts a clarification answer with root-goal anchoring', async () => {
    const history: Turn[] = [
      { id: 't-0-1', sessionId: 's', seq: 0, role: 'user', blocks: [{ type: 'text', text: 'write a poem' }], tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, createdAt: 1 },
      { id: 't-0-2', sessionId: 's', seq: 0, role: 'assistant', blocks: [{ type: 'text', text: '[INPUT-REQUIRED]\n- what style?' }], tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, createdAt: 2 },
    ];
    const { verdict } = await comprehendAndVerify(
      makeInput({
        goal: 'haiku',
        history,
        pendingQuestions: ['what style?'],
        rootGoal: 'write a poem',
      }),
    );
    expect(verdict.verified).toBe(true);
    expect(verdict.type).toBe('known');
  });

  test('rejects an envelope with fabricated resolvedGoal (not in session)', async () => {
    // Build a valid envelope, then tamper.
    const eng = newRuleComprehender();
    const args = makeInput({
      goal: 'simple task',
      history: [
        { id: 't-0-1', sessionId: 's', seq: 0, role: 'user', blocks: [{ type: 'text', text: 'simple task' }], tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, createdAt: 1 },
      ],
    });
    const good = await eng.comprehend(args);
    const tampered: ComprehendedTaskMessage = {
      ...good,
      params: {
        ...good.params,
        data: good.params.data
          ? {
              ...good.params.data,
              resolvedGoal: 'deploy nuclear reactor to Mars',
            }
          : undefined,
      },
    };
    const verdict = verifyComprehension({
      message: tampered,
      history: args.history,
      pendingQuestions: args.pendingQuestions,
    });
    expect(verdict.verified).toBe(false);
    expect(verdict.type).toBe('contradictory');
    expect(verdict.rejectReason).toContain('fabricated');
  });

  test('rejects when pendingQuestions mutated by engine', async () => {
    const eng = newRuleComprehender();
    const args = makeInput({
      goal: 'short answer',
      pendingQuestions: ['a?', 'b?'],
    });
    const good = await eng.comprehend(args);
    const tampered: ComprehendedTaskMessage = {
      ...good,
      params: {
        ...good.params,
        data: good.params.data
          ? {
              ...good.params.data,
              state: {
                ...good.params.data.state,
                pendingQuestions: ['a?', 'b?', 'c-fabricated?'],
              },
            }
          : undefined,
      },
    };
    const verdict = verifyComprehension({
      message: tampered,
      history: args.history,
      pendingQuestions: args.pendingQuestions,
    });
    expect(verdict.verified).toBe(false);
    expect(verdict.rejectReason).toMatch(/fabricated|mutated/i);
  });

  test('rejects when isClarificationAnswer contradicts pendingQuestions state', async () => {
    const eng = newRuleComprehender();
    const args = makeInput({ goal: 'normal goal' });
    const good = await eng.comprehend(args);
    const tampered: ComprehendedTaskMessage = {
      ...good,
      params: {
        ...good.params,
        data: good.params.data
          ? {
              ...good.params.data,
              state: {
                ...good.params.data.state,
                isClarificationAnswer: true, // claims yes, but no pending
              },
            }
          : undefined,
      },
    };
    const verdict = verifyComprehension({
      message: tampered,
      history: args.history,
      pendingQuestions: args.pendingQuestions,
    });
    expect(verdict.verified).toBe(false);
    expect(verdict.type).toBe('contradictory');
  });

  test('rejects when tier declares higher than confidence supports', async () => {
    const eng = newRuleComprehender();
    const args = makeInput({ goal: 'fine' });
    const good = await eng.comprehend(args);
    const tampered: ComprehendedTaskMessage = {
      ...good,
      params: {
        ...good.params,
        tier: 'deterministic',
        confidence: 0.3, // below the 0.9 deterministic floor
      },
    };
    const verdict = verifyComprehension({
      message: tampered,
      history: args.history,
      pendingQuestions: args.pendingQuestions,
    });
    expect(verdict.verified).toBe(false);
    expect(verdict.rejectReason).toContain('inconsistent');
  });

  test('rejects when evidence_chain is empty for a non-unknown result', async () => {
    const eng = newRuleComprehender();
    const args = makeInput({ goal: 'ok' });
    const good = await eng.comprehend(args);
    const tampered: ComprehendedTaskMessage = {
      ...good,
      params: { ...good.params, evidence_chain: [] },
    };
    const verdict = verifyComprehension({
      message: tampered,
      history: args.history,
      pendingQuestions: args.pendingQuestions,
    });
    expect(verdict.verified).toBe(false);
    expect(verdict.type).toBe('uncertain');
  });

  test('verdict carries durationMs and oracleName', async () => {
    const { verdict } = await comprehendAndVerify(makeInput({ goal: 'ok' }));
    expect(verdict.oracleName).toBe('comprehension-oracle');
    expect(typeof verdict.durationMs).toBe('number');
    expect(verdict.durationMs).toBeGreaterThanOrEqual(0);
    expect(verdict.durationMs).toBeLessThan(50); // <50ms target
  });

  // ── AXM#1: per-engine-type tier ceiling (A3/A5) ─────────────────────
  //
  // The oracle MUST NOT accept an envelope whose declared tier exceeds
  // the ceiling imposed by the engine's type. This is the main defense
  // that makes P2.C safe: an LLM engine claiming `tier: 'deterministic'`
  // is caught here, not downstream.

  describe('AXM#1: engine-type tier ceiling', () => {
    test('llm engine claiming "deterministic" is rejected', async () => {
      const eng = newRuleComprehender();
      const args = makeInput({ goal: 'something' });
      const good = await eng.comprehend(args);
      // Envelope arrives at oracle as if from an LLM engine.
      const verdict = verifyComprehension({
        message: good, // good is already deterministic + high confidence
        history: args.history,
        pendingQuestions: args.pendingQuestions,
        engineType: 'llm',
      });
      expect(verdict.verified).toBe(false);
      expect(verdict.type).toBe('contradictory');
      expect(verdict.rejectReason).toContain('llm');
      expect(verdict.rejectReason?.toLowerCase()).toContain('tier');
    });

    test('llm engine claiming "heuristic" is rejected', async () => {
      const eng = newRuleComprehender();
      // Force heuristic by giving an ambiguous goal.
      const args = makeInput({ goal: 'ok' });
      const env = await eng.comprehend(args);
      // Sanity: rule engine downgraded itself to heuristic for ambiguous input.
      expect(env.params.tier).toBe('heuristic');
      const verdict = verifyComprehension({
        message: env,
        history: args.history,
        pendingQuestions: args.pendingQuestions,
        engineType: 'llm',
      });
      expect(verdict.verified).toBe(false);
      expect(verdict.rejectReason).toMatch(/llm.*probabilistic|probabilistic/);
    });

    test('llm engine claiming "probabilistic" is accepted (within ceiling)', async () => {
      // Build a probabilistic envelope by clamping confidence low.
      const eng = newRuleComprehender();
      const args = makeInput({ goal: 'something' });
      const env = await eng.comprehend(args);
      const probEnv: ComprehendedTaskMessage = {
        ...env,
        params: { ...env.params, tier: 'probabilistic', confidence: 0.4 },
      };
      const verdict = verifyComprehension({
        message: probEnv,
        history: args.history,
        pendingQuestions: args.pendingQuestions,
        engineType: 'llm',
      });
      expect(verdict.verified).toBe(true);
      expect(verdict.tier).toBe('probabilistic');
    });

    test('rule engine claiming "deterministic" is accepted', async () => {
      const eng = newRuleComprehender();
      const args = makeInput({ goal: 'something' });
      const env = await eng.comprehend(args);
      const verdict = verifyComprehension({
        message: env,
        history: args.history,
        pendingQuestions: args.pendingQuestions,
        engineType: 'rule',
      });
      expect(verdict.verified).toBe(true);
      expect(verdict.tier).toBe('deterministic');
    });

    test('hybrid engine claiming "deterministic" is rejected (ceiling = heuristic)', async () => {
      const eng = newRuleComprehender();
      const args = makeInput({ goal: 'something' });
      const env = await eng.comprehend(args);
      const verdict = verifyComprehension({
        message: env, // deterministic
        history: args.history,
        pendingQuestions: args.pendingQuestions,
        engineType: 'hybrid',
      });
      expect(verdict.verified).toBe(false);
      expect(verdict.rejectReason).toMatch(/hybrid/);
    });

    test('omitting engineType preserves legacy behavior (trusts the tier)', async () => {
      const eng = newRuleComprehender();
      const args = makeInput({ goal: 'something' });
      const env = await eng.comprehend(args);
      const verdict = verifyComprehension({
        message: env,
        history: args.history,
        pendingQuestions: args.pendingQuestions,
        // no engineType — backwards-compat path
      });
      expect(verdict.verified).toBe(true);
    });
  });
});
