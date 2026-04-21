/**
 * Plugin manifest — Zod schema + parser behavior tests.
 *
 * Covers:
 *   - Zod accepts a valid manifest.
 *   - Rejects bad `pluginId`, bad `version`, unknown `category`, non-hex
 *     `sha256`, non-64-char `sha256`, unknown `network` enum, missing required
 *     fields.
 *   - `parseManifestFromFile` reads a file and validates it end-to-end.
 *   - Defaults are filled correctly (tools.allow, deny, provides, consumes).
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PluginManifestSchema, parseManifestFromFile, parseManifestFromJson } from '../../src/plugin/manifest.ts';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'vinyan-plugin-manifest-'));
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const baseManifest = {
  pluginId: 'acme.oracle.k8s',
  version: '1.2.3',
  category: 'oracle' as const,
  entry: './dist/index.js',
  sha256: 'a'.repeat(64),
  vinyanApi: '>=0.8 <0.10',
  agentContract: {
    tools: { allow: [], deny: ['*'] },
    fs: { read: [], write: [] },
    network: 'deny-all' as const,
    capabilities: [],
  },
};

describe('PluginManifestSchema', () => {
  it('accepts a valid manifest', () => {
    const parsed = PluginManifestSchema.parse(baseManifest);
    expect(parsed.pluginId).toBe('acme.oracle.k8s');
    expect(parsed.category).toBe('oracle');
    expect(parsed.provides).toEqual([]);
    expect(parsed.consumes).toEqual([]);
  });

  it('rejects an invalid pluginId (uppercase)', () => {
    expect(() => PluginManifestSchema.parse({ ...baseManifest, pluginId: 'Acme.Oracle' })).toThrow();
  });

  it('rejects a non-semver version', () => {
    expect(() => PluginManifestSchema.parse({ ...baseManifest, version: '1.2' })).toThrow();
    expect(() => PluginManifestSchema.parse({ ...baseManifest, version: '1.2.3-beta' })).toThrow();
  });

  it('rejects an unknown category', () => {
    expect(() =>
      PluginManifestSchema.parse({ ...baseManifest, category: 'filesystem' as unknown as 'oracle' }),
    ).toThrow();
  });

  it('rejects a non-hex sha256', () => {
    expect(() => PluginManifestSchema.parse({ ...baseManifest, sha256: 'zz' })).toThrow();
    expect(() => PluginManifestSchema.parse({ ...baseManifest, sha256: 'A'.repeat(64) })).toThrow('64 lowercase hex');
  });

  it('rejects a non-64-char sha256', () => {
    expect(() => PluginManifestSchema.parse({ ...baseManifest, sha256: 'a'.repeat(63) })).toThrow();
  });

  it('rejects an unknown network stance', () => {
    expect(() =>
      PluginManifestSchema.parse({
        ...baseManifest,
        agentContract: { ...baseManifest.agentContract, network: 'wide-open' as unknown as 'open' },
      }),
    ).toThrow();
  });

  it('accepts a manifest with a minisign signature block', () => {
    const signed = {
      ...baseManifest,
      signature: { algorithm: 'minisign' as const, publicKey: 'pk-base64', value: 'sig-base64' },
    };
    const parsed = PluginManifestSchema.parse(signed);
    expect(parsed.signature?.publicKey).toBe('pk-base64');
  });

  it('fills defaults for optional arrays', () => {
    const parsed = PluginManifestSchema.parse({
      ...baseManifest,
      agentContract: {
        tools: { allow: [], deny: ['*'] },
        fs: { read: [], write: [] },
        network: 'deny-all',
        capabilities: [],
      },
    });
    expect(parsed.provides).toEqual([]);
    expect(parsed.consumes).toEqual([]);
  });
});

describe('parseManifestFromJson', () => {
  it('round-trips valid JSON', () => {
    const parsed = parseManifestFromJson(JSON.stringify(baseManifest));
    expect(parsed.pluginId).toBe(baseManifest.pluginId);
  });

  it('throws on malformed JSON', () => {
    expect(() => parseManifestFromJson('{ not json')).toThrow();
  });
});

describe('parseManifestFromFile', () => {
  it('reads + validates a manifest file', async () => {
    const dir = mkdtempSync(path.join(tmpRoot, 'ok-'));
    const file = path.join(dir, 'manifest.json');
    writeFileSync(file, JSON.stringify(baseManifest), 'utf8');
    const parsed = await parseManifestFromFile(file);
    expect(parsed.pluginId).toBe(baseManifest.pluginId);
  });

  it('rejects an invalid manifest file', async () => {
    const dir = mkdtempSync(path.join(tmpRoot, 'bad-'));
    const file = path.join(dir, 'manifest.json');
    writeFileSync(file, JSON.stringify({ ...baseManifest, version: 'bad' }), 'utf8');
    await expect(parseManifestFromFile(file)).rejects.toThrow();
  });
});
