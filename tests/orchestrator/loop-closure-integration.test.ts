/**
 * Phase-5A loop-closure integration test — proves outcome recording wires
 * end-to-end through the factory's executeTask wrapper.
 *
 * Without this wiring, `recordTaskOutcomeForPersona` is dead code: the
 * helper exists but no production caller invokes it. This test simulates
 * the wrapper's invocation against a registry+store and verifies the
 * outcome row materialises as expected.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { asPersonaId } from '../../src/core/agent-vocabulary.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKILL_OUTCOME_SCHEMA_SQL } from '../../src/db/skill-outcome-schema.ts';
import { SkillOutcomeStore } from '../../src/db/skill-outcome-store.ts';
import type { SyncSkillResolver } from '../../src/orchestrator/agents/derive-persona-capabilities.ts';
import { saveBoundSkills } from '../../src/orchestrator/agents/persona-skill-loader.ts';
import { loadAgentRegistry } from '../../src/orchestrator/agents/registry.ts';
import { recordTaskOutcomeForPersona } from '../../src/orchestrator/agents/task-outcome-recorder.ts';
import type { SkillRef, TaskInput, TaskResult } from '../../src/orchestrator/types.ts';
import type { SkillMdRecord } from '../../src/skills/skill-md/index.ts';

function makeSkill(id: string): SkillMdRecord {
  return {
    frontmatter: {
      id,
      name: id,
      version: '1.0.0',
      description: 'fixture',
      requires_toolsets: [],
      fallback_for_toolsets: [],
      confidence_tier: 'heuristic',
      origin: 'local',
      declared_oracles: [],
      falsifiable_by: [],
      status: 'active',
    },
    body: { overview: 'o', whenToUse: 'w', procedure: 'p' },
    contentHash: 'sha256:' + '0'.repeat(64),
  };
}

function makeResolver(skills: SkillMdRecord[]): SyncSkillResolver {
  const map = new Map<string, SkillMdRecord>(skills.map((s) => [s.frontmatter.id, s]));
  return { resolve: (ref: SkillRef) => map.get(ref.id) ?? null };
}

function makeInput(goal: string): TaskInput {
  return {
    id: 't1',
    source: 'cli',
    goal,
    taskType: 'code',
    agentId: asPersonaId('developer'),
    budget: { maxTokens: 1000, maxDurationMs: 10_000, maxRetries: 1 },
  };
}

function makeResult(status: TaskResult['status']): TaskResult {
  return {
    id: 't1',
    status,
    mutations: [],
    trace: {
      id: 'trace-t1',
      taskId: 't1',
      routingLevel: 1,
      approach: 'integration-test',
      outcome: status === 'completed' ? 'success' : 'failure',
      oracleVerdicts: {},
      tokensConsumed: 0,
      durationMs: 0,
      affectedFiles: [],
      timestamp: 1,
      modelUsed: 'mock',
    },
  };
}

describe('Phase-5A loop-closure integration', () => {
  function setup(boundIds: string[]) {
    const ws = mkdtempSync(join(tmpdir(), 'vinyan-loop-'));
    const skills = boundIds.map(makeSkill);
    if (boundIds.length > 0) {
      saveBoundSkills(
        ws,
        'developer',
        boundIds.map((id) => ({ id })),
      );
    }
    const reg = loadAgentRegistry(ws, undefined, undefined, { skillResolver: makeResolver(skills) });
    const db = new Database(':memory:');
    db.exec(SKILL_OUTCOME_SCHEMA_SQL);
    const store = new SkillOutcomeStore(db);
    return { ws, reg, store, cleanup: () => rmSync(ws, { recursive: true, force: true }) };
  }

  test('completed task records success rows for every bound skill', () => {
    const { reg, store, cleanup } = setup(['typescript-coding', 'react-patterns']);
    try {
      // Mirrors the factory's executeTask wrapper invocation.
      const input = makeInput('refactor src/foo.ts');
      const result = makeResult('completed');
      const summary = recordTaskOutcomeForPersona(input, result, reg, store, undefined, 1000);

      expect(summary.skillsRecorded).toBe(2);
      expect(summary.outcome).toBe('success');
      expect(summary.taskSignature).toBe('code::refactor');

      // Both rows materialised with the correct outcome counter.
      const ts = store.getOutcome({
        personaId: 'developer',
        skillId: 'typescript-coding',
        taskSignature: 'code::refactor',
      });
      expect(ts!.successes).toBe(1);

      const react = store.getOutcome({
        personaId: 'developer',
        skillId: 'react-patterns',
        taskSignature: 'code::refactor',
      });
      expect(react!.successes).toBe(1);
    } finally {
      cleanup();
    }
  });

  test('failed task records failure rows', () => {
    const { reg, store, cleanup } = setup(['typescript-coding']);
    try {
      const summary = recordTaskOutcomeForPersona(
        makeInput('refactor src/foo.ts'),
        makeResult('failed'),
        reg,
        store,
        undefined,
        1000,
      );
      expect(summary.outcome).toBe('failure');
      const row = store.getOutcome({
        personaId: 'developer',
        skillId: 'typescript-coding',
        taskSignature: 'code::refactor',
      });
      expect(row!.failures).toBe(1);
      expect(row!.successes).toBe(0);
    } finally {
      cleanup();
    }
  });

  test('persona without bound skills is a no-op (legacy task pass-through)', () => {
    const { reg, store, cleanup } = setup([]);
    try {
      const summary = recordTaskOutcomeForPersona(
        makeInput('refactor src/foo.ts'),
        makeResult('completed'),
        reg,
        store,
      );
      expect(summary.skillsRecorded).toBe(0);
      expect(store.listForPersona('developer')).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test('repeated runs accumulate outcome counters via UPSERT', () => {
    const { reg, store, cleanup } = setup(['typescript-coding']);
    try {
      const input = makeInput('refactor src/foo.ts');
      for (let i = 0; i < 5; i++) {
        recordTaskOutcomeForPersona(input, makeResult('completed'), reg, store, undefined, 1000 + i);
      }
      for (let i = 0; i < 2; i++) {
        recordTaskOutcomeForPersona(input, makeResult('failed'), reg, store, undefined, 2000 + i);
      }
      const row = store.getOutcome({
        personaId: 'developer',
        skillId: 'typescript-coding',
        taskSignature: 'code::refactor',
      });
      expect(row!.successes).toBe(5);
      expect(row!.failures).toBe(2);
    } finally {
      cleanup();
    }
  });
});
