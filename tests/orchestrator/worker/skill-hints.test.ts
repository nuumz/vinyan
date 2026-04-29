/**
 * Wave 5b: skill-hint formatting tests.
 *
 * Verifies the constraint block produced by formatSkillHintConstraints
 * stays bounded, preserves success rate, and handles empty input.
 */
import { describe, expect, test } from 'bun:test';
import type { AgentMemoryAPI } from '../../../src/orchestrator/agent-memory/agent-memory-api.ts';
import { formatSkillHintConstraints, resolveRuntimeSkillHintConstraints } from '../../../src/orchestrator/skill-hints.ts';
import type { CachedSkill, TaskInput } from '../../../src/orchestrator/types.ts';

function skill(overrides: Partial<CachedSkill> = {}): CachedSkill {
  return {
    taskSignature: 'fix::ts::small',
    approach: 'direct edit',
    successRate: 0.8,
    status: 'active',
    probationRemaining: 0,
    usageCount: 5,
    riskAtCreation: 0.3,
    depConeHashes: {},
    lastVerifiedAt: Date.now(),
    verificationProfile: 'structural',
    ...overrides,
  };
}

describe('formatSkillHintConstraints', () => {
  test('empty array → empty result', () => {
    expect(formatSkillHintConstraints([])).toEqual([]);
  });

  test('single skill → header + one entry', () => {
    const result = formatSkillHintConstraints([skill({ approach: 'refactor with helper', successRate: 0.9, usageCount: 12 })]);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('[SKILL HINTS]');
    expect(result[0]).toContain('1 proven');
    expect(result[1]).toContain('refactor with helper');
    expect(result[1]).toContain('success: 90%');
    expect(result[1]).toContain('uses: 12');
  });

  test('three skills → header + three numbered entries', () => {
    const result = formatSkillHintConstraints([
      skill({ approach: 'approach A', successRate: 0.85 }),
      skill({ approach: 'approach B', successRate: 0.72 }),
      skill({ approach: 'approach C', successRate: 0.66 }),
    ]);
    expect(result).toHaveLength(4);
    expect(result[0]).toContain('3 proven');
    expect(result[1]).toContain('1. approach A');
    expect(result[2]).toContain('2. approach B');
    expect(result[3]).toContain('3. approach C');
  });

  test('very long approach is truncated to bound token cost', () => {
    const longApproach = 'x'.repeat(500);
    const result = formatSkillHintConstraints([skill({ approach: longApproach })]);
    // Truncated at 200 chars + ellipsis, not full 500
    expect(result[1]).toContain('…');
    expect(result[1]!.length).toBeLessThan(400);
  });

  test('preserves insertion order for equal success rates', () => {
    const result = formatSkillHintConstraints([
      skill({ approach: 'first', successRate: 0.8 }),
      skill({ approach: 'second', successRate: 0.8 }),
    ]);
    expect(result[1]).toContain('first');
    expect(result[2]).toContain('second');
  });

  test('marks informational framing (reference only)', () => {
    const result = formatSkillHintConstraints([skill()]);
    expect(result[0]).toContain('reference only');
    expect(result[0]).toContain('not mandates');
  });
});

describe('resolveRuntimeSkillHintConstraints', () => {
  function input(): TaskInput {
    return {
      id: 'task-1',
      source: 'cli',
      goal: 'fix auth bug',
      taskType: 'code',
      targetFiles: ['src/auth.ts'],
      budget: { maxTokens: 10_000, maxRetries: 1, maxDurationMs: 30_000 },
    } as TaskInput;
  }

  test('disabled config returns no constraints and does not query memory', async () => {
    let queried = false;
    const agentMemory = {
      queryRelatedSkills: async () => {
        queried = true;
        return [skill({ approach: 'should not load' })];
      },
    } as unknown as AgentMemoryAPI;

    const resolved = await resolveRuntimeSkillHintConstraints({
      input: input(),
      config: { enabled: false, topK: 3 },
      agentMemory,
      matchedSkill: skill({ approach: 'matched but disabled' }),
    });

    expect(resolved.constraints).toEqual([]);
    expect(resolved.skills).toEqual([]);
    expect(queried).toBe(false);
  });

  test('combines matched skill with related skills and dedupes by signature', async () => {
    const matched = skill({ taskSignature: 'exact::auth.ts', approach: 'exact direct edit', successRate: 0.91 });
    const related = skill({ taskSignature: 'similar::ts', approach: 'similar helper extraction', successRate: 0.82 });
    const agentMemory = {
      queryRelatedSkills: async (_taskSig: string, opts?: { k?: number }) => {
        expect(opts?.k).toBe(2);
        return [matched, related];
      },
    } as unknown as AgentMemoryAPI;

    const resolved = await resolveRuntimeSkillHintConstraints({
      input: input(),
      config: { enabled: true, topK: 2 },
      agentMemory,
      matchedSkill: matched,
    });

    expect(resolved.skills.map((s) => s.taskSignature)).toEqual(['exact::auth.ts', 'similar::ts']);
    expect(resolved.constraints[0]).toContain('2 proven');
    expect(resolved.constraints[1]).toContain('exact direct edit');
    expect(resolved.constraints[2]).toContain('similar helper extraction');
  });

  test('memory query failure still surfaces a verified matched skill', async () => {
    const matched = skill({ taskSignature: 'exact::auth.ts', approach: 'verified exact skill', successRate: 0.94 });
    const agentMemory = {
      queryRelatedSkills: async () => {
        throw new Error('skill store unavailable');
      },
    } as unknown as AgentMemoryAPI;

    const resolved = await resolveRuntimeSkillHintConstraints({
      input: input(),
      config: { enabled: true, topK: 3 },
      agentMemory,
      matchedSkill: matched,
    });

    expect(resolved.skills).toEqual([matched]);
    expect(resolved.constraints[1]).toContain('verified exact skill');
  });
});
