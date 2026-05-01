/**
 * PluginRegistry — FSM + cardinality + audit integration.
 *
 * Covers:
 *   - Ingest 3 plugins (1 memory, 2 oracle) against a real sqlite DB +
 *     plugin_audit migration. All land in `loaded`.
 *   - Activate a memory plugin → `activeIn('memory').length === 1`.
 *   - Activate a 2nd memory plugin → previous deactivates (single-cardinality).
 *   - Activate both oracles → both remain active (multi-cardinality).
 *   - Reject path: tamper with sha256, re-ingest → slot goes `rejected`;
 *     `activate()` throws `PluginActivationError`.
 *   - Every transition writes an audit row.
 *   - `fallbackChain('memory')` yields active-first, then other loaded.
 */

import { Database } from 'bun:sqlite';
import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MigrationRunner } from '../../src/db/migrations/migration-runner.ts';
import { PluginAuditStore } from '../../src/db/plugin-audit-store.ts';
import {
  type DiscoveredPlugin,
  InprocLoader,
  PluginActivationError,
  PluginRegistry,
  type TrustConfig,
} from '../../src/plugin/index.ts';
import { PluginManifestSchema } from '../../src/plugin/manifest.ts';

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const view = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < view.length; i++) hex += (view[i] as number).toString(16).padStart(2, '0');
  return hex;
}

async function makePluginOnDisk(params: {
  rootDir: string;
  pluginId: string;
  category: 'memory' | 'oracle' | 'context' | 'backend' | 'messaging-adapter' | 'skill-registry';
  version?: string;
  entryContent?: string;
  tamperSha?: boolean;
}): Promise<DiscoveredPlugin> {
  const entryContent = params.entryContent ?? `export default { id: '${params.pluginId}' };\n`;
  mkdirSync(params.rootDir, { recursive: true });
  const entryPath = path.join(params.rootDir, 'index.js');
  writeFileSync(entryPath, entryContent, 'utf8');
  const bytes = new TextEncoder().encode(entryContent);
  const realSha = await sha256Hex(bytes);
  const sha = params.tamperSha ? 'b'.repeat(64) : realSha;
  const manifest = PluginManifestSchema.parse({
    pluginId: params.pluginId,
    version: params.version ?? '1.0.0',
    category: params.category,
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
  const manifestPath = path.join(params.rootDir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
  return { manifest, source: 'project', manifestPath, rootDir: params.rootDir };
}

function makeRegistry(): { registry: PluginRegistry; db: Database; audit: PluginAuditStore } {
  const db = new Database(':memory:');
  new MigrationRunner().migrate(db, [migration001]);
  const audit = new PluginAuditStore(db);
  const loader = new InprocLoader({ allowedVinyanApi: '0.9.0' });
  const trust: TrustConfig = { publishers: [], permissive: true };
  const registry = new PluginRegistry({ loader, trust, auditStore: audit, profile: 'default' });
  return { registry, db, audit };
}

describe('PluginRegistry', () => {
  const tmpDirs: string[] = [];
  const mk = (prefix: string) => {
    const d = mkdtempSync(path.join(tmpdir(), `vinyan-registry-${prefix}-`));
    tmpDirs.push(d);
    return d;
  };
  afterEach(() => {
    while (tmpDirs.length) {
      const d = tmpDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it('ingest brings plugins to `loaded` state without activating', async () => {
    const { registry } = makeRegistry();
    const memDir = mk('mem');
    const ora1 = mk('ora1');
    const ora2 = mk('ora2');

    const discovered = await Promise.all([
      makePluginOnDisk({ rootDir: memDir, pluginId: 'mem.primary', category: 'memory' }),
      makePluginOnDisk({ rootDir: ora1, pluginId: 'ora.one', category: 'oracle' }),
      makePluginOnDisk({ rootDir: ora2, pluginId: 'ora.two', category: 'oracle' }),
    ]);
    await registry.ingest(discovered);

    const slots = registry.list();
    expect(slots).toHaveLength(3);
    for (const s of slots) expect(s.state).toBe('loaded');
    expect(registry.activeIn('memory')).toHaveLength(0);
    expect(registry.activeIn('oracle')).toHaveLength(0);
  });

  it('single-category: activating a 2nd memory deactivates the first', async () => {
    const { registry } = makeRegistry();
    const dirA = mk('memA');
    const dirB = mk('memB');
    const dA = await makePluginOnDisk({ rootDir: dirA, pluginId: 'mem.a', category: 'memory' });
    const dB = await makePluginOnDisk({ rootDir: dirB, pluginId: 'mem.b', category: 'memory' });
    await registry.ingest([dA, dB]);

    await registry.activate('mem.a');
    expect(registry.activeIn('memory').map((s) => s.manifest.pluginId)).toEqual(['mem.a']);

    await registry.activate('mem.b');
    const active = registry.activeIn('memory');
    expect(active).toHaveLength(1);
    expect(active[0]?.manifest.pluginId).toBe('mem.b');

    // Deactivated slot still exists.
    const slotA = registry.get('mem.a');
    expect(slotA?.state).toBe('deactivated');
  });

  it('multi-category: activating both oracles keeps both active', async () => {
    const { registry } = makeRegistry();
    const dir1 = mk('o1');
    const dir2 = mk('o2');
    const d1 = await makePluginOnDisk({ rootDir: dir1, pluginId: 'ora.one', category: 'oracle' });
    const d2 = await makePluginOnDisk({ rootDir: dir2, pluginId: 'ora.two', category: 'oracle' });
    await registry.ingest([d1, d2]);

    await registry.activate('ora.one');
    await registry.activate('ora.two');
    const active = registry.activeIn('oracle');
    expect(active).toHaveLength(2);
    expect(active.map((s) => s.manifest.pluginId).sort()).toEqual(['ora.one', 'ora.two']);
  });

  it('tampered sha256 → slot goes to `rejected`; activate throws', async () => {
    const { registry } = makeRegistry();
    const dir = mk('bad');
    const d = await makePluginOnDisk({
      rootDir: dir,
      pluginId: 'bad.plugin',
      category: 'oracle',
      tamperSha: true,
    });
    await registry.ingest([d]);
    const slot = registry.get('bad.plugin');
    expect(slot?.state).toBe('rejected');
    expect(slot?.rejection?.reason).toBe('integrity');

    await expect(registry.activate('bad.plugin')).rejects.toBeInstanceOf(PluginActivationError);
  });

  it('audit store records transitions', async () => {
    const { registry, audit } = makeRegistry();
    const dir = mk('aud');
    const d = await makePluginOnDisk({ rootDir: dir, pluginId: 'aud.one', category: 'oracle' });
    await registry.ingest([d]);
    await registry.activate('aud.one');
    await registry.deactivate('aud.one');

    const history = audit.history('aud.one', { profile: 'default' });
    const events = history.map((r) => r.event);
    expect(events).toContain('discovered');
    expect(events).toContain('integrity_ok');
    expect(events).toContain('loaded');
    expect(events).toContain('activated');
    expect(events).toContain('deactivated');

    const latest = audit.latest('aud.one', { profile: 'default' });
    expect(latest?.event).toBe('deactivated');
    expect(latest?.profile).toBe('default');
  });

  it('fallbackChain places active memory first, loaded backups after', async () => {
    const { registry } = makeRegistry();
    const dirA = mk('mA');
    const dirB = mk('mB');
    const dirC = mk('mC');
    await registry.ingest([
      await makePluginOnDisk({ rootDir: dirA, pluginId: 'mem.a', category: 'memory' }),
      await makePluginOnDisk({ rootDir: dirB, pluginId: 'mem.b', category: 'memory' }),
      await makePluginOnDisk({ rootDir: dirC, pluginId: 'mem.c', category: 'memory' }),
    ]);
    await registry.activate('mem.b');
    const chain = registry.fallbackChain('memory');
    expect(chain.map((s) => s.manifest.pluginId)).toEqual(['mem.b', 'mem.a', 'mem.c']);
  });

  it('activating an unknown pluginId throws', async () => {
    const { registry } = makeRegistry();
    await expect(registry.activate('nope')).rejects.toBeInstanceOf(PluginActivationError);
  });

  it('API-version mismatch rejects the plugin', async () => {
    const db = new Database(':memory:');
    new MigrationRunner().migrate(db, [migration001]);
    const audit = new PluginAuditStore(db);
    const loader = new InprocLoader({ allowedVinyanApi: '0.9.0' });
    const trust: TrustConfig = { publishers: [], permissive: true };
    const registry = new PluginRegistry({ loader, trust, auditStore: audit, profile: 'default' });

    // Manifest demands >=2.0 which does NOT satisfy 0.9.0
    const dir = mkdtempSync(path.join(tmpdir(), 'vinyan-registry-apiv-'));
    const entryContent = 'export default { ok: true };\n';
    writeFileSync(path.join(dir, 'index.js'), entryContent, 'utf8');
    const bytes = new TextEncoder().encode(entryContent);
    const sha = await sha256Hex(bytes);
    const manifest = PluginManifestSchema.parse({
      pluginId: 'too.new',
      version: '1.0.0',
      category: 'oracle',
      entry: './index.js',
      sha256: sha,
      vinyanApi: '>=2.0',
      agentContract: {
        tools: { allow: [], deny: ['*'] },
        fs: { read: [], write: [] },
        network: 'deny-all',
        capabilities: [],
      },
    });
    const discovered: DiscoveredPlugin = {
      manifest,
      source: 'project',
      manifestPath: path.join(dir, 'manifest.json'),
      rootDir: dir,
    };
    await registry.ingest([discovered]);
    rmSync(dir, { recursive: true, force: true });

    const slot = registry.get('too.new');
    expect(slot?.state).toBe('rejected');
    expect(slot?.rejection?.reason).toBe('api-version');
  });
});
