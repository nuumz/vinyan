/**
 * Provider detection — runs adapters' detect() in parallel and returns the
 * union. Detection is the only place that touches the local environment;
 * everything else gets capabilities from this snapshot.
 *
 * Detection is intentionally lazy + cached — re-running on every API call
 * would slow down /providers and re-fork child processes. The cache is
 * invalidated by `forceRefresh` for the rare case the operator installs a
 * binary mid-session.
 */
import type { CodingCliDetectionResult, CodingCliProviderAdapter, CodingCliProviderId } from '../types.ts';

export interface DetectionRecord {
  detection: CodingCliDetectionResult;
  detectedAt: number;
}

export class ProviderDetectionRegistry {
  private cache: Map<CodingCliProviderId, DetectionRecord> = new Map();
  /** Cache freshness window. Default 60 s. */
  private readonly maxAgeMs: number;

  constructor(maxAgeMs = 60_000) {
    this.maxAgeMs = maxAgeMs;
  }

  async detectAll(
    adapters: ReadonlyArray<CodingCliProviderAdapter>,
    options: { forceRefresh?: boolean } = {},
  ): Promise<CodingCliDetectionResult[]> {
    const now = Date.now();
    const tasks = adapters.map(async (adapter) => {
      const cached = this.cache.get(adapter.id);
      if (!options.forceRefresh && cached && now - cached.detectedAt < this.maxAgeMs) {
        return cached.detection;
      }
      const detection = await adapter.detect();
      this.cache.set(adapter.id, { detection, detectedAt: Date.now() });
      return detection;
    });
    return Promise.all(tasks);
  }

  get(id: CodingCliProviderId): CodingCliDetectionResult | undefined {
    return this.cache.get(id)?.detection;
  }

  invalidate(id?: CodingCliProviderId): void {
    if (id) this.cache.delete(id);
    else this.cache.clear();
  }
}

/**
 * Probe `bin --help` (or `bin --version`) without inheriting parent env.
 * Returns the captured stdout/stderr concatenated, or null on failure.
 *
 * Used by adapters during detect(). The probe is bounded by `timeoutMs`.
 */
export async function probeBinary(
  bin: string,
  args: string[],
  options: {
    timeoutMs?: number;
    /** Allow-listed env vars to forward; everything else is dropped. */
    allowEnv?: string[];
  } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null }> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const env: Record<string, string> = {};
  if (options.allowEnv) {
    for (const key of options.allowEnv) {
      const value = process.env[key];
      if (typeof value === 'string') env[key] = value;
    }
  }
  // PATH and HOME are needed for the binary to find its libraries.
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.HOME) env.HOME = process.env.HOME;
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  try {
    proc = Bun.spawn({
      cmd: [bin, ...args],
      cwd: process.cwd(),
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timer = setTimeout(() => {
      try { proc?.kill('SIGTERM'); } catch {}
    }, timeoutMs);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout as unknown as ReadableStream).text(),
      new Response(proc.stderr as unknown as ReadableStream).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    return { ok: exitCode === 0, stdout, stderr, exitCode };
  } catch (err) {
    return { ok: false, stdout: '', stderr: (err as Error).message, exitCode: null };
  }
}

/**
 * Locate a binary on PATH using `which`. Returns absolute path or null.
 */
export async function whichBinary(name: string): Promise<string | null> {
  const probe = await probeBinary('/usr/bin/env', ['which', name], { timeoutMs: 2_500 });
  if (!probe.ok) return null;
  const out = probe.stdout.trim().split('\n').filter(Boolean);
  if (out.length === 0) return null;
  // Take the first entry — `which` may report multiple if the user has
  // them on PATH; the first is what `exec` would pick.
  return out[0] ?? null;
}
