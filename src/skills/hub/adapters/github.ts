/**
 * GitHub registry adapter — reads SKILL.md from a GitHub repo path.
 *
 * Id formats accepted:
 *   - `github:<owner>/<repo>@<ref>/<path/to/skill>`
 *   - `github:<owner>/<repo>/<path/to/skill>`           (defaults to `ref=HEAD`)
 *   - `github:<owner>/<repo>@<ref>`                     (path defaults to root)
 *   - `github:<owner>/<repo>`                           (root + HEAD)
 *
 * The `<path>` must point to the directory that contains `SKILL.md`. If the
 * skill declares a `## Files` whitelist the adapter attempts to fetch each
 * one. A companion file that cannot be fetched is silently omitted — the
 * importer's Oracle Gate will catch any missing-whitelist contradiction.
 *
 * Test injection: every call goes through an optional `fetchImpl` so the
 * test harness can stub GitHub responses. Production uses the global
 * `fetch`.
 *
 * Rate-limit handling (MVP): honors `ETag` when a prior response has been
 * recorded for the same URL during this process's lifetime. No cross-process
 * cache, no disk persistence — keeping the adapter dependency-free. A full
 * rate-limit strategy is a follow-up.
 */
import { parseSkillMd } from '../../skill-md/index.ts';
import {
  type FetchImpl,
  type SkillFetchResult,
  SkillNotFoundError,
  SkillRegistryError,
  type SkillListingL0,
  type SkillRegistryAdapter,
} from '../registry-adapter.ts';

export interface GitHubAdapterOptions {
  readonly fetchImpl?: FetchImpl;
  readonly token?: string;
  /** Override for enterprise installations. Defaults to the public API. */
  readonly apiBase?: string;
  /** Override for raw-content host. Defaults to the public raw CDN. */
  readonly rawBase?: string;
}

interface ParsedId {
  readonly owner: string;
  readonly repo: string;
  readonly ref: string;
  readonly path: string;
}

/** Parse `github:owner/repo[@ref][/path]`. Throws on malformed input. */
export function parseGithubSkillId(id: string): ParsedId {
  if (!id.startsWith('github:')) {
    throw new SkillRegistryError(`GitHub adapter cannot parse id '${id}' (missing 'github:' prefix)`, 'github');
  }
  const rest = id.slice('github:'.length);
  if (rest.length === 0) {
    throw new SkillRegistryError(`GitHub id '${id}' is empty after prefix`, 'github');
  }

  // Split optional ref at `@`.
  const atIdx = rest.indexOf('@');
  let coords: string;
  let refAndPath: string | null;
  if (atIdx >= 0) {
    coords = rest.slice(0, atIdx);
    refAndPath = rest.slice(atIdx + 1);
  } else {
    coords = rest;
    refAndPath = null;
  }

  const coordParts = coords.split('/');
  if (coordParts.length < 2 || !coordParts[0] || !coordParts[1]) {
    throw new SkillRegistryError(`GitHub id '${id}' is missing owner/repo`, 'github');
  }
  const owner = coordParts[0];
  const repo = coordParts[1];

  let ref = 'HEAD';
  let pathSegments: string[] = coordParts.slice(2);

  if (refAndPath !== null) {
    // With `@ref`: refAndPath looks like `<ref>[/<path>]`
    const slashIdx = refAndPath.indexOf('/');
    if (slashIdx === -1) {
      ref = refAndPath;
    } else {
      ref = refAndPath.slice(0, slashIdx);
      pathSegments = refAndPath
        .slice(slashIdx + 1)
        .split('/')
        .filter(Boolean);
    }
  }

  if (!ref) {
    throw new SkillRegistryError(`GitHub id '${id}' has an empty ref`, 'github');
  }

  const path = pathSegments.filter(Boolean).join('/');
  return { owner, repo, ref, path };
}

interface CachedResponse {
  readonly etag: string;
  readonly body: string;
}

export class GitHubAdapter implements SkillRegistryAdapter {
  readonly name = 'github' as const;

  private readonly fetchImpl: FetchImpl;
  private readonly token: string | undefined;
  private readonly apiBase: string;
  private readonly rawBase: string;
  private readonly etagCache = new Map<string, CachedResponse>();

  constructor(opts: GitHubAdapterOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? defaultFetchImpl;
    this.token = opts.token;
    this.apiBase = opts.apiBase ?? 'https://api.github.com';
    this.rawBase = opts.rawBase ?? 'https://raw.githubusercontent.com';
  }

  /**
   * MVP `list`: searches GitHub code for SKILL.md files matching `query`.
   * Returns a minimal listing derived from the search response; full
   * trust-relevant fields must come from a subsequent `fetch()`.
   */
  async list(query: string, opts?: { limit?: number }): Promise<readonly SkillListingL0[]> {
    const limit = Math.max(1, Math.min(opts?.limit ?? 10, 50));
    const q = encodeURIComponent(`${query} filename:SKILL.md`);
    const url = `${this.apiBase}/search/code?q=${q}&per_page=${limit}`;
    const res = await this.requestJson(url);
    const raw = res as { items?: Array<{ path: string; repository?: { full_name: string } }> };
    const items = raw.items ?? [];
    const listings: SkillListingL0[] = [];
    for (const item of items) {
      if (!item.repository?.full_name) continue;
      const dir = item.path.replace(/\/SKILL\.md$/, '');
      const id = `github:${item.repository.full_name}/${dir}`;
      listings.push({
        id,
        name: dir.split('/').pop() ?? dir,
        version: '0.0.0',
        description: `GitHub hit: ${item.repository.full_name}/${item.path}`,
        confidenceTier: 'speculative',
      });
    }
    return listings;
  }

  async fetch(id: string): Promise<SkillFetchResult> {
    const parsed = parseGithubSkillId(id);
    const skillMdUrl = this.buildRawUrl(parsed, 'SKILL.md');
    const skillMd = await this.requestText(skillMdUrl);
    if (skillMd === null) {
      throw new SkillNotFoundError('github', id);
    }

    // Parse just enough to find the `## Files` whitelist; the importer will
    // re-parse to keep the adapter stateless.
    let filesWhitelist: readonly string[] = [];
    try {
      const record = parseSkillMd(skillMd);
      filesWhitelist = record.body.files ?? [];
    } catch (err) {
      throw new SkillRegistryError(
        `GitHub adapter failed to parse SKILL.md for '${id}': ${err instanceof Error ? err.message : String(err)}`,
        'github',
        err,
      );
    }

    const files = new Map<string, string>();
    for (const relPath of filesWhitelist) {
      const fileUrl = this.buildRawUrl(parsed, relPath);
      const content = await this.requestText(fileUrl);
      if (content !== null) {
        files.set(relPath, content);
      }
    }

    return { skillMd, files };
  }

  private buildRawUrl(parsed: ParsedId, relativePath: string): string {
    const prefix = parsed.path ? `${parsed.path}/` : '';
    return `${this.rawBase}/${parsed.owner}/${parsed.repo}/${parsed.ref}/${prefix}${relativePath}`;
  }

  private async requestText(url: string): Promise<string | null> {
    const headers: Record<string, string> = {
      Accept: 'text/plain, application/vnd.github.raw',
      'User-Agent': 'vinyan-skills-hub',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const cached = this.etagCache.get(url);
    if (cached) headers['If-None-Match'] = cached.etag;

    const response = await this.fetchImpl(url, { headers }).catch((err: unknown) => {
      throw new SkillRegistryError(
        `GitHub fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
        'github',
        err,
      );
    });

    if (response.status === 404) {
      return null;
    }

    if (response.status === 304 && cached) {
      return cached.body;
    }

    if (!response.ok) {
      throw new SkillRegistryError(`GitHub fetch failed for ${url}: HTTP ${response.status}`, 'github');
    }

    const body = await response.text();
    const etag = response.headers.get('ETag');
    if (etag) {
      this.etagCache.set(url, { etag, body });
    }
    return body;
  }

  private async requestJson(url: string): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'vinyan-skills-hub',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    const response = await this.fetchImpl(url, { headers }).catch((err: unknown) => {
      throw new SkillRegistryError(
        `GitHub fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
        'github',
        err,
      );
    });

    if (!response.ok) {
      throw new SkillRegistryError(`GitHub fetch failed for ${url}: HTTP ${response.status}`, 'github');
    }
    return response.json();
  }
}

const defaultFetchImpl: FetchImpl = async (input, init) => {
  // Cast to global fetch. Keep the shape narrow so tests can substitute.
  const res = await (globalThis.fetch as (...args: unknown[]) => Promise<Response>)(input, init);
  return {
    ok: res.ok,
    status: res.status,
    headers: res.headers,
    text: () => res.text(),
    json: () => res.json(),
  };
};
