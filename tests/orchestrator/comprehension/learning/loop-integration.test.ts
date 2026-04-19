/**
 * Integration test for the A7 learning loop — three-turn sequence
 * (confirm, correct, confirm) validates that outcomes land in the store
 * and the calibrator reads them back with updated per-engine accuracy.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ComprehensionStore } from '../../../../src/db/comprehension-store.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../../../src/db/migrations/index.ts';
import { ComprehensionCalibrator } from '../../../../src/orchestrator/comprehension/learning/calibrator.ts';
import { detectCorrection } from '../../../../src/orchestrator/comprehension/learning/correction-detector.ts';
import { newRuleComprehender } from '../../../../src/orchestrator/comprehension/rule-comprehender.ts';
import { verifyComprehension } from '../../../../src/oracle/comprehension/index.ts';
import type { ComprehensionInput } from '../../../../src/orchestrator/comprehension/types.ts';
import type { TaskInput } from '../../../../src/orchestrator/types.ts';

let db: Database;
let store: ComprehensionStore;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  store = new ComprehensionStore(db);
});

afterEach(() => db.close());

function input(goal: string, sessionId = 's-loop'): TaskInput {
  return {
    id: `t-${goal.slice(0, 8)}`,
    source: 'api',
    goal,
    taskType: 'reasoning',
    sessionId,
    budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 1 },
  };
}

// Explicit monotonic clock so mostRecentForSession ordering is deterministic
// even when multiple turns land in the same millisecond.
let clock = 1_700_000_000_000;
function nextTick() {
  clock += 1000;
  return clock;
}

async function runTurn(args: ComprehensionInput) {
  const engine = newRuleComprehender();
  const env = await engine.comprehend(args);
  const verdict = verifyComprehension({
    message: env,
    history: args.history,
    pendingQuestions: args.pendingQuestions,
  });
  store.record({
    envelope: env,
    taskId: args.input.id,
    sessionId: args.input.sessionId,
    engineId: engine.id,
    engineType: engine.engineType,
    verdictPass: verdict.verified,
    createdAt: nextTick(),
  });
  return { env, verdict };
}

describe('A7 learning loop — 3-turn sequence', () => {
  test('confirm → corrected → confirm', () => { /* placeholder; real test below */ });

  test('closes the loop: outcome outcomes + calibrator reads calibrated accuracy', async () => {
    // ── Turn 1 ── user asks something fresh, engine comprehends.
    const t1 = input('Write a short poem');
    await runTurn({
      input: t1,
      history: [],
      pendingQuestions: [],
      rootGoal: null,
    });

    // ── Turn 2 — user continues naturally (confirms turn 1).
    // Simulate the core-loop's "mark prior outcome" step.
    {
      const prior = store.mostRecentForSession('s-loop', 1)[0]!;
      const verdict = detectCorrection({
        priorRecord: prior,
        currentUserMessage: 'now add a title to it',
        currentIsClarificationAnswer: false,
        currentIsNewTopic: false,
      });
      expect(verdict?.outcome).toBe('confirmed');
      store.markOutcome(prior.input_hash, verdict!);
    }
    const t2 = input('now add a title to it');
    await runTurn({
      input: t2,
      history: [
        { id: `${t1.id}-1`, sessionId: 's', seq: 0, role: 'user', blocks: [{ type: 'text', text: 'Write a short poem' }], tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, createdAt: 1 },
        { id: `${t1.id}-2`, sessionId: 's', seq: 0, role: 'assistant', blocks: [{ type: 'text', text: 'Here is a poem...' }], tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, createdAt: 2 },
      ],
      pendingQuestions: [],
      rootGoal: null,
    });

    // ── Turn 3 — user corrects turn 2.
    {
      const prior = store.mostRecentForSession('s-loop', 1)[0]!;
      const verdict = detectCorrection({
        priorRecord: prior,
        currentUserMessage: 'no, remove the title instead',
        currentIsClarificationAnswer: false,
        currentIsNewTopic: false,
      });
      expect(verdict?.outcome).toBe('corrected');
      store.markOutcome(prior.input_hash, verdict!);
    }
    const t3 = input('no, remove the title instead');
    await runTurn({
      input: t3,
      history: [],
      pendingQuestions: [],
      rootGoal: null,
    });

    // ── Turn 4 — user continues naturally (confirms turn 3).
    {
      const prior = store.mostRecentForSession('s-loop', 1)[0]!;
      const verdict = detectCorrection({
        priorRecord: prior,
        currentUserMessage: 'thanks',
        currentIsClarificationAnswer: false,
        currentIsNewTopic: false,
      });
      expect(verdict?.outcome).toBe('confirmed');
      store.markOutcome(prior.input_hash, verdict!);
    }

    // Three records have outcomes; one (the most recent record from
    // runTurn(t3)) is still pending (no turn-4 comprehension was run).
    const outcomes = store
      .mostRecentForSession('s-loop', 10)
      .map((r) => r.outcome);
    expect(outcomes.filter((o) => o !== null)).toHaveLength(3);

    // Calibrator sees 2 confirmed + 1 corrected → 2/3 raw accuracy.
    const calib = new ComprehensionCalibrator(store, { sampleWindow: 50 });
    const acc = calib.getEngineAccuracy('rule-comprehender');
    expect(acc.sampleSize).toBe(3);
    expect(acc.rawAccuracy).toBeCloseTo(2 / 3, 3);
  });

  test('clarification-answer turn always marks prior as confirmed', async () => {
    // Turn 1: user asks, agent asks for clarification.
    const t1 = input('write a bedtime story');
    await runTurn({
      input: t1,
      history: [],
      pendingQuestions: [],
      rootGoal: null,
    });

    // Turn 2: user replies with "no, not that" — normally a correction token.
    // But because this turn IS a clarification-answer (pendingQuestions present
    // upstream of the detector), the verdict is CONFIRMED.
    const prior = store.mostRecentForSession('s-loop', 1)[0]!;
    const verdict = detectCorrection({
      priorRecord: prior,
      currentUserMessage: 'no, romance genre actually',
      currentIsClarificationAnswer: true,
      currentIsNewTopic: false,
    });
    expect(verdict?.outcome).toBe('confirmed');
  });
});
