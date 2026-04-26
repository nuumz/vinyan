/**
 * Plugin signature + integrity — behavior tests.
 *
 * Covers:
 *   - SHA-256 integrity pass / `missing` / `mismatch` paths.
 *   - Signature stub: matching publicKey → ok; mismatch → untrusted-publisher;
 *     no signature → unsigned.
 *   - `effectiveTrustTier`:
 *       - integrity ok + signature ok → `deterministic`
 *       - integrity ok + unsigned + permissive → `speculative`
 *       - integrity ok + unsigned + strict → throws
 *       - integrity fail → throws
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PluginManifestSchema } from '../../src/plugin/manifest.ts';
import { effectiveTrustTier, type TrustConfig, verifyIntegrity, verifySignature } from '../../src/plugin/signature.ts';

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const view = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < view.length; i++) hex += (view[i] as number).toString(16).padStart(2, '0');
  return hex;
}

async function setupPlugin(content = 'console.log("plugin ok");\n'): Promise<{
  rootDir: string;
  manifest: ReturnType<typeof PluginManifestSchema.parse>;
  sha: string;
  cleanup: () => void;
}> {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'vinyan-sig-'));
  const entryPath = path.join(rootDir, 'index.js');
  writeFileSync(entryPath, content, 'utf8');
  const bytes = new TextEncoder().encode(content);
  const sha = await sha256Hex(bytes);
  const manifest = PluginManifestSchema.parse({
    pluginId: 'acme.sig',
    version: '1.0.0',
    category: 'oracle',
    entry: './index.js',
    sha256: sha,
    vinyanApi: '*',
    agentContract: {
      tools: { allow: [], deny: ['*'] },
      fs: { read: [], write: [] },
      network: 'deny-all',
      capabilities: [],
    },
  });
  return { rootDir, manifest, sha, cleanup: () => rmSync(rootDir, { recursive: true, force: true }) };
}

describe('verifyIntegrity', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  it('ok path: computes correct sha256', async () => {
    const { rootDir, manifest, sha, cleanup } = await setupPlugin();
    cleanups.push(cleanup);
    const r = await verifyIntegrity(rootDir, manifest);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.computedSha256).toBe(sha);
  });

  it('returns mismatch when sha differs', async () => {
    const { rootDir, manifest, cleanup } = await setupPlugin();
    cleanups.push(cleanup);
    const tampered = { ...manifest, sha256: 'b'.repeat(64) };
    const r = await verifyIntegrity(rootDir, tampered);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('mismatch');
  });

  it('returns missing when entry file absent', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'vinyan-sig-missing-'));
    cleanups.push(() => rmSync(rootDir, { recursive: true, force: true }));
    mkdirSync(rootDir, { recursive: true });
    const manifest = PluginManifestSchema.parse({
      pluginId: 'acme.sig.missing',
      version: '1.0.0',
      category: 'oracle',
      entry: './nope.js',
      sha256: 'a'.repeat(64),
      vinyanApi: '*',
      agentContract: {
        tools: { allow: [], deny: ['*'] },
        fs: { read: [], write: [] },
        network: 'deny-all',
        capabilities: [],
      },
    });
    const r = await verifyIntegrity(rootDir, manifest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing');
  });
});

describe('verifySignature (MVP stub)', () => {
  it('matching publicKey → ok', async () => {
    const { manifest, cleanup } = await setupPlugin();
    const signed = {
      ...manifest,
      signature: { algorithm: 'minisign' as const, publicKey: 'pk-trusted', value: 'ignored' },
    };
    const trust: TrustConfig = {
      publishers: [{ id: 'acme', publicKey: 'pk-trusted', algorithm: 'minisign' }],
      permissive: false,
    };
    const r = await verifySignature(signed, trust);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.publisher.id).toBe('acme');
    cleanup();
  });

  it('unknown publicKey → untrusted-publisher', async () => {
    const { manifest, cleanup } = await setupPlugin();
    const signed = {
      ...manifest,
      signature: { algorithm: 'minisign' as const, publicKey: 'pk-unknown', value: 'ignored' },
    };
    const trust: TrustConfig = {
      publishers: [{ id: 'acme', publicKey: 'pk-trusted', algorithm: 'minisign' }],
      permissive: false,
    };
    const r = await verifySignature(signed, trust);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('untrusted-publisher');
    cleanup();
  });

  it('no signature block → unsigned', async () => {
    const { manifest, cleanup } = await setupPlugin();
    const r = await verifySignature(manifest, {
      publishers: [],
      permissive: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unsigned');
    cleanup();
  });
});

describe('effectiveTrustTier', () => {
  it('signed + trusted → deterministic', () => {
    const tier = effectiveTrustTier(
      { ok: true, computedSha256: 'a'.repeat(64) },
      { ok: true, publisher: { id: 'acme', publicKey: 'pk', algorithm: 'minisign' } },
      false,
    );
    expect(tier).toBe('deterministic');
  });

  it('unsigned + permissive → speculative', () => {
    const tier = effectiveTrustTier(
      { ok: true, computedSha256: 'a'.repeat(64) },
      { ok: false, reason: 'unsigned' },
      true,
    );
    expect(tier).toBe('speculative');
  });

  it('unsigned + strict → throws', () => {
    expect(() =>
      effectiveTrustTier({ ok: true, computedSha256: 'a'.repeat(64) }, { ok: false, reason: 'unsigned' }, false),
    ).toThrow();
  });

  it('signed-but-untrusted → throws regardless of permissive', () => {
    expect(() =>
      effectiveTrustTier(
        { ok: true, computedSha256: 'a'.repeat(64) },
        { ok: false, reason: 'untrusted-publisher' },
        true,
      ),
    ).toThrow();
  });

  it('integrity failed → throws', () => {
    expect(() =>
      effectiveTrustTier(
        { ok: false, reason: 'mismatch', detail: 'bad hash' },
        { ok: false, reason: 'unsigned' },
        true,
      ),
    ).toThrow();
  });
});
