/**
 * AGENT.md markdown loader tests — Round F (Claude Code drop-in compat).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanAgentMarkdown, soulsByIdFrom } from '../../../src/orchestrator/agents/markdown-loader.ts';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'vinyan-md-loader-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function writeAgent(relPath: string, body: string): void {
  const full = join(workspace, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
}

describe('scanAgentMarkdown', () => {
  test('returns empty when no .claude/agents directory exists', () => {
    const result = scanAgentMarkdown(workspace);
    expect(result.entries).toEqual([]);
    expect(result.attemptedPaths).toEqual([]);
    expect(result.invalidPaths).toEqual([]);
  });

  test('parses a nested-dir AGENT.md with frontmatter + body', () => {
    writeAgent(
      '.claude/agents/researcher/AGENT.md',
      `---
description: Read-only codebase explorer for unknown territory.
name: Researcher
allowed-tools: [Read, Grep, WebFetch]
---
You are Researcher. Find facts. Cite file paths. Never edit code.`,
    );
    const result = scanAgentMarkdown(workspace);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.config.id).toBe('researcher');
    expect(entry.config.name).toBe('Researcher');
    expect(entry.config.description).toBe('Read-only codebase explorer for unknown territory.');
    expect(entry.config.allowed_tools).toEqual(['Read', 'Grep', 'WebFetch']);
    expect(entry.soul).toContain('You are Researcher');
    expect(entry.source.scope).toBe('project');
  });

  test('parses a flat-file AGENT.md form (.claude/agents/<id>.md)', () => {
    writeAgent(
      '.claude/agents/lint-fixer.md',
      `---
description: Apply lint fixes deterministically.
---
Just fix the lints. Do not refactor.`,
    );
    const result = scanAgentMarkdown(workspace);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.config.id).toBe('lint-fixer');
    expect(result.entries[0]?.config.description).toBe('Apply lint fixes deterministically.');
    expect(result.entries[0]?.soul.trim()).toBe('Just fix the lints. Do not refactor.');
  });

  test('derives `name` from id when frontmatter omits it', () => {
    writeAgent(
      '.claude/agents/test-writer/AGENT.md',
      `---
description: Writes targeted unit tests.
---
Body here.`,
    );
    const result = scanAgentMarkdown(workspace);
    expect(result.entries[0]?.config.name).toBe('test-writer');
  });

  test('skips file with missing description (logs warning, does not throw)', () => {
    writeAgent(
      '.claude/agents/bad/AGENT.md',
      `---
name: Bad
---
no description`,
    );
    const result = scanAgentMarkdown(workspace);
    expect(result.entries).toEqual([]);
    expect(result.invalidPaths).toContain(join(workspace, '.claude', 'agents', 'bad', 'AGENT.md'));
  });

  test('skips file with no frontmatter at all', () => {
    writeAgent('.claude/agents/no-frontmatter/AGENT.md', 'Just plain prose, no YAML.');
    const result = scanAgentMarkdown(workspace);
    expect(result.entries).toEqual([]);
    expect(result.invalidPaths).toContain(join(workspace, '.claude', 'agents', 'no-frontmatter', 'AGENT.md'));
  });

  test('skips file with malformed YAML frontmatter', () => {
    writeAgent(
      '.claude/agents/broken/AGENT.md',
      `---
description: ok
allowed-tools: [missing-bracket
---
body`,
    );
    const result = scanAgentMarkdown(workspace);
    expect(result.entries).toEqual([]);
    expect(result.invalidPaths).toContain(join(workspace, '.claude', 'agents', 'broken', 'AGENT.md'));
  });

  test('rejects ids that do not match kebab-case (CamelCase, underscore)', () => {
    writeAgent('.claude/agents/Bad_ID/AGENT.md', `---\ndescription: x\n---\nbody`);
    const result = scanAgentMarkdown(workspace);
    expect(result.entries).toEqual([]);
    // The directory was rejected before parsing — not an "invalid" file, just unmatched.
    expect(result.attemptedPaths).toEqual([]);
  });

  test('accepts space-separated allowed-tools scalar', () => {
    writeAgent(
      '.claude/agents/spacey/AGENT.md',
      `---
description: x
allowed-tools: Read Grep WebFetch
---
body`,
    );
    const result = scanAgentMarkdown(workspace);
    expect(result.entries[0]?.config.allowed_tools).toEqual(['Read', 'Grep', 'WebFetch']);
  });

  test('multiple agents accumulate', () => {
    writeAgent('.claude/agents/a/AGENT.md', `---\ndescription: A\n---\nA body`);
    writeAgent('.claude/agents/b/AGENT.md', `---\ndescription: B\n---\nB body`);
    const result = scanAgentMarkdown(workspace);
    expect(result.entries).toHaveLength(2);
    const ids = result.entries.map((e) => e.config.id).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  test('attemptedPaths records every file the loader looked at', () => {
    writeAgent('.claude/agents/ok/AGENT.md', `---\ndescription: ok\n---\nbody`);
    writeAgent('.claude/agents/bad/AGENT.md', 'no frontmatter');
    const result = scanAgentMarkdown(workspace);
    expect(result.attemptedPaths.sort()).toEqual(
      [
        join(workspace, '.claude', 'agents', 'bad', 'AGENT.md'),
        join(workspace, '.claude', 'agents', 'ok', 'AGENT.md'),
      ].sort(),
    );
  });
});

describe('soulsByIdFrom', () => {
  test('builds a Map<id, soul> from scan entries', () => {
    writeAgent('.claude/agents/foo/AGENT.md', `---\ndescription: foo agent\n---\nfoo soul body`);
    writeAgent('.claude/agents/bar/AGENT.md', `---\ndescription: bar agent\n---\nbar soul body`);
    const result = scanAgentMarkdown(workspace);
    const map = soulsByIdFrom(result.entries);
    expect(map.get('foo')).toBe('foo soul body');
    expect(map.get('bar')).toBe('bar soul body');
    expect(map.size).toBe(2);
  });

  test('empty input returns empty map', () => {
    expect(soulsByIdFrom([]).size).toBe(0);
  });
});
