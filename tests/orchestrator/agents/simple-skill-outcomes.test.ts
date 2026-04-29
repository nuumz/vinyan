/**
 * Hybrid skill redesign — Phase 6 outcome telemetry.
 *
 * `recordSimpleSkillOutcomes` is what feeds the bridge (Phase 5). Without
 * it, the SkillOutcomeStore would only ever see heavy-stack skills and the
 * simple→heavy graduation path would never have data. These tests verify
 * the recorder writes one row per (persona, simpleSkillName, taskSig)
 * tuple per task, with `success` derived from `result.status`.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { SkillOutcomeStore } from '../../../src/db/skill-outcome-store.ts';
import {
  recordSimpleSkillOutcomes,
  deriveTaskSignature,
} from '../../../src/orchestrator/agents/task-outcome-recorder.ts';
import type { TaskInput, TaskResult } from '../../../src/orchestrator/types.ts';

let db: Database;
let store: SkillOutcomeStore;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE skill_outcomes (
      persona_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      task_signature TEXT NOT NULL,
      successes INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,
      last_outcome_at INTEGER NOT NULL,
      PRIMARY KEY (persona_id, skill_id, task_signature)
    );
  `);
  store = new SkillOutcomeStore(db);
});

afterEach(() => {
  db.close();
});

const codeReviewInput: TaskInput = {
  id: 'task-1',
  goal: 'review code',
  taskType: 'code',
  agentId: 'developer',
} as unknown as TaskInput;

const completedResult: TaskResult = {
  status: 'completed',
  proposedMutations: [],
  proposedToolCalls: [],
  oracleVerdicts: [],
  uncertainties: [],
  costUsd: 0,
  tokensConsumed: 0,
  durationMs: 0,
  routingLevel: 1,
} as unknown as TaskResult;

const failedResult: TaskResult = {
  ...completedResult,
  status: 'failed',
} as unknown as TaskResult;

describe('recordSimpleSkillOutcomes', () => {
  test('records one row per invoked simple skill name', () => {
    const invoked = new Set(['code-review', 'debug-trace']);
    const result = recordSimpleSkillOutcomes(codeReviewInput, completedResult, invoked, store, 100);
    expect(result.recorded).toBe(2);

    const taskSig = deriveTaskSignature(codeReviewInput);
    expect(taskSig).toBe('code::review');

    expect(store.getOutcome({ personaId: 'developer', skillId: 'code-review', taskSignature: taskSig }))
      .toMatchObject({ successes: 1, failures: 0 });
    expect(store.getOutcome({ personaId: 'developer', skillId: 'debug-trace', taskSignature: taskSig }))
      .toMatchObject({ successes: 1, failures: 0 });
  });

  test('failed task records failure for each invoked skill', () => {
    const invoked = new Set(['code-review']);
    const result = recordSimpleSkillOutcomes(codeReviewInput, failedResult, invoked, store, 100);
    expect(result.recorded).toBe(1);

    const taskSig = deriveTaskSignature(codeReviewInput);
    expect(store.getOutcome({ personaId: 'developer', skillId: 'code-review', taskSignature: taskSig }))
      .toMatchObject({ successes: 0, failures: 1 });
  });

  test('multiple invocations of the same skill across tasks accumulate', () => {
    const invoked = new Set(['repeat']);
    recordSimpleSkillOutcomes(codeReviewInput, completedResult, invoked, store, 100);
    recordSimpleSkillOutcomes(codeReviewInput, completedResult, invoked, store, 200);
    recordSimpleSkillOutcomes(codeReviewInput, failedResult, invoked, store, 300);

    const taskSig = deriveTaskSignature(codeReviewInput);
    const row = store.getOutcome({ personaId: 'developer', skillId: 'repeat', taskSignature: taskSig });
    expect(row).toMatchObject({ successes: 2, failures: 1, lastOutcomeAt: 300 });
  });

  test('empty set → no rows written', () => {
    const result = recordSimpleSkillOutcomes(codeReviewInput, completedResult, new Set<string>(), store, 100);
    expect(result.recorded).toBe(0);
  });

  test('missing agentId → no-op', () => {
    const noPersona: TaskInput = { ...codeReviewInput, agentId: undefined as unknown as string };
    const result = recordSimpleSkillOutcomes(
      noPersona,
      completedResult,
      new Set(['anything']),
      store,
      100,
    );
    expect(result.recorded).toBe(0);
  });

  test('feeds the same store the bridge reads via listForSkill', () => {
    const invoked = new Set(['feed-bridge']);
    for (let i = 0; i < 5; i++) {
      recordSimpleSkillOutcomes(codeReviewInput, completedResult, invoked, store, 1000 + i);
    }
    const rows = store.listForSkill('feed-bridge');
    expect(rows.length).toBe(1);
    expect(rows[0]?.successes).toBe(5);
  });
});
