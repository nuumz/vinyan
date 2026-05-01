/**
 * Tests for `recordTaskOutcomeForPersona` — Phase-4 settlement → SkillOutcomeStore wiring.
 *
 * Covers:
 *   - no agentId → no rows recorded (count 0)
 *   - persona has no loaded skills → no rows recorded
 *   - completed task → 'success' rows for every loaded skill
 *   - non-completed task → 'failure' rows
 *   - taskSignature is taskType::verb when verb is extractable
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { asPersonaId } from '../../../src/core/agent-vocabulary.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKILL_OUTCOME_SCHEMA_SQL } from '../../../src/db/skill-outcome-schema.ts';
import { SkillOutcomeStore } from '../../../src/db/skill-outcome-store.ts';
import type { SyncSkillResolver } from '../../../src/orchestrator/agents/derive-persona-capabilities.ts';
import { saveBoundSkills } from '../../../src/orchestrator/agents/persona-skill-loader.ts';
import { loadAgentRegistry } from '../../../src/orchestrator/agents/registry.ts';
import {
  deriveTaskSignature,
  recordTaskOutcomeForPersona,
} from '../../../src/orchestrator/agents/task-outcome-recorder.ts';
import type { SkillRef, TaskInput, TaskResult } from '../../../src/orchestrator/types.ts';
import type { SkillMdRecord } from '../../../src/skills/skill-md/index.ts';

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

function makeInput(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 't1',
    source: 'cli',
    goal: 'refactor the auth module',
    taskType: 'code',
    budget: { maxTokens: 1000, maxDurationMs: 10_000, maxRetries: 1 },
    ...overrides,
  };
}

function makeResult(status: TaskResult['status'] = 'completed'): TaskResult {
  return {
    id: 't1',
    status,
    mutations: [],
    trace: {
      id: 'trace-t1',
      taskId: 't1',
      routingLevel: 1,
      approach: 'test',
      outcome: status === 'completed' ? 'success' : 'failure',
      oracleVerdicts: {},
      tokensConsumed: 0,
      durationMs: 0,
      affectedFiles: [],
      timestamp: 1,
      modelUsed: 'test',
    },
  };
}

function makeStore(): SkillOutcomeStore {
  const db = new Database(':memory:');
  db.exec(SKILL_OUTCOME_SCHEMA_SQL);
  return new SkillOutcomeStore(db);
}

describe('deriveTaskSignature', () => {
  test('combines taskType and first verb', () => {
    expect(deriveTaskSignature(makeInput({ goal: 'refactor X', taskType: 'code' }))).toBe('code::refactor');
  });

  test('falls back to taskType when no verb', () => {
    expect(deriveTaskSignature(makeInput({ goal: 'something obscure', taskType: 'reasoning' }))).toBe('reasoning');
  });

  test('returns "unknown" when nothing is available', () => {
    // Cast through unknown — fixture exercises the absent-taskType branch.
    const empty = { ...makeInput(), goal: '', taskType: undefined } as unknown as TaskInput;
    expect(deriveTaskSignature(empty)).toBe('unknown');
  });
});

describe('recordTaskOutcomeForPersona', () => {
  function setup(boundSkillIds: string[]) {
    const ws = mkdtempSync(join(tmpdir(), 'vinyan-tor-'));
    const skills = boundSkillIds.map(makeSkill);
    if (boundSkillIds.length > 0) {
      saveBoundSkills(
        ws,
        'developer',
        boundSkillIds.map((id) => ({ id })),
      );
    }
    const reg = loadAgentRegistry(ws, undefined, undefined, { skillResolver: makeResolver(skills) });
    const store = makeStore();
    return { ws, reg, store, cleanup: () => rmSync(ws, { recursive: true, force: true }) };
  }

  test('no agentId → no rows recorded, returns count 0', () => {
    const { reg, store, cleanup } = setup([]);
    try {
      const out = recordTaskOutcomeForPersona(makeInput({ agentId: undefined }), makeResult(), reg, store);
      expect(out.skillsRecorded).toBe(0);
      expect(store.listForPersona('developer')).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test('persona has no loaded skills → no rows', () => {
    const { reg, store, cleanup } = setup([]);
    try {
      const out = recordTaskOutcomeForPersona(makeInput({ agentId: asPersonaId('developer') }), makeResult(), reg, store);
      expect(out.skillsRecorded).toBe(0);
    } finally {
      cleanup();
    }
  });

  test('completed task → success rows for every loaded skill', () => {
    const { reg, store, cleanup } = setup(['ts-coding', 'react-patterns']);
    try {
      const out = recordTaskOutcomeForPersona(
        makeInput({ agentId: asPersonaId('developer'), goal: 'refactor X' }),
        makeResult('completed'),
        reg,
        store,
        undefined,
        1000,
      );
      expect(out.skillsRecorded).toBe(2);
      expect(out.outcome).toBe('success');
      const ts = store.getOutcome({
        personaId: 'developer',
        skillId: 'ts-coding',
        taskSignature: 'code::refactor',
      });
      expect(ts!.successes).toBe(1);
      expect(ts!.failures).toBe(0);
    } finally {
      cleanup();
    }
  });

  test('failed task → failure rows', () => {
    const { reg, store, cleanup } = setup(['ts-coding']);
    try {
      const out = recordTaskOutcomeForPersona(
        makeInput({ agentId: asPersonaId('developer'), goal: 'refactor X' }),
        makeResult('failed'),
        reg,
        store,
        undefined,
        1000,
      );
      expect(out.outcome).toBe('failure');
      const ts = store.getOutcome({
        personaId: 'developer',
        skillId: 'ts-coding',
        taskSignature: 'code::refactor',
      });
      expect(ts!.failures).toBe(1);
      expect(ts!.successes).toBe(0);
    } finally {
      cleanup();
    }
  });
});
