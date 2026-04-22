/**
 * GitHubAdapter tests — mocked `fetchImpl`, id parsing, ETag cache.
 */
import { describe, expect, test } from 'bun:test';
import { GitHubAdapter, parseGithubSkillId } from '../../../../src/skills/hub/adapters/github.ts';
import { SkillNotFoundError, SkillRegistryError, type FetchImpl } from '../../../../src/skills/hub/registry-adapter.ts';

const SAMPLE_SKILL = `---
confidence_tier: heuristic
description: A sample skill from GitHub
id: test/skill
name: Test Skill
version: 1.0.0
---

## Overview

Overview.

## When to use

When testing.

## Procedure

1. One.

## Files

- helper.py
`;

interface RecordedCall {
  url: string;
  headers?: Record<string, string>;
}

function makeFetchImpl(routes: Record<string, { status: number; body?: string; etag?: string; json?: unknown }>): {
  impl: FetchImpl;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const impl: FetchImpl = async (url, init) => {
    calls.push({ url, headers: init?.headers });
    const route = routes[url];
    if (!route) {
      return {
        ok: false,
        status: 404,
        headers: { get: () => null },
        text: async () => '',
        json: async () => ({}),
      };
    }
    const h = new Map<string, string>();
    if (route.etag) h.set('ETag', route.etag);
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      headers: { get: (name: string) => h.get(name) ?? null },
      text: async () => route.body ?? '',
      json: async () => route.json ?? {},
    };
  };
  return { impl, calls };
}

describe('parseGithubSkillId', () => {
  test('parses full id with ref and path', () => {
    const p = parseGithubSkillId('github:alice/repo@main/skills/my-skill');
    expect(p).toEqual({ owner: 'alice', repo: 'repo', ref: 'main', path: 'skills/my-skill' });
  });

  test('parses id without ref (defaults to HEAD)', () => {
    const p = parseGithubSkillId('github:alice/repo/skills/my-skill');
    expect(p.ref).toBe('HEAD');
    expect(p.path).toBe('skills/my-skill');
  });

  test('parses id without path (root directory)', () => {
    const p = parseGithubSkillId('github:alice/repo@v1.2.3');
    expect(p.ref).toBe('v1.2.3');
    expect(p.path).toBe('');
  });

  test('rejects ids missing the prefix', () => {
    expect(() => parseGithubSkillId('alice/repo')).toThrow(SkillRegistryError);
  });

  test('rejects malformed ids (missing repo)', () => {
    expect(() => parseGithubSkillId('github:alice')).toThrow(SkillRegistryError);
  });
});

describe('GitHubAdapter.fetch', () => {
  test('builds correct raw URL and returns skill + whitelisted files', async () => {
    const skillUrl = 'https://raw.githubusercontent.com/alice/repo/main/skills/my-skill/SKILL.md';
    const fileUrl = 'https://raw.githubusercontent.com/alice/repo/main/skills/my-skill/helper.py';
    const { impl, calls } = makeFetchImpl({
      [skillUrl]: { status: 200, body: SAMPLE_SKILL },
      [fileUrl]: { status: 200, body: 'print("hi")' },
    });
    const adapter = new GitHubAdapter({ fetchImpl: impl });

    const result = await adapter.fetch('github:alice/repo@main/skills/my-skill');

    expect(result.skillMd).toContain('id: test/skill');
    expect(result.files.get('helper.py')).toBe('print("hi")');
    expect(calls.find((c) => c.url === skillUrl)).toBeDefined();
    expect(calls.find((c) => c.url === fileUrl)).toBeDefined();
  });

  test('404 on SKILL.md throws SkillNotFoundError', async () => {
    const { impl } = makeFetchImpl({});
    const adapter = new GitHubAdapter({ fetchImpl: impl });
    await expect(adapter.fetch('github:alice/repo@main/skills/missing')).rejects.toThrow(SkillNotFoundError);
  });

  test('unparseable SKILL.md body throws SkillRegistryError', async () => {
    const skillUrl = 'https://raw.githubusercontent.com/alice/repo/HEAD/SKILL.md';
    const { impl } = makeFetchImpl({
      [skillUrl]: { status: 200, body: '# not a SKILL.md' },
    });
    const adapter = new GitHubAdapter({ fetchImpl: impl });
    await expect(adapter.fetch('github:alice/repo')).rejects.toThrow(SkillRegistryError);
  });

  test('sends If-None-Match on second call when server returned ETag', async () => {
    const skillUrl = 'https://raw.githubusercontent.com/alice/repo/HEAD/SKILL.md';
    const { impl, calls } = makeFetchImpl({
      [skillUrl]: { status: 200, body: SAMPLE_SKILL, etag: '"abc123"' },
    });
    const adapter = new GitHubAdapter({ fetchImpl: impl });
    await adapter.fetch('github:alice/repo').catch(() => undefined);
    await adapter.fetch('github:alice/repo').catch(() => undefined);

    const calledTwice = calls.filter((c) => c.url === skillUrl);
    expect(calledTwice.length).toBe(2);
    expect(calledTwice[1]?.headers?.['If-None-Match']).toBe('"abc123"');
  });

  test('304 Not Modified returns cached body', async () => {
    const skillUrl = 'https://raw.githubusercontent.com/alice/repo/HEAD/SKILL.md';
    const skillNoFiles = SAMPLE_SKILL.replace(/\n## Files[\s\S]*$/, '\n');
    const callsPerUrl = new Map<string, number>();
    const impl: FetchImpl = async (url) => {
      const count = (callsPerUrl.get(url) ?? 0) + 1;
      callsPerUrl.set(url, count);
      if (url === skillUrl) {
        if (count === 1) {
          const h = new Map<string, string>([['ETag', '"v1"']]);
          return {
            ok: true,
            status: 200,
            headers: { get: (n: string) => h.get(n) ?? null },
            text: async () => skillNoFiles,
            json: async () => ({}),
          };
        }
        return {
          ok: false,
          status: 304,
          headers: { get: () => null },
          text: async () => '',
          json: async () => ({}),
        };
      }
      return {
        ok: false,
        status: 404,
        headers: { get: () => null },
        text: async () => '',
        json: async () => ({}),
      };
    };
    const adapter = new GitHubAdapter({ fetchImpl: impl });
    const first = await adapter.fetch('github:alice/repo');
    const second = await adapter.fetch('github:alice/repo');
    expect(second.skillMd).toBe(first.skillMd);
  });
});
