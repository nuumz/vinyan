/**
 * Tests for the Phase B skill-admission policy. Behavior tests only:
 * every assertion calls `decideAdmission` / `tagOverlapRatio` and verifies
 * verdict + ratio + reason against the documented contract.
 *
 * Coverage:
 *   - All 9 builtin personas × representative skill tag sets (cross-table).
 *   - Empty-side rejections (no scope, no tags).
 *   - Overlap-ratio computation across exact, glob, partial, and zero-overlap.
 *   - Min-overlap-ratio gate (default 0 vs raised threshold).
 *   - Reason strings populated on reject (CLI / audit consumers depend on them).
 */
import { describe, expect, test } from 'bun:test';
import { BUILTIN_AGENTS as builtins } from '../../../src/orchestrator/agents/builtin/index.ts';
import { decideAdmission, tagOverlapRatio } from '../../../src/orchestrator/agents/skill-admission.ts';

describe('decideAdmission — boolean gate', () => {
  test('accepts when persona pattern matches a skill tag exactly', () => {
    const decision = decideAdmission(['research:*'], ['research:literature']);
    expect(decision.verdict).toBe('accept');
    expect(decision.overlapRatio).toBe(1);
    expect(decision.reason).toBeUndefined();
  });

  test('accepts when ANY persona pattern matches ANY skill tag', () => {
    const decision = decideAdmission(['research:*', 'comparison:*'], ['writing:summary', 'comparison:product']);
    expect(decision.verdict).toBe('accept');
    // 1 of 2 skill tags matched → ratio 0.5
    expect(decision.overlapRatio).toBeCloseTo(0.5, 5);
  });

  test('rejects when no overlap exists', () => {
    const decision = decideAdmission(['research:*'], ['writing:marketing']);
    expect(decision.verdict).toBe('reject');
    expect(decision.overlapRatio).toBe(0);
    expect(decision.reason).toContain('writing:marketing');
    expect(decision.reason).toContain('research:*');
  });

  test('rejects when persona declares no acquirable scope', () => {
    const decision = decideAdmission(undefined, ['research:literature']);
    expect(decision.verdict).toBe('reject');
    expect(decision.reason).toBe('persona declares no acquirable scope');
  });

  test('rejects when persona scope is empty array', () => {
    const decision = decideAdmission([], ['research:literature']);
    expect(decision.verdict).toBe('reject');
    expect(decision.reason).toBe('persona declares no acquirable scope');
  });

  test('rejects when skill declares no tags', () => {
    const decision = decideAdmission(['research:*'], undefined);
    expect(decision.verdict).toBe('reject');
    expect(decision.reason).toBe('skill declares no tags');
  });

  test('rejects when skill tags is empty array', () => {
    const decision = decideAdmission(['research:*'], []);
    expect(decision.verdict).toBe('reject');
    expect(decision.reason).toBe('skill declares no tags');
  });
});

describe('decideAdmission — minOverlapRatio ceiling', () => {
  test('default 0 admits any boolean match (preserves backwards compat)', () => {
    const decision = decideAdmission(['research:*'], ['research:lit', 'writing:x', 'writing:y', 'writing:z']);
    expect(decision.verdict).toBe('accept');
    expect(decision.overlapRatio).toBeCloseTo(0.25, 5);
  });

  test('raised threshold rejects partial-overlap skill', () => {
    const decision = decideAdmission(['research:*'], ['research:lit', 'writing:x', 'writing:y', 'writing:z'], 0.5);
    expect(decision.verdict).toBe('reject');
    expect(decision.overlapRatio).toBeCloseTo(0.25, 5);
    expect(decision.reason).toContain('0.250');
    expect(decision.reason).toContain('0.500');
  });

  test('full-overlap skill clears even strict threshold', () => {
    const decision = decideAdmission(['research:*'], ['research:a', 'research:b'], 0.95);
    expect(decision.verdict).toBe('accept');
    expect(decision.overlapRatio).toBe(1);
  });
});

describe('tagOverlapRatio', () => {
  test('returns 1 when every skill tag matches', () => {
    expect(tagOverlapRatio(['research:*'], ['research:a', 'research:b'])).toBe(1);
  });

  test('returns 0 with no matches', () => {
    expect(tagOverlapRatio(['research:*'], ['writing:a', 'writing:b'])).toBe(0);
  });

  test('is asymmetric — denominator is skillTags length, not personaTags', () => {
    // 1 of 1 skill tag matched, despite persona having 4 patterns → 1.0
    expect(tagOverlapRatio(['research:*', 'a:*', 'b:*', 'c:*'], ['research:lit'])).toBe(1);
    // 1 of 3 skill tags matched → 1/3
    expect(tagOverlapRatio(['research:*'], ['research:lit', 'writing:a', 'writing:b'])).toBeCloseTo(1 / 3, 5);
  });

  test('returns 0 on empty inputs (matches matchesAcquirableTags semantics)', () => {
    expect(tagOverlapRatio([], ['x'])).toBe(0);
    expect(tagOverlapRatio(['x:*'], [])).toBe(0);
    expect(tagOverlapRatio(undefined, ['x'])).toBe(0);
  });

  test('exact match counts (no glob required)', () => {
    expect(tagOverlapRatio(['research:literature'], ['research:literature'])).toBe(1);
  });
});

describe('decideAdmission — cross-table over all 9 builtin personas', () => {
  // Representative skill tag sets that exercise each persona's scope.
  const skillFixtures: ReadonlyArray<{ name: string; tags: string[]; expectedAcceptors: string[] }> = [
    { name: 'literature-review', tags: ['research:literature'], expectedAcceptors: ['researcher'] },
    { name: 'typescript-refactor', tags: ['language:typescript', 'framework:react'], expectedAcceptors: ['developer'] },
    { name: 'api-design', tags: ['design:api'], expectedAcceptors: ['architect'] },
    { name: 'marketing-copy', tags: ['writing:marketing'], expectedAcceptors: ['author'] },
    { name: 'code-review-style', tags: ['review:code'], expectedAcceptors: ['reviewer'] },
    { name: 'meeting-summary', tags: ['summarization:meeting'], expectedAcceptors: ['assistant'] },
    { name: 'workflow-planner', tags: ['planning:workflow'], expectedAcceptors: ['coordinator'] },
    { name: 'reflection-prompt', tags: ['reflection:guided'], expectedAcceptors: ['mentor'] },
    { name: 'travel-itinerary', tags: ['travel:planning'], expectedAcceptors: ['concierge'] },
  ];

  for (const fixture of skillFixtures) {
    test(`skill "${fixture.name}" admitted only by [${fixture.expectedAcceptors.join(', ')}]`, () => {
      const acceptors: string[] = [];
      for (const persona of builtins) {
        const decision = decideAdmission(persona.acquirableSkillTags, fixture.tags);
        if (decision.verdict === 'accept') acceptors.push(persona.id);
      }
      expect(acceptors.sort()).toEqual([...fixture.expectedAcceptors].sort());
    });
  }

  test('no-tag skill is rejected by every persona', () => {
    for (const persona of builtins) {
      const decision = decideAdmission(persona.acquirableSkillTags, []);
      expect(decision.verdict).toBe('reject');
    }
  });
});
