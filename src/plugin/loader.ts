/**
 * InprocLoader — MVP plugin loader for the W2 Plugin Registry.
 *
 * WARNING — sandbox scope for this MVP:
 *   This loader imports plugin code INTO THE HOST PROCESS with a plain
 *   dynamic `await import()`. That is intentionally NOT a sandbox. The
 *   `manifest.agentContract` envelope is recorded but NOT enforced here;
 *   enforcement at tool-call sites + a Bun Worker isolate intersecting with
 *   the AgentContract ACL is a FOLLOW-UP PR and is explicitly out of scope
 *   for this change. Category-level interface constraints (e.g. a
 *   MemoryProvider must implement the MemoryProvider interface) are the
 *   only structural guardrails in place today.
 *
 * What this loader DOES do deterministically:
 *   1. Runs `verifyIntegrity` — SHA-256 over the entry file.
 *   2. Runs `verifySignature` (MVP stub — see `signature.ts`).
 *   3. Checks `manifest.vinyanApi` satisfies the runtime's `allowedVinyanApi`
 *      using a conservative in-file semver matcher (see `satisfiesApiRange`).
 *   4. Imports the entry module via dynamic `await import()`.
 *   5. Derives the effective tier via `effectiveTrustTier` (A5).
 *
 * Errors go through `PluginLoadError` so the registry can map them to a
 * `rejected` slot + an audit record.
 */
import path from 'node:path';
import type { ConfidenceTier } from '../core/confidence-tier.ts';
import {
  effectiveTrustTier,
  type SignatureResult,
  type TrustConfig,
  verifyIntegrity,
  verifySignature,
} from './signature.ts';
import { type DiscoveredPlugin, type LoadedPlugin, PluginLoadError } from './types.ts';

// ── Options ──────────────────────────────────────────────────────────────

export interface InprocLoaderOptions {
  /** Current Vinyan API version, e.g. `'0.9.0'`. Compared to `manifest.vinyanApi`. */
  allowedVinyanApi: string;
  /**
   * Optional bus — used for the A12 RFC stub. When wired, the loader
   * emits `module:hot_reload_candidate` events when a dynamic import
   * detects an mtime newer than the previously-loaded copy. Today the
   * event is informational; the supervisor handles actual reload.
   */
  bus?: import('../core/bus.ts').VinyanBus;
}

/** Result of a single load attempt. Successful loads carry integrity + signature. */
export interface LoadOutcome {
  loaded: LoadedPlugin;
  integritySha256: string;
  signature: SignatureResult;
}

// ── Loader ───────────────────────────────────────────────────────────────

export class InprocLoader {
  private readonly allowedVinyanApi: string;
  private readonly loaded = new Map<string, LoadedPlugin>();
  private readonly bus: import('../core/bus.ts').VinyanBus | undefined;
  /** mtime per loaded entry path — used by the A12 stub to detect reload candidates. */
  private readonly loadMtime = new Map<string, number>();

  constructor(opts: InprocLoaderOptions) {
    this.allowedVinyanApi = opts.allowedVinyanApi;
    this.bus = opts.bus;
  }

  get currentApiVersion(): string {
    return this.allowedVinyanApi;
  }

  async load(discovered: DiscoveredPlugin, trust: TrustConfig): Promise<LoadOutcome> {
    const { manifest, rootDir } = discovered;
    const pluginId = manifest.pluginId;

    // 1. Integrity
    const integrity = await verifyIntegrity(rootDir, manifest);
    if (!integrity.ok) {
      throw new PluginLoadError(pluginId, 'integrity', integrity.detail);
    }

    // 2. Signature (MVP stub — see signature.ts)
    const signature = await verifySignature(manifest, trust);

    // 3. API version
    if (!satisfiesApiRange(this.allowedVinyanApi, manifest.vinyanApi)) {
      throw new PluginLoadError(
        pluginId,
        'api-version',
        `vinyanApi '${manifest.vinyanApi}' does not satisfy runtime '${this.allowedVinyanApi}'`,
      );
    }

    // 4. Tier derivation — throws if signature state is not loadable.
    let tier: ConfidenceTier;
    try {
      tier = effectiveTrustTier(integrity, signature, trust.permissive);
    } catch (err) {
      throw new PluginLoadError(pluginId, 'signature', err instanceof Error ? err.message : String(err));
    }

    // 5. Dynamic import of the entry file.
    const entryPath = path.resolve(rootDir, manifest.entry);

    // A12 RFC stub (proposed, not yet load-bearing) — detect a hot-reload
    // candidate. If we've already loaded this path AND its mtime is newer
    // than the cached one, the runtime module cache is stale (Node/Bun
    // caches dynamic imports). Today we emit an informational event; the
    // supervisor (`vinyan serve --watch`) handles the actual restart.
    // Future hot-reload protocol attaches here.
    try {
      const stat = await import('node:fs').then((m) => m.statSync(entryPath));
      const previous = this.loadMtime.get(entryPath);
      if (previous !== undefined && stat.mtimeMs > previous) {
        this.bus?.emit('module:hot_reload_candidate', {
          moduleId: pluginId,
          detectedAt: Date.now(),
          reason: `mtime ${stat.mtimeMs} newer than load mtime ${previous}`,
        });
      }
      this.loadMtime.set(entryPath, stat.mtimeMs);
    } catch {
      /* mtime is best-effort — never blocks the load path */
    }

    let mod: Record<string, unknown>;
    try {
      mod = (await import(entryPath)) as Record<string, unknown>;
    } catch (err) {
      throw new PluginLoadError(pluginId, 'import', err instanceof Error ? err.message : String(err));
    }

    const handle = (mod as { default?: unknown }).default ?? mod;
    const loaded: LoadedPlugin = {
      manifest,
      handle,
      tier,
      loadedAt: Date.now(),
    };
    this.loaded.set(pluginId, loaded);
    return { loaded, integritySha256: integrity.computedSha256, signature };
  }

  async unload(pluginId: string): Promise<void> {
    // Dynamic imports are cached by the runtime; we have no portable way to
    // evict them here. The registry's own slot cleanup is what matters for
    // FSM correctness; module-cache eviction is a follow-up.
    this.loaded.delete(pluginId);
  }

  isLoaded(pluginId: string): boolean {
    return this.loaded.has(pluginId);
  }
}

// ── Semver-lite matcher ──────────────────────────────────────────────────

/**
 * Accepted range shapes (exhaustive for MVP):
 *   - `*`                 — any version
 *   - `X.Y.Z`             — exact match
 *   - `^X.Y.Z`            — same MAJOR, >= X.Y.Z (MAJOR=0 behaves like caret on MINOR)
 *   - `>=A.B[.C]` plus optional `<D.E[.F]` (space-separated)
 *
 * Rejects anything else conservatively (returns false) so an unknown syntax
 * cannot accidentally allow loading — A3: deterministic governance.
 */
export function satisfiesApiRange(current: string, range: string): boolean {
  const trimmed = range.trim();
  if (trimmed === '*') return true;

  const cur = parseSemver(current);
  if (!cur) return false;

  // Exact
  if (/^\d+\.\d+\.\d+$/.test(trimmed)) {
    const target = parseSemver(trimmed);
    return !!target && cmp(cur, target) === 0;
  }

  // Caret
  if (trimmed.startsWith('^')) {
    const target = parseSemver(trimmed.slice(1));
    if (!target) return false;
    if (target.major === 0) {
      // Standard caret rules: with major=0, bump of MINOR breaks.
      if (target.minor === 0) {
        return cur.major === 0 && cur.minor === 0 && cur.patch >= target.patch;
      }
      return cur.major === 0 && cur.minor === target.minor && cmp(cur, target) >= 0;
    }
    return cur.major === target.major && cmp(cur, target) >= 0;
  }

  // Range: `>=A.B[.C]` optionally followed by ` <D.E[.F]`
  const parts = trimmed.split(/\s+/);
  let gteBound: Semver | null = null;
  let ltBound: Semver | null = null;
  for (const p of parts) {
    if (p.startsWith('>=')) {
      const v = parseLooseSemver(p.slice(2));
      if (!v) return false;
      gteBound = v;
    } else if (p.startsWith('<')) {
      const v = parseLooseSemver(p.slice(1));
      if (!v) return false;
      ltBound = v;
    } else {
      return false;
    }
  }
  if (gteBound && cmp(cur, gteBound) < 0) return false;
  if (ltBound && cmp(cur, ltBound) >= 0) return false;
  return gteBound !== null || ltBound !== null;
}

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(s: string): Semver | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(s.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Accepts `A.B.C` OR `A.B` (patch defaults to 0) — used inside ranges. */
function parseLooseSemver(s: string): Semver | null {
  const trimmed = s.trim();
  const full = /^(\d+)\.(\d+)\.(\d+)$/.exec(trimmed);
  if (full) {
    return { major: Number(full[1]), minor: Number(full[2]), patch: Number(full[3]) };
  }
  const short = /^(\d+)\.(\d+)$/.exec(trimmed);
  if (short) {
    return { major: Number(short[1]), minor: Number(short[2]), patch: 0 };
  }
  return null;
}

function cmp(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}
