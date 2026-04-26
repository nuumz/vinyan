/**
 * Plugin bundle manifest loader tests — G12 unified manifest.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BundleManifestSchema, loadBundleManifests } from '../../src/plugin/bundle-manifest.ts';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'vinyan-bundle-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function writeBundle(dir: string, content: object) {
  mkdirSync(join(workspace, dir), { recursive: true });
  writeFileSync(join(workspace, dir, 'plugin.json'), JSON.stringify(content));
}

describe('loadBundleManifests', () => {
  test('returns empty when no bundle exists', () => {
    const result = loadBundleManifests(workspace);
    expect(result.bundles).toEqual([]);
    expect(result.mcpServers).toEqual([]);
  });

  test('parses .vinyan-plugin/plugin.json with mcpServers', () => {
    writeBundle('.vinyan-plugin', {
      name: 'demo',
      mcpServers: { foo: { command: 'foo-mcp', args: ['--quiet'] } },
    });
    const result = loadBundleManifests(workspace);
    expect(result.bundles).toHaveLength(1);
    expect(result.bundles[0]?.name).toBe('demo');
    expect(result.mcpServers).toHaveLength(1);
    const foo = result.mcpServers.find((s) => s.name === 'foo');
    expect(foo?.command).toBe('foo-mcp');
    expect(foo?.args).toEqual(['--quiet']);
    expect(foo?.source).toBe(join(workspace, '.vinyan-plugin', 'plugin.json'));
  });

  test('also parses .thclaws-plugin/plugin.json', () => {
    writeBundle('.thclaws-plugin', { mcpServers: { th: { command: 'thclaws-mcp' } } });
    const result = loadBundleManifests(workspace);
    expect(result.mcpServers.find((s) => s.name === 'th')?.command).toBe('thclaws-mcp');
  });

  test('thclaws bundle overrides vinyan bundle on name conflict (later wins)', () => {
    writeBundle('.vinyan-plugin', { mcpServers: { dup: { command: 'first' } } });
    writeBundle('.thclaws-plugin', { mcpServers: { dup: { command: 'second' } } });
    const result = loadBundleManifests(workspace);
    expect(result.mcpServers).toHaveLength(1);
    expect(result.mcpServers[0]?.command).toBe('second');
  });

  test('malformed JSON returns empty + records invalid path (does not throw)', () => {
    mkdirSync(join(workspace, '.vinyan-plugin'));
    writeFileSync(join(workspace, '.vinyan-plugin', 'plugin.json'), '{ broken');
    const result = loadBundleManifests(workspace);
    expect(result.bundles).toEqual([]);
    expect(result.invalidPaths).toContain(join(workspace, '.vinyan-plugin', 'plugin.json'));
  });

  test('valid JSON with wrong shape (missing command) returns empty + records invalid', () => {
    writeBundle('.vinyan-plugin', { mcpServers: { bad: {} } });
    const result = loadBundleManifests(workspace);
    expect(result.bundles).toEqual([]);
    expect(result.invalidPaths).toContain(join(workspace, '.vinyan-plugin', 'plugin.json'));
  });

  test('parses skills + agents fields as forward-compat metadata', () => {
    writeBundle('.vinyan-plugin', {
      mcpServers: {},
      skills: [{ id: 'github:acme/skills@main/foo' }, { path: './skills/bar' }],
      agents: [{ name: 'researcher', role: 'explore' }],
    });
    const result = loadBundleManifests(workspace);
    expect(result.bundles[0]?.skills).toHaveLength(2);
    expect(result.bundles[0]?.agents).toHaveLength(1);
    expect(result.bundles[0]?.agents?.[0]?.name).toBe('researcher');
  });

  test('skill ref must declare exactly one of path or id', () => {
    const bad = BundleManifestSchema.safeParse({
      skills: [{ path: './a', id: 'b' }],
    });
    expect(bad.success).toBe(false);
  });

  test('attemptedPaths reports files that exist', () => {
    writeBundle('.vinyan-plugin', { mcpServers: {} });
    writeBundle('.thclaws-plugin', { mcpServers: {} });
    const result = loadBundleManifests(workspace);
    expect(result.attemptedPaths).toEqual([
      join(workspace, '.vinyan-plugin', 'plugin.json'),
      join(workspace, '.thclaws-plugin', 'plugin.json'),
    ]);
  });

  test('tolerates unknown top-level fields (forward compat)', () => {
    writeBundle('.vinyan-plugin', {
      mcpServers: { ok: { command: 'ok' } },
      futureField: { whatever: true },
    });
    const result = loadBundleManifests(workspace);
    expect(result.bundles).toHaveLength(1);
    expect(result.mcpServers).toHaveLength(1);
  });
});
