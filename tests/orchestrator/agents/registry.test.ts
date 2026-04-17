/**
 * AgentRegistry tests — verify built-in defaults, config overrides, disk soul loading.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgentRegistry } from '../../../src/orchestrator/agents/registry.ts';
import { clearSoulCache } from '../../../src/orchestrator/agents/soul-loader.ts';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'vinyan-agent-registry-'));
  clearSoulCache();
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('AgentRegistry', () => {
  test('ships with 4 built-in agents when config is empty', () => {
    const reg = loadAgentRegistry(workspace, undefined);
    const ids = reg.listAgents().map((a) => a.id).sort();
    expect(ids).toEqual(['secretary', 'system-designer', 'ts-coder', 'writer']);
  });

  test('built-ins are marked builtin: true', () => {
    const reg = loadAgentRegistry(workspace, undefined);
    for (const a of reg.listAgents()) {
      expect(a.builtin).toBe(true);
    }
  });

  test('default agent is ts-coder', () => {
    const reg = loadAgentRegistry(workspace, undefined);
    expect(reg.defaultAgent().id).toBe('ts-coder');
  });

  test('getAgent returns null for unknown id', () => {
    const reg = loadAgentRegistry(workspace, undefined);
    expect(reg.getAgent('nonexistent')).toBeNull();
    expect(reg.has('nonexistent')).toBe(false);
    expect(reg.has('ts-coder')).toBe(true);
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
    expect(reg.has('ts-coder')).toBe(true);
  });

  test('config agent with same id REPLACES built-in', () => {
    const reg = loadAgentRegistry(workspace, [
      { id: 'ts-coder', name: 'Custom TS Coder', description: 'Our team style' },
    ]);
    const agent = reg.getAgent('ts-coder');
    expect(agent!.name).toBe('Custom TS Coder');
    expect(agent!.description).toBe('Our team style');
    // Still 4 total (override, not addition)
    expect(reg.listAgents().length).toBe(4);
  });

  test('soul file on disk overrides built-in soul', () => {
    mkdirSync(join(workspace, '.vinyan', 'agents', 'ts-coder'), { recursive: true });
    writeFileSync(join(workspace, '.vinyan', 'agents', 'ts-coder', 'soul.md'), '# Custom TS philosophy\nI live for types.');

    const reg = loadAgentRegistry(workspace, undefined);
    const agent = reg.getAgent('ts-coder');
    expect(agent!.soul).toContain('Custom TS philosophy');
    expect(agent!.soul).toContain('I live for types');
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
});
