/**
 * Plugin discovery — 3-source priority + duplicate shadowing.
 *
 * Uses real temp directories on disk since discovery.ts reads from fs
 * synchronously + through Bun.file. No mocking of fs — CLAUDE.md prefers
 * integration tests when feasible.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type DiscoveryWarning, discoverPlugins } from '../../src/plugin/discovery.ts';

function makeManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pluginId: 'acme.test',
    version: '0.1.0',
    category: 'oracle',
    entry: './index.js',
    sha256: 'a'.repeat(64),
    vinyanApi: '*',
    agentContract: {
      tools: { allow: [], deny: ['*'] },
      fs: { read: [], write: [] },
      network: 'deny-all',
      capabilities: [],
    },
    ...overrides,
  };
}

function writeManifest(rootDir: string, manifest: Record<string, unknown>): string {
  mkdirSync(rootDir, { recursive: true });
  const manifestPath = path.join(rootDir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
  return manifestPath;
}

describe('discoverPlugins', () => {
  const tmpDirs: string[] = [];
  const mk = (prefix: string) => {
    const d = mkdtempSync(path.join(tmpdir(), `vinyan-discovery-${prefix}-`));
    tmpDirs.push(d);
    return d;
  };

  afterEach(() => {
    while (tmpDirs.length) {
      const d = tmpDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it('returns empty when no sources present', async () => {
    const cwd = mk('cwd');
    const home = mk('home');
    const result = await discoverPlugins({ cwd, vinyanHome: home, includePackageJson: false });
    expect(result).toHaveLength(0);
  });

  it('surfaces a project-local plugin', async () => {
    const cwd = mk('cwd');
    const home = mk('home');
    writeManifest(path.join(cwd, '.vinyan', 'plugins', 'p1'), makeManifest({ pluginId: 'proj.one' }));
    const result = await discoverPlugins({ cwd, vinyanHome: home, includePackageJson: false });
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe('project');
    expect(result[0]?.manifest.pluginId).toBe('proj.one');
  });

  it('project wins over user-home for duplicate pluginId', async () => {
    const cwd = mk('cwd');
    const home = mk('home');
    writeManifest(
      path.join(cwd, '.vinyan', 'plugins', 'dup'),
      makeManifest({ pluginId: 'dup.plugin', version: '1.0.0' }),
    );
    writeManifest(path.join(home, 'plugins', 'dup'), makeManifest({ pluginId: 'dup.plugin', version: '2.0.0' }));
    const warnings: DiscoveryWarning[] = [];
    const result = await discoverPlugins({
      cwd,
      vinyanHome: home,
      includePackageJson: false,
      onWarn: (w) => warnings.push(w),
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe('project');
    expect(result[0]?.manifest.version).toBe('1.0.0');
    // User-home duplicate must be surfaced as a warning.
    expect(warnings.some((w) => w.kind === 'duplicate' && w.source === 'user-home')).toBe(true);
  });

  it('user-home source works when project absent', async () => {
    const cwd = mk('cwd');
    const home = mk('home');
    writeManifest(path.join(home, 'plugins', 'h1'), makeManifest({ pluginId: 'home.one' }));
    const result = await discoverPlugins({ cwd, vinyanHome: home, includePackageJson: false });
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe('user-home');
  });

  it('package.json source resolves deps', async () => {
    const cwd = mk('cwd');
    const home = mk('home');
    // Set up node_modules/acme-oracle/manifest.json
    writeManifest(path.join(cwd, 'node_modules', 'acme-oracle'), makeManifest({ pluginId: 'pkg.one' }));
    writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({
        name: 'test-host',
        dependencies: { 'acme-oracle': '1.0.0' },
        vinyan: { plugins: ['acme-oracle'] },
      }),
      'utf8',
    );
    const result = await discoverPlugins({ cwd, vinyanHome: home });
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe('package-json');
    expect(result[0]?.manifest.pluginId).toBe('pkg.one');
  });

  it('includePackageJson:false skips source 3', async () => {
    const cwd = mk('cwd');
    const home = mk('home');
    writeManifest(path.join(cwd, 'node_modules', 'acme-oracle'), makeManifest({ pluginId: 'pkg.skipped' }));
    writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({
        name: 'test-host',
        dependencies: { 'acme-oracle': '1.0.0' },
        vinyan: { plugins: ['acme-oracle'] },
      }),
      'utf8',
    );
    const result = await discoverPlugins({ cwd, vinyanHome: home, includePackageJson: false });
    expect(result).toHaveLength(0);
  });

  it('warns when package.json references a missing dep', async () => {
    const cwd = mk('cwd');
    const home = mk('home');
    writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({
        name: 'test-host',
        dependencies: {},
        vinyan: { plugins: ['not-installed'] },
      }),
      'utf8',
    );
    const warnings: DiscoveryWarning[] = [];
    const result = await discoverPlugins({
      cwd,
      vinyanHome: home,
      onWarn: (w) => warnings.push(w),
    });
    expect(result).toHaveLength(0);
    expect(warnings.some((w) => w.kind === 'missing-path')).toBe(true);
  });

  it('warns on invalid manifest but keeps discovering others', async () => {
    const cwd = mk('cwd');
    const home = mk('home');
    // Invalid manifest
    mkdirSync(path.join(cwd, '.vinyan', 'plugins', 'bad'), { recursive: true });
    writeFileSync(
      path.join(cwd, '.vinyan', 'plugins', 'bad', 'manifest.json'),
      JSON.stringify({ pluginId: 'BAD' }),
      'utf8',
    );
    // Valid manifest
    writeManifest(path.join(cwd, '.vinyan', 'plugins', 'good'), makeManifest({ pluginId: 'good.one' }));
    const warnings: DiscoveryWarning[] = [];
    const result = await discoverPlugins({
      cwd,
      vinyanHome: home,
      includePackageJson: false,
      onWarn: (w) => warnings.push(w),
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.manifest.pluginId).toBe('good.one');
    expect(warnings.some((w) => w.kind === 'invalid-manifest')).toBe(true);
  });
});
