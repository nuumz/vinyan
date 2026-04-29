/**
 * Simple skill matcher tests — Jaccard similarity between query and
 * (name + description). Plus explicit /skill-name invocation parsing.
 */
import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_THRESHOLD,
  detectExplicitInvocation,
  jaccard,
  matchSkillsForTask,
  tokenize,
} from '../../../src/skills/simple/matcher.ts';
import type { SimpleSkill } from '../../../src/skills/simple/loader.ts';

function skill(name: string, description: string): SimpleSkill {
  return { name, description, body: 'body', scope: 'project', path: `/tmp/${name}/SKILL.md` };
}

describe('tokenize', () => {
  test('lowercases and splits on non-alphanumeric', () => {
    const tokens = tokenize('Code-Review!! 2026/04');
    expect([...tokens].sort()).toEqual(['2026', '04', 'code', 'review'].sort());
  });

  test('drops stopwords and 1-char tokens', () => {
    const tokens = tokenize('a is the b reviewing code');
    expect([...tokens].sort()).toEqual(['code', 'reviewing'].sort());
  });

  test('empty / whitespace input → empty set', () => {
    expect(tokenize('')).toEqual(new Set<string>());
    expect(tokenize('   ')).toEqual(new Set<string>());
  });
});

describe('jaccard', () => {
  test('identical sets → 1', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
  });

  test('disjoint sets → 0', () => {
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
  });

  test('half overlap → 1/3', () => {
    // |{a,b} ∩ {b,c}| = 1, union = 3 → 1/3
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3, 5);
  });

  test('empty sets → 0', () => {
    expect(jaccard(new Set(), new Set(['a']))).toBe(0);
    expect(jaccard(new Set(['a']), new Set())).toBe(0);
  });
});

describe('matchSkillsForTask — happy path', () => {
  test('matches a skill whose description shares tokens with the query', () => {
    const skills = [
      skill('code-review', 'Review code for bugs and style. Use when reviewing pull requests.'),
      skill('git-commit', 'Write a git commit message in conventional format.'),
    ];
    const matches = matchSkillsForTask('please review the code in this PR', skills);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.skill.name).toBe('code-review');
  });

  test('returns empty when no skill clears threshold', () => {
    const skills = [skill('git-commit', 'Write a commit message.')];
    const matches = matchSkillsForTask('debug a memory leak', skills);
    expect(matches).toEqual([]);
  });

  test('top-K caps results', () => {
    const skills = [
      skill('a', 'review code review'),
      skill('b', 'review code review'),
      skill('c', 'review code review'),
      skill('d', 'review code review'),
    ];
    const matches = matchSkillsForTask('review code review', skills, { topK: 2 });
    expect(matches.length).toBe(2);
  });

  test('ordered by score desc, then name asc on tie', () => {
    const skills = [
      skill('zebra', 'review code'),
      skill('alpha', 'review code'),
    ];
    const matches = matchSkillsForTask('review code', skills);
    expect(matches.map((m) => m.skill.name)).toEqual(['alpha', 'zebra']);
  });

  test('empty query → empty result', () => {
    const skills = [skill('code-review', 'review code')];
    expect(matchSkillsForTask('', skills)).toEqual([]);
    expect(matchSkillsForTask('   ', skills)).toEqual([]);
  });

  test('threshold respected', () => {
    const skills = [skill('marginal', 'one shared token')];
    // 'one' is a non-stopword. 'shared' is non-stopword. Query 'one' shares
    // exactly 1 token of 4 in skill description → score = 1/4 = 0.25.
    const matches = matchSkillsForTask('one', skills, { threshold: 0.5 });
    expect(matches).toEqual([]);
    const lowMatches = matchSkillsForTask('one', skills, { threshold: 0.1 });
    expect(lowMatches.length).toBe(1);
  });
});

describe('matchSkillsForTask — defaults', () => {
  test('default threshold is DEFAULT_THRESHOLD', () => {
    expect(DEFAULT_THRESHOLD).toBe(0.15);
  });
});

describe('detectExplicitInvocation', () => {
  test('matches /<name> at start', () => {
    const skills = [skill('code-review', 'r'), skill('debug', 'd')];
    const found = detectExplicitInvocation('/code-review please run', skills);
    expect(found?.name).toBe('code-review');
  });

  test('returns null when query has no slash', () => {
    const skills = [skill('code-review', 'r')];
    expect(detectExplicitInvocation('please review', skills)).toBeNull();
  });

  test('returns null when slash name unknown', () => {
    const skills = [skill('code-review', 'r')];
    expect(detectExplicitInvocation('/ghost-skill', skills)).toBeNull();
  });

  test('handles namespaced names with dots and slashes', () => {
    const skills = [skill('team/audit', 'audit'), skill('a.b.c', 'd')];
    expect(detectExplicitInvocation('/team/audit', skills)?.name).toBe('team/audit');
    expect(detectExplicitInvocation('/a.b.c', skills)?.name).toBe('a.b.c');
  });
});
