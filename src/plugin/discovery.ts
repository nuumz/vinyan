/**
 * Plugin discovery — 3 fixed sources, first-match-wins per pluginId (A3).
 *
 * Sources, in descending priority:
 *   1. `<cwd>/.vinyan/plugins/* /manifest.json`          (project-local)
 *   2. `<vinyanHome>/plugins/* /manifest.json`           (user-home)
 *   3. `<cwd>/package.json#vinyan.plugins[]` entries in  (npm-style)
 *      dependencies / devDependencies
 *
 * Determinism: the return order is the discovery order (project → user-home →
 * package-json). Duplicates by `pluginId` are discarded from lower-priority
 * sources and surfaced as warnings so ops can see shadowing.
 *
 * This module does NOT load or verify plugins — it only surfaces manifests.
 * Verification + loading happens in `loader.ts` + `registry.ts`.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseManifestFromFile } from './manifest.ts';
import type { DiscoveredPlugin } from './types.ts';

// ── Options ──────────────────────────────────────────────────────────────

export interface DiscoverOptions {
  /** Working directory for project-local discovery + package.json scan. Default: `process.cwd()`. */
  cwd?: string;
  /** Vinyan home. Default: `process.env.VINYAN_HOME ?? ~/.vinyan`. */
  vinyanHome?: string;
  /** Whether to scan `package.json#vinyan.plugins[]`. Default: `true`. */
  includePackageJson?: boolean;
  /**
   * Optional sink for duplicate + malformed-manifest warnings so the CLI /
   * observable-routing explainer can surface them. Default: discard.
   */
  onWarn?: (warning: DiscoveryWarning) => void;
}

export interface DiscoveryWarning {
  kind: 'duplicate' | 'invalid-manifest' | 'missing-path';
  pluginId?: string;
  source: 'project' | 'user-home' | 'package-json';
  path: string;
  detail: string;
}

// ── Public entry point ───────────────────────────────────────────────────

export async function discoverPlugins(opts: DiscoverOptions = {}): Promise<DiscoveredPlugin[]> {
  const cwd = opts.cwd ?? process.cwd();
  const vinyanHome = opts.vinyanHome ?? process.env.VINYAN_HOME ?? path.join(homedir(), '.vinyan');
  const includePackageJson = opts.includePackageJson ?? true;
  const warn = opts.onWarn ?? (() => {});

  const seen = new Map<string, DiscoveredPlugin>();
  const ordered: DiscoveredPlugin[] = [];

  // Priority 1: project-local
  for (const found of await scanDirectory(path.join(cwd, '.vinyan', 'plugins'), 'project', warn)) {
    if (!seen.has(found.manifest.pluginId)) {
      seen.set(found.manifest.pluginId, found);
      ordered.push(found);
    } else {
      warn({
        kind: 'duplicate',
        pluginId: found.manifest.pluginId,
        source: 'project',
        path: found.manifestPath,
        detail: `duplicate pluginId within project-local source; first wins`,
      });
    }
  }

  // Priority 2: user-home
  for (const found of await scanDirectory(path.join(vinyanHome, 'plugins'), 'user-home', warn)) {
    if (!seen.has(found.manifest.pluginId)) {
      seen.set(found.manifest.pluginId, found);
      ordered.push(found);
    } else {
      warn({
        kind: 'duplicate',
        pluginId: found.manifest.pluginId,
        source: 'user-home',
        path: found.manifestPath,
        detail: `shadowed by higher-priority source`,
      });
    }
  }

  // Priority 3: package.json#vinyan.plugins[]
  if (includePackageJson) {
    for (const found of await scanPackageJson(cwd, warn)) {
      if (!seen.has(found.manifest.pluginId)) {
        seen.set(found.manifest.pluginId, found);
        ordered.push(found);
      } else {
        warn({
          kind: 'duplicate',
          pluginId: found.manifest.pluginId,
          source: 'package-json',
          path: found.manifestPath,
          detail: `shadowed by higher-priority source`,
        });
      }
    }
  }

  return ordered;
}

// ── Directory scanner (sources 1 + 2) ────────────────────────────────────

async function scanDirectory(
  dir: string,
  source: 'project' | 'user-home',
  warn: (w: DiscoveryWarning) => void,
): Promise<DiscoveredPlugin[]> {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const found: DiscoveredPlugin[] = [];
  for (const entry of entries) {
    const rootDir = path.join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(rootDir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    const manifestPath = path.join(rootDir, 'manifest.json');
    if (!existsSync(manifestPath)) continue;

    const discovered = await readManifest(manifestPath, rootDir, source, warn);
    if (discovered) found.push(discovered);
  }
  return found;
}

// ── package.json scanner (source 3) ──────────────────────────────────────

async function scanPackageJson(cwd: string, warn: (w: DiscoveryWarning) => void): Promise<DiscoveredPlugin[]> {
  const pkgPath = path.join(cwd, 'package.json');
  if (!existsSync(pkgPath)) return [];

  let pkg: unknown;
  try {
    pkg = JSON.parse(await Bun.file(pkgPath).text());
  } catch (err) {
    warn({
      kind: 'invalid-manifest',
      source: 'package-json',
      path: pkgPath,
      detail: `failed to parse package.json: ${err instanceof Error ? err.message : String(err)}`,
    });
    return [];
  }

  const entries = readVinyanPluginsField(pkg);
  if (entries.length === 0) return [];

  // Resolve each entry to a manifest path. An entry is a package name (e.g.
  // "acme-oracle") that must appear in dependencies/devDependencies; we
  // resolve it under `<cwd>/node_modules/<name>/manifest.json`.
  const deps = collectDeps(pkg);
  const found: DiscoveredPlugin[] = [];

  for (const entry of entries) {
    if (!deps.has(entry)) {
      warn({
        kind: 'missing-path',
        source: 'package-json',
        path: pkgPath,
        detail: `vinyan.plugins entry '${entry}' not found in dependencies/devDependencies`,
      });
      continue;
    }
    const rootDir = path.join(cwd, 'node_modules', entry);
    const manifestPath = path.join(rootDir, 'manifest.json');
    if (!existsSync(manifestPath)) {
      warn({
        kind: 'missing-path',
        source: 'package-json',
        path: manifestPath,
        detail: `manifest.json not present under node_modules/${entry}`,
      });
      continue;
    }
    const discovered = await readManifest(manifestPath, rootDir, 'package-json', warn);
    if (discovered) found.push(discovered);
  }
  return found;
}

function readVinyanPluginsField(pkg: unknown): string[] {
  if (!pkg || typeof pkg !== 'object') return [];
  const vinyan = (pkg as Record<string, unknown>).vinyan;
  if (!vinyan || typeof vinyan !== 'object') return [];
  const plugins = (vinyan as Record<string, unknown>).plugins;
  if (!Array.isArray(plugins)) return [];
  return plugins.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

function collectDeps(pkg: unknown): Set<string> {
  const result = new Set<string>();
  if (!pkg || typeof pkg !== 'object') return result;
  const p = pkg as Record<string, unknown>;
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    const block = p[key];
    if (block && typeof block === 'object') {
      for (const name of Object.keys(block)) result.add(name);
    }
  }
  return result;
}

// ── Shared helper ────────────────────────────────────────────────────────

async function readManifest(
  manifestPath: string,
  rootDir: string,
  source: DiscoveredPlugin['source'],
  warn: (w: DiscoveryWarning) => void,
): Promise<DiscoveredPlugin | null> {
  try {
    const manifest = await parseManifestFromFile(manifestPath);
    return { manifest, source, manifestPath, rootDir };
  } catch (err) {
    warn({
      kind: 'invalid-manifest',
      source,
      path: manifestPath,
      detail: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
