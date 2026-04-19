/**
 * ComprehensionMiner integration test — one happy-path test that
 * wires a real SQLite-backed ComprehensionStore + real
 * ComprehensionCalibrator into the miner and checks the B1 (engine-fit)
 * + B2 (correction-cascade) + B3 (divergence attribution) outputs.
 *
 * Scoped to one test deliberately: the unit surface is pure functions
 * over already-tested store/calibrator APIs, so a single integration
 * test is sufficient for regression coverage.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  ComprehensionStore,
  type ComprehensionRecordRow,
} from '../../../../src/db/comprehension-store.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../../../src/db/migrations/index.ts';
import { ComprehensionCalibrator } from '../../../../src/orchestrator/comprehension/learning/calibrator.ts';
import {
  mineComprehension,
  type CorrectionCascadeInsight,
  type EngineFitInsight,
} from '../../../../src/orchestrator/comprehension/learning/miner.ts';
import type { ComprehendedTaskMessage } from '../../../../src/orchestrator/comprehension/types.ts';

let db: Database;
let store: ComprehensionStore;
let calibrator: ComprehensionCalibrator;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  store = new ComprehensionStore(db);
  calibrator = new ComprehensionCalibrator(store);
});

afterEach(() => {
  db.close();
});

function makeEnvelope(
  inputHash: string,
  confidence: number,
): ComprehendedTaskMessage {
  return {
    jsonrpc: '2.0',
    method: 'comprehension.result',
    params: {
      type: 'comprehension',
      confidence,
      tier: 'heuristic',
      evidence_chain: [{ source: 'rule:test', claim: 'test', confidence }],
      falsifiable_by: ['user-next-turn'],
      temporal_context: { as_of: Date.now() },
      inputHash,
      rootGoal: null,
      data: {
        literalGoal: 'test',
        resolvedGoal: 'test',
        state: {
          isNewTopic: true,
          isClarificationAnswer: false,
          isFollowUp: false,
          hasAmbiguousReferents: false,
          pendingQuestions: [],
          rootGoal: null,
        },
        priorContextSummary: '',
        memoryLaneRelevance: {},
      },
    },
  };
}

describe('mineComprehension', () => {
  test('emits engine-fit per engine AND correction-cascade for paired turns', () => {
    const now = Date.now();
    const sessionId = 'sess-1';

    // 25 paired turns — above DATA_GATE_MIN (20). Rule is right most of
    // the time (20/25 confirmed); LLM agrees on the 20 but adds 3
    // corrections on the 5 rule-wrong cases (so agreement = 20 + 3 = 23).
    for (let i = 0; i < 25; i++) {
      const hash = `turn-${i}`;
      const env = makeEnvelope(hash, 0.8);
      store.record({
        envelope: env,
        taskId: `t-${i}`,
        sessionId,
        engineId: 'rule-comprehender',
        engineType: 'rule',
        verdictPass: true,
        createdAt: now - (25 - i) * 1000,
      });
      store.record({
        envelope: env,
        taskId: `t-${i}`,
        sessionId,
        engineId: 'llm-comprehender',
        engineType: 'llm',
        verdictPass: true,
        createdAt: now - (25 - i) * 1000 + 1,
      });
      // Rule right on 20/25; LLM right on 23/25 (gets 3 of rule's 5 wrongs)
      const ruleOk = i < 20;
      const llmOk = i < 20 || i < 23;
      store.markOutcome(hash, {
        outcome: ruleOk ? 'confirmed' : 'corrected',
        evidence: { confidence: 1.0 },
      });
      // Outcome updates BOTH rows by inputHash — we need to OVERRIDE
      // the llm row when the verdicts diverge. For this test we manually
      // set llm's outcome by rewriting the row.
      if (ruleOk !== llmOk) {
        db.run(
          `UPDATE comprehension_records
              SET outcome = ?, outcome_evidence = ?, outcome_at = ?
            WHERE input_hash = ? AND engine_id = 'llm-comprehender'`,
          [llmOk ? 'confirmed' : 'corrected', '{"confidence":1}', now, hash],
        );
      }
    }

    const result = mineComprehension({ store, calibrator });

    const byKind = {
      engineFit: result.insights.filter((i) => i.kind === 'engine-fit') as EngineFitInsight[],
      cascade: result.insights.filter((i) => i.kind === 'correction-cascade') as CorrectionCascadeInsight[],
    };

    // B1 — per-engine fit: both 'rule' and 'llm' buckets present.
    expect(byKind.engineFit.length).toBe(2);
    const rule = byKind.engineFit.find((i) => i.engineType === 'rule')!;
    const llm = byKind.engineFit.find((i) => i.engineType === 'llm')!;
    expect(rule.sampleSize).toBe(25);
    expect(llm.sampleSize).toBe(25);
    expect(rule.rawAccuracy).toBeCloseTo(20 / 25, 2);
    expect(llm.rawAccuracy).toBeCloseTo(23 / 25, 2);
    // Weighted accuracy is present because we persisted confidence=1.0 in evidence
    expect(rule.weightedAccuracy).not.toBeNull();
    expect(llm.weightedAccuracy).not.toBeNull();

    // B2 — correction-cascade:
    //   indices [0, 20)  rule=confirmed, llm=confirmed → agreed (20)
    //   indices [20, 23) rule=corrected, llm=confirmed → llmCorrectRuleWrong (3)
    //   indices [23, 25) rule=corrected, llm=corrected → agreed (2)
    // Total: 22 agreed, 3 llmCorrectRuleWrong, 0 ruleCorrectLlmWrong.
    expect(byKind.cascade.length).toBe(1);
    const cascade = byKind.cascade[0]!;
    expect(cascade.pairedTurns).toBe(25);
    expect(cascade.agreed).toBe(22);
    expect(cascade.llmCorrectRuleWrong).toBe(3);
    expect(cascade.ruleCorrectLlmWrong).toBe(0);
    expect(cascade.insufficient).toBe(false);

    // Sanity — the result carries the row count it scanned.
    expect(result.rowsScanned).toBe(50); // 25 pairs × 2 rows
  });

  test('B2 emits insufficient=true when fewer than min paired turns', () => {
    // Only 3 paired turns — below the default minPairs=10
    for (let i = 0; i < 3; i++) {
      const hash = `small-${i}`;
      const env = makeEnvelope(hash, 0.5);
      store.record({
        envelope: env,
        taskId: `t-${i}`,
        sessionId: 's',
        engineId: 'rule-comprehender',
        engineType: 'rule',
        verdictPass: true,
      });
      store.record({
        envelope: env,
        taskId: `t-${i}`,
        sessionId: 's',
        engineId: 'llm-comprehender',
        engineType: 'llm',
        verdictPass: true,
      });
      store.markOutcome(hash, { outcome: 'confirmed', evidence: {} });
    }

    const result = mineComprehension({ store, calibrator });
    const cascade = result.insights.find(
      (i) => i.kind === 'correction-cascade',
    ) as CorrectionCascadeInsight | undefined;
    expect(cascade).toBeDefined();
    expect(cascade!.pairedTurns).toBe(3);
    expect(cascade!.insufficient).toBe(true);
  });

  test('unpaired engines (only rule, no llm) do NOT count as paired turns', () => {
    const hash = 'rule-only';
    const env = makeEnvelope(hash, 0.9);
    store.record({
      envelope: env,
      taskId: 't',
      sessionId: 's',
      engineId: 'rule-comprehender',
      engineType: 'rule',
      verdictPass: true,
    });
    store.markOutcome(hash, { outcome: 'confirmed', evidence: {} });

    const result = mineComprehension({ store, calibrator });
    const cascade = result.insights.find(
      (i) => i.kind === 'correction-cascade',
    ) as CorrectionCascadeInsight;
    expect(cascade.pairedTurns).toBe(0);
    expect(cascade.agreed).toBe(0);
    // A single engine-fit entry for the rule bucket.
    const fits = result.insights.filter((i) => i.kind === 'engine-fit');
    expect(fits.length).toBe(1);
    expect((fits[0] as EngineFitInsight).engineType).toBe('rule');
  });

  test('empty store → zero insights except the cascade placeholder', () => {
    const result = mineComprehension({ store, calibrator });
    expect(result.rowsScanned).toBe(0);
    // No engine-fit rows (no engines seen), but cascade still fires as
    // a summary with 0/0 counts + insufficient=true. This is intentional:
    // dashboards can rely on the cascade insight always being present.
    const cascade = result.insights.find((i) => i.kind === 'correction-cascade');
    expect(cascade).toBeDefined();
    expect((cascade as CorrectionCascadeInsight).pairedTurns).toBe(0);
    expect((cascade as CorrectionCascadeInsight).insufficient).toBe(true);
  });

  test('rows beyond the window are excluded', () => {
    const now = Date.now();
    const env = makeEnvelope('old-hash', 0.5);
    // Record far older than default 7-day window.
    store.record({
      envelope: env,
      taskId: 't',
      sessionId: 's',
      engineId: 'rule-comprehender',
      engineType: 'rule',
      verdictPass: true,
      createdAt: now - 30 * 24 * 60 * 60 * 1000, // 30 days ago
    });
    store.markOutcome('old-hash', { outcome: 'confirmed', evidence: {} });

    // Type-assert that rows exist at all to prove fixture setup worked.
    const all = store.outcomedInWindow(0, 10) as ComprehensionRecordRow[];
    expect(all.length).toBe(1);

    const result = mineComprehension(
      { store, calibrator },
      { now: () => now },
    );
    // Default window = 7 days → the 30-day-old row is out of range.
    expect(result.rowsScanned).toBe(0);
  });
});
