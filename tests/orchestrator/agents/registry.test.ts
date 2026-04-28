/**
 * AgentRegistry tests — verify role-pure built-in roster, config overrides,
 * disk soul loading, soul-lint, and legacy-id detection.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgentRegistry } from '../../../src/orchestrator/agents/registry.ts';
import { clearSoulCache } from '../../../src/orchestrator/agents/soul-loader.ts';
import type { CapabilityClaim } from '../../../src/orchestrator/types.ts';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'vinyan-agent-registry-'));
  clearSoulCache();
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('AgentRegistry', () => {
  test('ships with the role-pure persona roster when config is empty', () => {
    const reg = loadAgentRegistry(workspace, undefined);
    const ids = reg
      .listAgents()
      .map((a) => a.id)
      .sort();
    expect(ids).toEqual([
      'architect',
      'assistant',
      'author',
      'concierge',
      'coordinator',
      'developer',
      'mentor',
      'researcher',
      'reviewer',
    ]);
  });

  test('built-ins are marked builtin: true and carry a role', () => {
    const reg = loadAgentRegistry(workspace, undefined);
    for (const a of reg.listAgents()) {
      expect(a.builtin).toBe(true);
      expect(typeof a.role).toBe('string');
    }
  });

  test('default agent is coordinator', () => {
    const reg = loadAgentRegistry(workspace, undefined);
    expect(reg.defaultAgent().id).toBe('coordinator');
  });

  test('getAgent returns null for unknown id', () => {
    const reg = loadAgentRegistry(workspace, undefined);
    expect(reg.getAgent('nonexistent')).toBeNull();
    expect(reg.has('nonexistent')).toBe(false);
    expect(reg.has('developer')).toBe(true);
  });

  test('config agent adds a new specialist', () => {
    const reg = loadAgentRegistry(workspace, [
      { id: 'data-scientist', name: 'Data Scientist', description: 'SQL + stats analysis' },
    ]);
    const agent = reg.getAgent('data-scientist');
    expect(agent).not.toBeNull();
    expect(agent!.name).toBe('Data Scientist');
    expect(agent!.builtin).toBe(false);
    // Built-ins still present
    expect(reg.has('developer')).toBe(true);
  });

  test('config agent with same id REPLACES built-in', () => {
    const reg = loadAgentRegistry(workspace, [
      { id: 'developer', name: 'Custom Developer', description: 'Our team style' },
    ]);
    const agent = reg.getAgent('developer');
    expect(agent!.name).toBe('Custom Developer');
    expect(agent!.description).toBe('Our team style');
    // Override preserves the persona's role/baseSkills/acquirableSkillTags
    expect(agent!.role).toBe('developer');
    // Same total — override, not addition
    expect(reg.listAgents().length).toBe(9);
  });

  test('soul file on disk overrides built-in soul (Phase 2 unified path)', () => {
    mkdirSync(join(workspace, '.vinyan', 'souls'), { recursive: true });
    writeFileSync(
      join(workspace, '.vinyan', 'souls', 'developer.soul.md'),
      '# Custom dev philosophy\nMinimal diffs only.',
    );

    const reg = loadAgentRegistry(workspace, undefined);
    const agent = reg.getAgent('developer');
    expect(agent!.soul).toContain('Custom dev philosophy');
    expect(agent!.soul).toContain('Minimal diffs only');
  });

  test('routing hints from config merge correctly', () => {
    const reg = loadAgentRegistry(workspace, [
      {
        id: 'rust-coder',
        name: 'Rust Coder',
        description: 'Rust specialist',
        routing_hints: {
          prefer_domains: ['code-mutation'],
          prefer_extensions: ['.rs'],
          min_level: 1,
        },
      },
    ]);
    const agent = reg.getAgent('rust-coder');
    expect(agent!.routingHints?.preferDomains).toEqual(['code-mutation']);
    expect(agent!.routingHints?.preferExtensions).toEqual(['.rs']);
    expect(agent!.routingHints?.minLevel).toBe(1);
  });

  test('capability overrides map snake_case → camelCase', () => {
    const reg = loadAgentRegistry(workspace, [
      {
        id: 'restricted',
        name: 'Restricted Agent',
        description: 'no shell no network',
        capability_overrides: { shell: false, network: false },
      },
    ]);
    const agent = reg.getAgent('restricted');
    expect(agent!.capabilityOverrides?.shell).toBe(false);
    expect(agent!.capabilityOverrides?.network).toBe(false);
  });

  test('returns defensive snapshots so capability claims mutate only through registry API', () => {
    const reg = loadAgentRegistry(workspace, undefined);

    const snapshot = reg.getAgent('developer')!;
    snapshot.capabilities = snapshot.capabilities ?? [];
    snapshot.capabilities.push({ id: 'poisoned.external', evidence: 'evolved', confidence: 1 });
    expect(reg.getAgent('developer')!.capabilities?.some((claim) => claim.id === 'poisoned.external')).toBe(false);

    const incoming: CapabilityClaim = {
      id: 'code.review.ts',
      evidence: 'evolved',
      confidence: 0.72,
      fileExtensions: ['.ts'],
    };
    expect(reg.mergeCapabilityClaims('developer', [incoming])).toBe(true);

    incoming.fileExtensions!.push('.poison');
    const stored = reg.getAgent('developer')!.capabilities!.find((claim) => claim.id === 'code.review.ts')!;
    expect(stored.fileExtensions).toEqual(['.ts']);

    stored.fileExtensions!.push('.mutated-snapshot');
    const reread = reg.getAgent('developer')!.capabilities!.find((claim) => claim.id === 'code.review.ts')!;
    expect(reread.fileExtensions).toEqual(['.ts']);
  });

  test('legacy persona ids in config emit a one-time warning', () => {
    const warnSpy = mock((..._args: unknown[]) => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;
    try {
      loadAgentRegistry(workspace, [
        { id: 'ts-coder', name: 'Legacy', description: 'should warn' },
        { id: 'ts-coder', name: 'Legacy duplicate', description: 'still one warn' },
        { id: 'novelist', name: 'Legacy fiction', description: 'distinct legacy id' },
      ]);
      const messages = warnSpy.mock.calls.map((c) => String(c[0]));
      const tsCoderMsgs = messages.filter((m) => m.includes('agent:legacy-id') && m.includes("'ts-coder'"));
      const novelistMsgs = messages.filter((m) => m.includes('agent:legacy-id') && m.includes("'novelist'"));
      expect(tsCoderMsgs.length).toBe(1);
      expect(novelistMsgs.length).toBe(1);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('soul lint warns when a Generator persona uses first-person verification verbs', () => {
    const warnSpy = mock((..._args: unknown[]) => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;
    try {
      mkdirSync(join(workspace, '.vinyan', 'souls'), { recursive: true });
      writeFileSync(
        join(workspace, '.vinyan', 'souls', 'developer.soul.md'),
        '# I verify everything before shipping. I check my work twice.',
      );
      loadAgentRegistry(workspace, undefined);
      const messages = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes('agent:soul-lint') && m.includes('developer'))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('soul lint exempts the reviewer persona', () => {
    const warnSpy = mock((..._args: unknown[]) => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;
    try {
      mkdirSync(join(workspace, '.vinyan', 'souls'), { recursive: true });
      writeFileSync(
        join(workspace, '.vinyan', 'souls', 'reviewer.soul.md'),
        '# I check the work against the stated contract.',
      );
      loadAgentRegistry(workspace, undefined);
      const messages = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes('agent:soul-lint') && m.includes('reviewer'))).toBe(false);
    } finally {
      console.warn = originalWarn;
    }
  });
});
