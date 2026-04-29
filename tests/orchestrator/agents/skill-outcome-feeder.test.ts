/**
 * Phase-9 SkillOutcomeFeeder tests — bridge from SkillOutcomeStore →
 * persona-keyed PredictionErrorSamples for the AutonomousSkillCreator.
 *
 * Covers:
 *   - empty store → 0 samples emitted
 *   - one outcome row → expands into success+failure sample sequence
 *   - timestamps deterministic / split-half-friendly
 *   - personaId set on every sample
 *   - feeder degrades gracefully when store throws (A9)
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKILL_OUTCOME_SCHEMA_SQL } from '../../../src/db/skill-outcome-schema.ts';
import { SkillOutcomeStore } from '../../../src/db/skill-outcome-store.ts';
import { loadAgentRegistry } from '../../../src/orchestrator/agents/registry.ts';
import {
  expandRowToSamples,
  FAILURE_COMPOSITE_ERROR,
  feedSkillOutcomesToCreator,
  SUCCESS_COMPOSITE_ERROR,
} from '../../../src/orchestrator/agents/skill-outcome-feeder.ts';
import type { AutonomousSkillCreator } from '../../../src/skills/autonomous/creator.ts';
import type { PredictionErrorSample } from '../../../src/skills/autonomous/types.ts';

function makeRegistry() {
  const ws = mkdtempSync(join(tmpdir(), 'vinyan-feeder-'));
  const registry = loadAgentRegistry(ws, undefined);
  return { ws, registry, cleanup: () => rmSync(ws, { recursive: true, force: true }) };
}

function makeStore() {
  const db = new Database(':memory:');
  db.exec(SKILL_OUTCOME_SCHEMA_SQL);
  return new SkillOutcomeStore(db);
}

function captureCreator(): {
  observe: AutonomousSkillCreator['observe'];
  samples: PredictionErrorSample[];
} {
  const samples: PredictionErrorSample[] = [];
  return {
    observe: (s: PredictionErrorSample) => {
      samples.push(s);
    },
    samples,
  };
}

describe('expandRowToSamples', () => {
  test('zero outcomes → empty', () => {
    expect(
      expandRowToSamples({
        personaId: 'developer',
        skillId: 'ts',
        taskSignature: 'code::refactor',
        successes: 0,
        failures: 0,
        lastOutcomeAt: 1000,
      }),
    ).toEqual([]);
  });

  test('successes precede failures, all carry personaId', () => {
    const samples = expandRowToSamples({
      personaId: 'developer',
      skillId: 'ts',
      taskSignature: 'code::refactor',
      successes: 3,
      failures: 2,
      lastOutcomeAt: 1000,
    });
    expect(samples).toHaveLength(5);
    expect(samples.every((s) => s.personaId === 'developer')).toBe(true);
    expect(samples.slice(0, 3).every((s) => s.outcome === 'success')).toBe(true);
    expect(samples.slice(3).every((s) => s.outcome === 'failure')).toBe(true);
  });

  test('compositeError uses success/failure constants', () => {
    const samples = expandRowToSamples({
      personaId: 'developer',
      skillId: 'ts',
      taskSignature: 'code::refactor',
      successes: 2,
      failures: 1,
      lastOutcomeAt: 1000,
    });
    expect(samples[0]?.compositeError).toBe(SUCCESS_COMPOSITE_ERROR);
    expect(samples[1]?.compositeError).toBe(SUCCESS_COMPOSITE_ERROR);
    expect(samples[2]?.compositeError).toBe(FAILURE_COMPOSITE_ERROR);
  });

  test('taskId deterministic per (persona, skill, taskSig, position)', () => {
    const args = {
      personaId: 'developer',
      skillId: 'ts',
      taskSignature: 'code::refactor',
      successes: 1,
      failures: 1,
      lastOutcomeAt: 1000,
    };
    const a = expandRowToSamples(args);
    const b = expandRowToSamples(args);
    expect(a.map((s) => s.taskId)).toEqual(b.map((s) => s.taskId));
  });
});

describe('feedSkillOutcomesToCreator', () => {
  test('empty store → 0 samples', () => {
    const { registry, cleanup } = makeRegistry();
    try {
      const store = makeStore();
      const creator = captureCreator();
      const result = feedSkillOutcomesToCreator(creator, store, registry);
      expect(result.samplesEmitted).toBe(0);
      expect(creator.samples).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test('outcomes flow to creator with personaId on every sample', () => {
    const { registry, cleanup } = makeRegistry();
    try {
      const store = makeStore();
      // Record 4 successes + 1 failure for developer × typescript-coding × refactor
      for (let i = 0; i < 4; i++) {
        store.recordOutcome(
          { personaId: 'developer', skillId: 'typescript-coding', taskSignature: 'code::refactor' },
          'success',
          1000 + i,
        );
      }
      store.recordOutcome(
        { personaId: 'developer', skillId: 'typescript-coding', taskSignature: 'code::refactor' },
        'failure',
        2000,
      );

      const creator = captureCreator();
      const result = feedSkillOutcomesToCreator(creator, store, registry);
      expect(result.samplesEmitted).toBe(5);
      expect(result.rowsScanned).toBe(1);
      expect(creator.samples.every((s) => s.personaId === 'developer')).toBe(true);
      expect(creator.samples.filter((s) => s.outcome === 'success').length).toBe(4);
      expect(creator.samples.filter((s) => s.outcome === 'failure').length).toBe(1);
    } finally {
      cleanup();
    }
  });

  test('multiple personas → samples segregated by personaId', () => {
    const { registry, cleanup } = makeRegistry();
    try {
      const store = makeStore();
      for (let i = 0; i < 3; i++) {
        store.recordOutcome(
          { personaId: 'developer', skillId: 'ts', taskSignature: 'code::refactor' },
          'success',
          1000 + i,
        );
      }
      for (let i = 0; i < 2; i++) {
        store.recordOutcome(
          { personaId: 'reviewer', skillId: 'review-checklist', taskSignature: 'review::audit' },
          'success',
          2000 + i,
        );
      }
      const creator = captureCreator();
      feedSkillOutcomesToCreator(creator, store, registry);
      const devSamples = creator.samples.filter((s) => s.personaId === 'developer');
      const revSamples = creator.samples.filter((s) => s.personaId === 'reviewer');
      expect(devSamples).toHaveLength(3);
      expect(revSamples).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  test('A9 — store IO failure on a persona is swallowed; other personas still feed', () => {
    const { registry, cleanup } = makeRegistry();
    try {
      let calls = 0;
      const partialStore: Pick<SkillOutcomeStore, 'listForPersona'> = {
        listForPersona: (personaId: string) => {
          calls++;
          if (personaId === 'developer') throw new Error('boom');
          return [];
        },
      };
      const creator = captureCreator();
      const result = feedSkillOutcomesToCreator(creator, partialStore, registry);
      // No throw, all personas iterated
      expect(calls).toBeGreaterThan(0);
      expect(result.samplesEmitted).toBe(0);
    } finally {
      cleanup();
    }
  });
});
